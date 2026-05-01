const https = require("https");
const fs = require("fs");

const MAX_PAGES = 13;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadData(file) {
  try {
    if (fs.existsSync(file)) {
      const content = JSON.parse(fs.readFileSync(file, "utf8"));
      const items = content.data || [];
      const ids = new Set(items.map(i => i.id));
      const cursor = content.lastCursor || "";
      return { items, ids, cursor };
    }
  } catch {
    log(`Error reading ${file}, starting fresh`);
  }
  return { items: [], ids: new Set(), cursor: "" };
}

function saveData(items, file, lastCursor) {
  try {
    const output = {
      totalItems: items.length,
      lastUpdate: new Date().toISOString(),
      lastCursor: lastCursor || null,
      data: items
    };
    fs.writeFileSync(file, JSON.stringify(output, null, 2), "utf8");
    return true;
  } catch (e) {
    log(`Save error for ${file}: ${e.message}`);
    return false;
  }
}

function fetchJSON(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const tryFetch = (attempt) => {
      const timeout = setTimeout(() => reject(new Error("Request timeout")), 30000);

      https.get(url, res => {
        clearTimeout(timeout);
        let data = "";

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("JSON parse error"));
          }
        });

      }).on("error", e => {
        clearTimeout(timeout);
        if (attempt < retries) {
          setTimeout(() => tryFetch(attempt + 1), 2000 * attempt);
        } else {
          reject(e);
        }
      });
    };

    tryFetch(1);
  });
}

async function fetchBundleDetails(bundleId) {
  try {
    const url = `https://catalog.roproxy.com/v1/bundles/${bundleId}/details`;
    const res = await fetchJSON(url);

    if (res.bundleType !== "DynamicHead") return null;

    if (res.items && Array.isArray(res.items)) {
      const mood = res.items.find(i => i.assetType === 78);
      if (mood) {
        return { id: mood.id, name: mood.name };
      }
    }
  } catch (e) {
    if (!e.message.includes("HTTP 400")) {
      log(`Failed to fetch bundle ${bundleId}: ${e.message}`);
    }
  }
  return null;
}

async function fetchMoods(existingData) {
  const allItems = [];
  let cursor = existingData.cursor || "";
  let page = 0;
  let newCount = 0;
  let duplicateCount = 0;
  let lastCursor = null;

  try {
    do {
      page++;
      log(`Dynamic Heads - Page ${page}/${MAX_PAGES}`);

      const base = "https://catalog.roproxy.com/v1/search/items/details?bundleTypes=DynamicHead&Limit=30";
      const url = cursor ? `${base}&Cursor=${cursor}` : base;
      const res = await fetchJSON(url);

      if (res.data && Array.isArray(res.data)) {
        for (const item of res.data) {
          if (existingData.ids.has(item.id)) {
            duplicateCount++;
            continue;
          }

          log(`Fetching bundle details for: ${item.name} (${item.id})`);
          const mood = await fetchBundleDetails(item.id);

          if (mood) {
            if (!existingData.ids.has(mood.id)) {
              allItems.push({ id: mood.id, name: mood.name, custom: false });
              existingData.ids.add(mood.id);
              newCount++;
              log(`Found mood: ${mood.name} (${mood.id})`);
            }
          }

          await new Promise(r => setTimeout(r, 500));
        }
      }

      cursor = res.nextPageCursor;
      lastCursor = cursor;
      await new Promise(r => setTimeout(r, 1000));

    } while (cursor && cursor.trim() !== "" && page < MAX_PAGES);

  } catch (e) {
    log(`Error fetching moods: ${e.message}`);
  }

  log(`Stopped at page ${page}/${MAX_PAGES}`);
  return { items: allItems, newCount, duplicateCount, lastCursor };
}

async function main() {
  const file = "mooddata.json";
  log("Starting mood scraper...");

  const existingData = loadData(file);
  const allItems = [...existingData.items];

  if (existingData.cursor) {
    log(`Resuming from cursor: ${existingData.cursor}`);
  } else {
    log("Starting from beginning");
  }

  const result = await fetchMoods(existingData);
  allItems.push(...result.items);

  log(`New: ${result.newCount}, Duplicates: ${result.duplicateCount}`);

  const saved = saveData(allItems, file, result.lastCursor);

  if (saved) {
    log(`✓ mooddata.json: ${allItems.length} items (${result.newCount} new)`);
    if (result.lastCursor) {
      log(`Next run will resume from saved cursor`);
    } else {
      log(`Reached end of catalog, next run will start from beginning`);
    }
  } else {
    log("Failed to save mooddata.json");
  }

  process.exit(saved ? 0 : 1);
}

process.on("unhandledRejection", reason => {
  log(`Unhandled error: ${reason}`);
  process.exit(1);
});

process.on("uncaughtException", e => {
  log(`Uncaught exception: ${e.message}`);
  process.exit(1);
});

main();
