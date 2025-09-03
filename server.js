// server.js
// Shopify CarrierService callback -> ShipStation API v1 live rates
// Endpoint: POST /rates  (expects Shopify's CarrierService payload)

import express from "express";
import fetch from "node-fetch";
import basicAuth from "basic-auth";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Optional protection for the endpoint
const CS_USER = process.env.CS_USER || "dev";
const CS_PASS = process.env.CS_PASS || "Fire@12300";

// ShipStation API v1 credentials (Basic Auth)
const SS_API_KEY = process.env.SS_API_KEY;       // required
const SS_API_SECRET = process.env.SS_API_SECRET; // required

// Origin defaults (adjust to your ship-from)
const ORIGIN_POSTAL = process.env.ORIGIN_ZIP || "60462";
const ORIGIN_STATE  = process.env.ORIGIN_STATE || "IL";
const ORIGIN_COUNTRY= process.env.ORIGIN_COUNTRY || "US";
const DEFAULT_DIMENSIONS = {
  length: Number(process.env.DEFAULT_LENGTH || 8),
  width:  Number(process.env.DEFAULT_WIDTH  || 6),
  height: Number(process.env.DEFAULT_HEIGHT || 4),
  unit:   "inch",
};

// ===== Middleware =====
app.use((req, res, next) => {
  if (!CS_USER) return next(); // open if not configured
  const creds = basicAuth(req);
  if (!creds || creds.name !== CS_USER || creds.pass !== CS_PASS) {
    res.set("WWW-Authenticate", 'Basic realm="Shopify Rates"');
    return res.status(401).send("Unauthorized");
  }
  next();
});

// ===== Helpers =====
const b64 = (s) => Buffer.from(s).toString("base64");
const SS_AUTH = "Basic " + b64(`${SS_API_KEY || ""}:${SS_API_SECRET || ""}`);

function gramsToOunces(g) {
  const oz = (g || 0) / 28.3495;
  return Math.max(0.1, Number(oz.toFixed(2))); // min 0.1 oz
}

// Pull active carriers from ShipStation
async function getActiveCarriers() {
  const url = "https://ssapi.shipstation.com/carriers";
  const resp = await fetch(url, { headers: { Authorization: SS_AUTH } });
  if (!resp.ok) throw new Error(`ShipStation carriers error ${resp.status}`);
  return resp.json(); // array of carriers
}

// Get rates for a specific carrier via v1 /shipments/getrates
async function getRatesForCarrier(carrierCode, payload) {
  const url = "https://ssapi.shipstation.com/shipments/getrates";
  const body = { carrierCode, ...payload };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: SS_AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`ShipStation getrates ${carrierCode} ${resp.status}: ${t}`);
  }
  return resp.json(); // array of rates for that carrier
}

// Map ShipStation rate -> Shopify rate format
function mapToShopifyRate(r) {
  const amount = Number(r.shipmentCost || r.shippingAmount || 0);
  const serviceName = (r.serviceName || r.serviceCode || "Service").trim();
  const carrier = (r.carrierFriendlyName || r.carrierCode || "Carrier").trim();

  const name = `${carrier} ${serviceName}`.replace(/\s+/g, " ");
  const code = `${r.carrierCode}:${r.serviceCode || serviceName}`;
  const cents = Math.round(amount * 100);

  const rate = {
    service_name: name,
    service_code: code,
    total_price: cents,
    currency: "USD",
  };

  if (typeof r.deliveryDays === "number" && r.deliveryDays >= 0) {
    const now = new Date();
    const eta = new Date(now.getTime() + r.deliveryDays * 24 * 60 * 60 * 1000);
    rate.delivery_date = eta.toISOString();
  }
  return rate;
}

// ===== Main endpoint =====
app.post("/rates", async (req, res) => {
  try {
    if (!SS_API_KEY || !SS_API_SECRET) {
      throw new Error("Missing SS_API_KEY / SS_API_SECRET env vars");
    }

    const payload = req.body || {};
    const rateReq = payload.rate || {};
    const dest = rateReq.destination || {};
    const items = rateReq.items || [];

    const totalGrams = items.reduce((sum, it) => sum + (Number(it.grams) || 0), 0);
    const weightOz = gramsToOunces(totalGrams);

    const baseRatesPayload = {
      fromPostalCode: ORIGIN_POSTAL,
      fromState: ORIGIN_STATE,
      fromCountryCode: ORIGIN_COUNTRY,
      toState: dest.province || dest.province_code || "",
      toCountryCode: dest.country || dest.country_code || "US",
      toPostalCode: dest.postal_code || "",
      residential: true,
      weight: { value: weightOz, units: "ounces" },
      dimensions: {
        units: DEFAULT_DIMENSIONS.unit,
        length: DEFAULT_DIMENSIONS.length,
        width: DEFAULT_DIMENSIONS.width,
        height: DEFAULT_DIMENSIONS.height,
      },
    };

    const carriers = await getActiveCarriers();
    let allRates = [];
    for (const c of carriers) {
      if (!c?.carrierCode) continue;
      try {
        const r = await getRatesForCarrier(c.carrierCode, baseRatesPayload);
        if (Array.isArray(r)) allRates = allRates.concat(r.map(mapToShopifyRate));
      } catch (err) {
        console.warn("Carrier rates error:", c.carrierCode, err.message);
      }
    }

    const MARKUP_PERCENT = Number(process.env.MARKUP_PERCENT || 0);
    if (MARKUP_PERCENT) {
      allRates = allRates.map(rt => ({
        ...rt,
        total_price: Math.round(rt.total_price * (1 + MARKUP_PERCENT / 100)),
      }));
    }

    allRates.sort((a, b) => a.total_price - b.total_price);
    return res.json({ rates: allRates });
  } catch (e) {
    console.error("Rates error:", e.message);
    return res.json({ rates: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("ShipStation v1 Rates server running on :" + PORT);
});
