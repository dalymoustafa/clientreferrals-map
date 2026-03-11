const https = require("https");
const fs = require("fs");

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const TABLE_ID = process.env.AIRTABLE_TABLE_ID;
const API_KEY  = process.env.AIRTABLE_API_KEY;

if (!BASE_ID || !TABLE_ID || !API_KEY) {
  console.error("Missing environment variables. Check your GitHub Secrets.");
  process.exit(1);
}

function geocode(query) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1&accept-language=en`;
    const req = https.get(url, { headers: { "User-Agent": "IMI-OfficeMaps/1.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.length > 0) {
            const r = parsed[0];
            const a = r.address || {};
            // Get the best city name from address details
            const city = a.city || a.town || a.village || a.county || a.state || a.country || query.split(",")[0].trim();
            resolve({ lat: parseFloat(r.lat), lng: parseFloat(r.lon), city });
          } else { resolve(null); }
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractCityCountry(address) {
  const parts = address.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join(", ");
  return address;
}

function extractCity(address) {
  const parts = address.split(",").map(p => p.trim()).filter(Boolean);
  // Work backwards from second-to-last, skip anything that looks like a street or postcode
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i];
    // Skip purely numeric
    if (/^\d+$/.test(part)) continue;
    // Skip if it starts with a number (street address like "10 Marina Boulevard")
    if (/^\d/.test(part)) continue;
    // Skip if it contains common street words
    if (/\b(street|road|avenue|boulevard|floor|level|suite|tower|plaza|bldg|place|utca|str\.)\b/i.test(part)) continue;
    // Remove trailing postcode numbers
    const cleaned = part.replace(/\s+\d+$/, '').trim();
    if (cleaned.length > 0) return cleaned;
  }
  // Last resort: use the last part (country) minus country = use first part
  return parts[0] || "Office";
}

async function main() {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;
  let allRecords = [];
  let offset = null;
  do {
    const pageUrl = offset ? `${url}?offset=${offset}` : url;
    const result = await new Promise((resolve, reject) => {
      const req = https.get(pageUrl, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
    });
    allRecords = allRecords.concat(result.records || []);
    offset = result.offset || null;
  } while (offset);
  const records = allRecords;

  console.log(`Found ${records.length} records in Airtable`);

  console.log("All names in table:");
  records.forEach(r => console.log(" -", JSON.stringify(r.fields["Name"])));

  const artonRecord = records.find(r =>
    r.fields["Name"] && r.fields["Name"].toLowerCase().includes("3 comma capital")
  );

  if (!artonRecord) {
    console.error("Could not find 3 Comma Capital!");
    process.exit(1);
  }

  console.log("Found:", artonRecord.fields["Name"]);
  const rawLocations = artonRecord.fields["Office Locations"] || artonRecord.fields["Office Location(s)"];

  console.log("Raw locations data:", rawLocations);

  const addresses = rawLocations.split("\n").map(a => a.trim()).filter(Boolean);
  console.log(`Found ${addresses.length} addresses`);

  const offices = [];

  for (const rawAddress of addresses) {
    const isHq = rawAddress.toUpperCase().startsWith("HQ");
    const cleanAddress = rawAddress.replace(/^HQ\s*/i, "").trim();
    const cityCountry = extractCityCountry(cleanAddress);
    const city = extractCity(cleanAddress);

    console.log(`Geocoding: ${cityCountry}`);
    await sleep(1100);

    const coords = await geocode(cityCountry);

    if (!coords) {
      console.warn(`Could not geocode: ${cityCountry}`);
      continue;
    }

    offices.push({ city: city, address: cleanAddress, lat: coords.lat, lng: coords.lng, hq: isHq });
    console.log(`  ✓ ${city}: ${coords.lat}, ${coords.lng}`);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>3 comma capital — Office Locations</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"><\/script>
  <link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;700&family=Libre+Baskerville&display=swap" rel="stylesheet"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #fff; font-family: 'Libre Baskerville', serif; }
    .imi-map-widget { width: 100%; max-width: 960px; margin: 0 auto; }
    .map-label { font-family: 'Roboto Condensed', sans-serif; font-size: 12px; color: #888; margin-bottom: 6px; letter-spacing: 0.03em; }
    #imi-map { width: 100%; height: 420px; margin-top: 80px; background: #ffffff; }
    .leaflet-control-attribution { display: none !important; }
    .leaflet-popup-content-wrapper { border-radius: 0 !important; border: 1px solid #e4e4e4 !important; box-shadow: 0 4px 16px rgba(0,0,0,0.10) !important; }
    .leaflet-popup-content { margin: 12px 16px !important; }
    .popup-city { font-family: 'Roboto Condensed', sans-serif; font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #111; margin-bottom: 4px; }
    .popup-addr { font-family: 'Libre Baskerville', serif; font-size: 11px; color: #777; line-height: 1.5; }
    .leaflet-popup { max-width: 160px !important; }
    .leaflet-popup-content-wrapper { max-width: 160px !important; border-radius: 0 !important; border: 1px solid #e4e4e4 !important; box-shadow: 0 4px 16px rgba(0,0,0,0.10) !important; }
    .leaflet-popup-content { max-width: 140px !important; word-wrap: break-word; margin: 10px 12px !important; }
    .popup-hq { font-family: 'Roboto Condensed', sans-serif; font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #c71e1d; display: block; margin-bottom: 3px; }
  </style>
</head>
<body>
<div class="imi-map-widget">
  <p class="map-label">Headquarters' location in red</p>
  <div id="imi-map"></div>
</div>
<script>
  const OFFICES = ${JSON.stringify(offices, null, 2)};

  function makeIcon(isHq) {
    const fill = isHq ? "#c71e1d" : "#1d81a2";
    const size = isHq ? 20 : 13;
    return L.divIcon({
      className: "",
      html: \`<svg width="\${size}" height="\${size}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
               <rect x="2" y="2" width="16" height="16" rx="1" transform="rotate(45 10 10)"
                 fill="\${fill}" fill-opacity="0.85" stroke="rgba(0,0,0,0.5)" stroke-width="1.2"/>
             </svg>\`,
      iconSize: [size, size], iconAnchor: [size/2, size/2], popupAnchor: [0, -(size/2+4)]
    });
  }


  const map = L.map("imi-map", {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false
  });

  fetch("https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson")
    .then(r => r.json())
    .then(geojson => {
      // Filter out Antarctica
      geojson.features = geojson.features.filter(f => f.properties.name !== "Antarctica");

      L.geoJSON(geojson, {
        style: { fillColor: "#ededed", fillOpacity: 1, color: "#cccccc", weight: 0.5 }
      }).addTo(map);

      OFFICES.forEach(o => {
        const marker = L.marker([o.lat, o.lng], { icon: makeIcon(o.hq) }).addTo(map);
        const popupContent = \`\${o.hq ? '<span class="popup-hq">Headquarters</span>' : ''}<div class="popup-city">\${o.city}</div><div class="popup-addr">\${o.address}</div>\`;
        
        marker.on('click', function(e) {
          map.closePopup();
          L.popup({
            autoPan: false,
            offset: [0, -8],
            className: 'smart-popup'
          })
          .setLatLng(e.latlng)
          .setContent(popupContent)
          .openOn(map);
        });
      });

      map.setView([20, -20], 1);
    });

  map.setView([30, 20], 2);
<\/script>
</body>
</html>`;

  fs.writeFileSync("index.html", html);
  console.log(`Done! Wrote index.html with ${offices.length} offices.`);
}

main().catch(e => { console.error(e); process.exit(1); });
