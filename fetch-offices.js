const https = require("https");
const fs = require("fs");

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const TABLE_ID = process.env.AIRTABLE_TABLE_ID;
const API_KEY  = process.env.AIRTABLE_API_KEY;

if (!BASE_ID || !TABLE_ID || !API_KEY) {
  console.error("Missing environment variables.");
  process.exit(1);
}

function geocode(query) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=en`;
    const req = https.get(url, { headers: { "User-Agent": "IMI-OfficeMaps/1.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.length > 0) {
            resolve({ lat: parseFloat(parsed[0].lat), lng: parseFloat(parsed[0].lon) });
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
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i];
    if (/^\d/.test(part)) continue;
    if (/^\d+$/.test(part)) continue;
    if (/\b(street|road|avenue|boulevard|floor|level|suite|tower|plaza|bldg|place|utca|district|avenida|rua|heights|zayed|college|mcgill)\b/i.test(part)) continue;
    const cleaned = part.replace(/\s+\d+$/, '').replace(/^\d+\s+/, '').trim();
    if (cleaned.length > 1) return cleaned;
  }
  return parts[parts.length - 2] || parts[0] || "Office";
}

async function main() {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;
  let allRecords = [];
  let offset = null;
  do {
    const pageUrl = offset ? `${url}?offset=${offset}` : url;
    const result = await new Promise((resolve, reject) => {
      const req = https.get(pageUrl, { headers: { Authorization: `Bearer ${API_KEY}` } }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on("error", reject);
    });
    allRecords = allRecords.concat(result.records || []);
    offset = result.offset || null;
  } while (offset);

  console.log(`Found ${allRecords.length} records`);

  const record = allRecords.find(r =>
    r.fields["Name"] && r.fields["Name"].toLowerCase().includes("clientreferrals")
  );

  if (!record) { console.error("Could not find ClientReferrals!"); process.exit(1); }
  console.log("Found:", record.fields["Name"]);

  const rawLocations = record.fields["Office Locations"];
  if (!rawLocations) { console.error("Office Locations field is empty!"); process.exit(1); }

  const addresses = rawLocations.split("\n").map(a => a.trim()).filter(Boolean);
  console.log(`Found ${addresses.length} addresses`);

  const offices = [];
  for (const rawAddress of addresses) {
    const isHq = rawAddress.toUpperCase().startsWith("HQ");
    const cleanAddress = rawAddress.replace(/^HQ\s*/i, "").trim();
    const city = extractCity(cleanAddress);
    const cityCountry = extractCityCountry(cleanAddress);
    console.log(`Geocoding: ${cityCountry}`);
    await sleep(1100);
    const coords = await geocode(cityCountry);
    if (!coords) { console.warn(`Could not geocode: ${cityCountry}`); continue; }
    offices.push({ city, address: cleanAddress, lat: coords.lat, lng: coords.lng, hq: isHq });
    console.log(`  ✓ ${city}: ${coords.lat}, ${coords.lng}`);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>ClientReferrals — Office Locations</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"><\/script>
  <link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;700&family=Libre+Baskerville&display=swap" rel="stylesheet"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #fff; font-family: 'Libre Baskerville', serif; }
    .imi-map-widget { width: 100%; max-width: 960px; margin: 0 auto; }
    .map-label { font-family: 'Roboto Condensed', sans-serif; font-size: 12px; color: #888; margin-bottom: 6px; letter-spacing: 0.03em; }
    #imi-map { width: 100%; height: 500px; background: #ffffff; }
    .leaflet-control-attribution { display: none !important; }
    .leaflet-control-zoom { display: none !important; }
    .custom-tooltip { position: absolute; z-index: 9999; background: #fff; border: 1px solid #e4e4e4; box-shadow: 0 4px 16px rgba(0,0,0,0.10); padding: 10px 12px; width: 160px; display: none; pointer-events: none; }
    .popup-city { font-family: 'Roboto Condensed', sans-serif; font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #111; margin-bottom: 4px; }
    .popup-addr { font-family: 'Libre Baskerville', serif; font-size: 11px; color: #777; line-height: 1.5; word-wrap: break-word; }
    .popup-hq { font-family: 'Roboto Condensed', sans-serif; font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #c71e1d; display: block; margin-bottom: 3px; }
  </style>
</head>
<body>
<div class="imi-map-widget" style="position:relative;">
  <p class="map-label">Headquarters' location in red</p>
  <div id="imi-map"></div>
  <div class="custom-tooltip" id="custom-tooltip"></div>
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
      iconSize: [size, size], iconAnchor: [size/2, size/2], popupAnchor: [0, size]
    });
  }

  const map = L.map("imi-map", {
    zoomControl: false, attributionControl: false, dragging: false,
    scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
    keyboard: false, touchZoom: false, worldCopyJump: false
  });

  fetch("https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson")
    .then(r => r.json())
    .then(geojson => {
      geojson.features = geojson.features.filter(f => f.properties.name !== "Antarctica");
      L.geoJSON(geojson, { style: { fillColor: "#ededed", fillOpacity: 1, color: "#cccccc", weight: 0.5 } }).addTo(map);

      const tooltip = document.getElementById('custom-tooltip');
      map.on('click', function() { tooltip.style.display = 'none'; });

      OFFICES.forEach(o => {
        const marker = L.marker([o.lat, o.lng], { icon: makeIcon(o.hq) }).addTo(map);
        marker.on('click', function(e) {
          L.DomEvent.stopPropagation(e);
          const point = map.latLngToContainerPoint([o.lat, o.lng]);
          tooltip.innerHTML = \`\${o.hq ? '<span class="popup-hq">Headquarters</span>' : ''}<div class="popup-city">\${o.city}</div><div class="popup-addr">\${o.address}</div>\`;
          tooltip.style.display = 'block';
          const mapWidth = map.getContainer().offsetWidth;
          let left = point.x - 80;
          if (left < 5) left = 5;
          if (left + 160 > mapWidth) left = mapWidth - 165;
          tooltip.style.left = left + 'px';
          tooltip.style.top = (point.y + 16) + 'px';
        });
      });

      map.setView([20, -20], 2);
    });
  map.setView([20, -20], 2);
<\/script>
</body>
</html>`;

  fs.writeFileSync("index.html", html);
  console.log(`Done! Wrote index.html with ${offices.length} offices.`);
}

main().catch(e => { console.error(e); process.exit(1); });
