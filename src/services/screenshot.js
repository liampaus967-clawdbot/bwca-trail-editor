import puppeteer from 'puppeteer';

let browser;
let page;

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const SCREENSHOT_WIDTH = parseInt(process.env.SCREENSHOT_WIDTH) || 1200;
const SCREENSHOT_HEIGHT = parseInt(process.env.SCREENSHOT_HEIGHT) || 800;

/**
 * Initialize the headless browser
 */
export async function initBrowser() {
  if (browser) return;
  
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  page = await browser.newPage();
  await page.setViewport({ width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT });
  
  console.log('✓ Screenshot browser initialized');
}

/**
 * Take a screenshot of the map with specified layers and bounds
 */
export async function takeScreenshot(options = {}) {
  const {
    bounds,
    center,
    zoom = 12,
    layers = ['nhd', 'original', 'edited'],
    highlightTrailId = null,
    width = SCREENSHOT_WIDTH,
    height = SCREENSHOT_HEIGHT,
    trailGeometries = {},
    nhdGeometries = []
  } = options;
  
  if (!browser) {
    await initBrowser();
  }
  
  // Build the map HTML
  const html = buildMapHTML({
    token: MAPBOX_TOKEN,
    center: center || [-91.5, 48.0],
    zoom,
    bounds,
    layers,
    highlightTrailId,
    trailGeometries,
    nhdGeometries,
    width,
    height
  });
  
  await page.setContent(html);
  
  // Wait for map to load
  await page.waitForFunction(() => {
    return window.mapLoaded === true;
  }, { timeout: 30000 });
  
  // Small delay for tiles to render
  await new Promise(r => setTimeout(r, 1000));
  
  const screenshot = await page.screenshot({
    type: 'png',
    encoding: 'base64'
  });
  
  return `data:image/png;base64,${screenshot}`;
}

function buildMapHTML(options) {
  const {
    token,
    center,
    zoom,
    bounds,
    layers,
    highlightTrailId,
    trailGeometries,
    nhdGeometries,
    width,
    height
  } = options;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://api.mapbox.com/mapbox-gl-js/v3.0.0/mapbox-gl.js"></script>
  <link href="https://api.mapbox.com/mapbox-gl-js/v3.0.0/mapbox-gl.css" rel="stylesheet">
  <style>
    body { margin: 0; padding: 0; }
    #map { width: ${width}px; height: ${height}px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    window.mapLoaded = false;
    
    mapboxgl.accessToken = '${token}';
    
    const map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [${center[0]}, ${center[1]}],
      zoom: ${zoom},
      preserveDrawingBuffer: true
    });
    
    map.on('load', () => {
      ${bounds ? `
      map.fitBounds([
        [${bounds[0]}, ${bounds[1]}],
        [${bounds[2]}, ${bounds[3]}]
      ], { padding: 50 });
      ` : ''}
      
      // Add NHD layer
      ${layers.includes('nhd') ? `
      map.addSource('nhd', {
        type: 'geojson',
        data: ${JSON.stringify({
          type: 'FeatureCollection',
          features: nhdGeometries.map(g => ({
            type: 'Feature',
            geometry: g,
            properties: {}
          }))
        })}
      });
      map.addLayer({
        id: 'nhd-lines',
        type: 'line',
        source: 'nhd',
        paint: {
          'line-color': '#0066ff',
          'line-width': 3,
          'line-opacity': 0.8
        }
      });
      ` : ''}
      
      // Add original trails layer
      ${layers.includes('original') && trailGeometries.original ? `
      map.addSource('original', {
        type: 'geojson',
        data: ${JSON.stringify(trailGeometries.original)}
      });
      map.addLayer({
        id: 'original-lines',
        type: 'line',
        source: 'original',
        paint: {
          'line-color': '#ff3333',
          'line-width': 2,
          'line-dasharray': [2, 2],
          'line-opacity': 0.7
        }
      });
      ` : ''}
      
      // Add edited trails layer
      ${layers.includes('edited') && trailGeometries.edited ? `
      map.addSource('edited', {
        type: 'geojson',
        data: ${JSON.stringify(trailGeometries.edited)}
      });
      map.addLayer({
        id: 'edited-lines',
        type: 'line',
        source: 'edited',
        paint: {
          'line-color': '#00cc44',
          'line-width': 3,
          'line-opacity': 0.9
        }
      });
      ` : ''}
      
      // Add highlight layer
      ${highlightTrailId && trailGeometries.highlight ? `
      map.addSource('highlight', {
        type: 'geojson',
        data: ${JSON.stringify(trailGeometries.highlight)}
      });
      map.addLayer({
        id: 'highlight-lines',
        type: 'line',
        source: 'highlight',
        paint: {
          'line-color': '#ffcc00',
          'line-width': 5,
          'line-opacity': 1
        }
      });
      ` : ''}
      
      setTimeout(() => { window.mapLoaded = true; }, 500);
    });
  </script>
</body>
</html>
  `;
}

/**
 * Close the browser
 */
export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}

export default { initBrowser, takeScreenshot, closeBrowser };
