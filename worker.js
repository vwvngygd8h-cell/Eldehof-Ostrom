const ELDEHOF_BUILD = "6.3.4-WEATHER-HEAT-POWER-COMPARISON-20261031";
function ostromEndpoints(env) {
  const mode = (clean(env.OSTROM_ENV) || "PRODUCTION").toUpperCase();
  if (mode === "SANDBOX") {
    return {
      api: "https://sandbox.ostrom-api.io",
      auth: "https://auth.sandbox.ostrom-api.io/oauth2/token",
      mode
    };
  }
  return {
    api: "https://production.ostrom-api.io",
    auth: "https://auth.production.ostrom-api.io/oauth2/token",
    mode: "PRODUCTION"
  };
}

let tokenCache = { value: "", expiresAt: 0 };
let contractCache = { value: "", expiresAt: 0 };
let liveCache = { value: null, expiresAt: 0 };
let historyCache = { value: null, expiresAt: 0, days: 0 };
let historyChunkCache = new Map();
let weatherCache = { value: null, expiresAt: 0 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/version") {
        return json({
          app: "Eldehof",
          version: ELDEHOF_BUILD,
          productMode: "verbrauchsbuch",
          navigation: "overview-consumption-analysis-data",
          consumptionStorage: "eldehof-v3-records-compatible",
          vaillantDataPreserved: true,
          vaillantCsvImport: "local-arotherm-unitower-monthly-and-climate",
          weatherNormalization: "archive-HDD15-2024-2025",
          climateDashboard: "heat-temperature-chart-6-months",
          weatherLocation: "Kronskamp-fixed-coordinates",
          manualInput: "cumulative-total-and-annex-meter-readings-only",
          meterBaseline: "2026-10-01-total-34255-annex-9045",
          historicalMeterSwitch: "2024-04-01-old-62296-new-197",
          historicalSeedThrough: "2026-09",
          monthEditing: "enabled-manual-corrections",
          deviceSync: "encrypted-auto-active-app",
          deviceSyncPayload: "records-meter-readings-vaillant-ostrom-results-price-statistics",
          deviceSyncClosedAppGuarantee: false,
          consumptionComponents: "total-heatpump-annex-schlee-klus",
          analysis: "annual-allocation-all-years-comparison-cost-cop-ostrom-price-statistics",
          yearComparison: "all-years-past-dashed-current-solid",
          ostromHistoricalPricing: "hourly-consumption-weighted-per-month",
          ostromPriceStatistics: "monthly-quarterly-yearly-consumption-weighted",
          ostromDashboard: "current-price-best-window-worst-window",
          ostromAutoRefreshMinutes: 10,
          ostromWindowHours: "one-to-four-user-selectable",
          ostromCredentials: "existing-local-app-key-preserved",
          localShadowBackup: true,
          emptyStartupOverwriteProtection: true,
          privateBackup: "records-vaillant-ostrom-price-statistics-relevant-settings",
          csvExport: true,
          legacyFeatureDataDeleted: false,
          legacyFeaturesVisible: false,
          syncBackendRetainedButHidden: false,
          syncUiVisible: true,
          migrationTag: "v5-1-0-sync",
          deployedAt: "2026-10-05"
        });
      }

      if (url.pathname === "/api/sync/health") {
        return json({
          ok: true,
          configured: Boolean(env.SYNC_VAULT),
          backend: "sqlite-durable-object",
          encryption: "client-side-aes-gcm-hkdf-sha256",
          plaintextOnServer: false,
          automaticBackgroundSync: false,
          activeAppAutomaticSync: true,
          activeAppSyncTriggers: "startup-focus-after-change-60s",
          mergeMode: "client-side-record-timestamp-merge",
          conflictCenter: true,
          localRetryQueue: true,
          autoCheckWhenAppActive: true,
          autopilotRequiresActiveApp: true,
          autopilotControlsDevices: false,
          learningLocalOnly: true,
          learningControlsDevices: false,
          learningMinimumObservations: 3,
          cockpitLocalOnly: true,
          cockpitMaxWidgets: 4,
          cockpitCriticalWarningsHidden: false,
          ostromCredentialsRenderedOnToday: false,
          ostromSwitchPreservesCredentials: true,
          cockpitRefreshAllBackgroundGuarantee: false
        });
      }

      if (url.pathname.startsWith("/api/sync/")) {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204 });
        }
        return handleSyncRequest(request, env, url);
      }

      if (url.pathname.startsWith("/api/")) {
        if (request.method === "OPTIONS") return new Response(null, { status: 204 });
        requireKey(request, env);

        if (url.pathname === "/api/health") {
          const configured = Boolean(clean(env.OSTROM_CLIENT_ID) && clean(env.OSTROM_CLIENT_SECRET) && clean(env.ELDEHOF_APP_KEY));
          const result = {
            ok: true,
            configured,
            zipCode: clean(env.OSTROM_ZIP_CODE) || "19306",
            environment: (clean(env.OSTROM_ENV) || "PRODUCTION").toUpperCase()
          };
          if (url.searchParams.get("deep") === "token") {
            if (!configured) throw httpError(500, "Cloudflare-Secrets sind noch nicht vollständig eingerichtet.");
            await getToken(env, true);
            result.ostromAuth = true;
          }
          return json(result);
        }

        if (url.pathname === "/api/vaillant/status") {
          return json(vaillantStatus(env));
        }

        if (url.pathname === "/api/vaillant/month") {
          const month = url.searchParams.get("month");
          if (!/^\d{4}-\d{2}$/.test(month || "")) {
            throw httpError(400, "Ungültiger Vaillant-Monat.");
          }
          const status = vaillantStatus(env);
          if (!status.configured) {
            throw httpError(
              503,
              "Der offizielle Vaillant-Datenadapter wartet noch auf API-Freigabe und Cloudflare-Konfiguration."
            );
          }
          return json(await fetchVaillantMonth(month, env));
        }

        if (url.pathname === "/api/weather/archive") {
          const year=Number(url.searchParams.get("year"));
          if(!Number.isInteger(year)||year<2023||year>new Date().getUTCFullYear())throw httpError(400,"Ungültiges Wetterjahr");
          return json(await buildClimateArchive(year,env));
        }
        if (url.pathname === "/api/weather") {
          const force = url.searchParams.get("refresh") === "1";
          if (!force && weatherCache.value && weatherCache.expiresAt > Date.now()) {
            return json(weatherCache.value);
          }
          const payload = await buildWeatherPayload(env);
          weatherCache = {
            value: payload,
            expiresAt: Date.now() + 60 * 60 * 1000
          };
          return json(payload);
        }

        if (url.pathname === "/api/prices") {
          const range = priceRange();
          const token = await getToken(env);
          const payload = await fetchPrices(range.startDate, range.endDate, env, token);
          const prices = extractArray(payload).map(normalizePrice).filter(Boolean);
          return json({ prices, zipCode: clean(env.OSTROM_ZIP_CODE) || "19306" });
        }

        if (url.pathname === "/api/live") {
          const force = url.searchParams.get("refresh") === "1";
          if (!force && liveCache.value && liveCache.expiresAt > Date.now()) {
            return json(liveCache.value);
          }
          const payload = await buildLivePayload(env);
          liveCache = { value: payload, expiresAt: Date.now() + 5 * 60 * 1000 };
          return json(payload);
        }

        if (url.pathname === "/api/history-chunk") {
          const startDate = url.searchParams.get("startDate") || "";
          const endDate = url.searchParams.get("endDate") || "";
          const start = new Date(startDate);
          const end = new Date(endDate);
          const spanMs = end.getTime() - start.getTime();
          const maxSpanMs = 8 * 86400000;

          if (
            Number.isNaN(start.getTime()) ||
            Number.isNaN(end.getTime()) ||
            spanMs <= 0 ||
            spanMs > maxSpanMs
          ) {
            throw httpError(
              400,
              "Ungültiger Analyseabschnitt. Erlaubt sind höchstens acht Tage."
            );
          }

          const now = Date.now();
          if (
            start.getTime() < now - 380 * 86400000 ||
            end.getTime() > now + 2 * 86400000
          ) {
            throw httpError(400, "Der Analyseabschnitt liegt außerhalb des erlaubten Bereichs.");
          }

          const cacheKey = `${start.toISOString()}|${end.toISOString()}`;
          const cached = historyChunkCache.get(cacheKey);
          if (
            url.searchParams.get("refresh") !== "1" &&
            cached &&
            cached.expiresAt > Date.now()
          ) {
            return json({ ...cached.value, cache: "worker" });
          }

          const payload = await buildHistoryChunkPayload(
            env,
            start.toISOString(),
            end.toISOString()
          );
          historyChunkCache.set(cacheKey, {
            value: payload,
            expiresAt: Date.now() + 20 * 60 * 1000
          });

          if (historyChunkCache.size > 80) {
            const oldestKey = historyChunkCache.keys().next().value;
            historyChunkCache.delete(oldestKey);
          }

          return json(payload);
        }

        if (url.pathname === "/api/history") {
          const requestedDays = Number(url.searchParams.get("days") || 120);
          const days = Math.max(30, Math.min(370, Number.isFinite(requestedDays) ? Math.round(requestedDays) : 120));
          const force = url.searchParams.get("refresh") === "1";
          if (!force && historyCache.value && historyCache.days === days && historyCache.expiresAt > Date.now()) {
            return json(historyCache.value);
          }
          const payload = await buildHistoryPayload(env, days);
          historyCache = { value: payload, days, expiresAt: Date.now() + 30 * 60 * 1000 };
          return json(payload);
        }

        if (url.pathname === "/api/month") {
          const month = url.searchParams.get("month");
          if (!/^\d{4}-\d{2}$/.test(month || "")) throw httpError(400, "Ungültiger Monat.");
          const { startDate, endDate } = monthRange(month);
          const token = await getToken(env);
          const contractId = await getContractId(env, token);
          const qs = new URLSearchParams({ startDate, endDate, resolution: "HOUR" });

          const [consumptionPayload, pricePayload] = await Promise.all([
            ostromFetch(`/contracts/${encodeURIComponent(contractId)}/energy-consumption?${qs}`, token, env),
            fetchPrices(startDate, endDate, env, token)
          ]);

          const consumption = extractArray(consumptionPayload).map(normalizeConsumption).filter(Boolean);
          const prices = extractArray(pricePayload).map(normalizePrice).filter(Boolean);
          const priceMap = new Map(prices.map(p => [intervalKey(p.date), p]));

          let totalKWh = 0;
          let variableCostEur = 0;
          let matchedIntervals = 0;
          for (const row of consumption) {
            totalKWh += row.kWh;
            const price = priceMap.get(intervalKey(row.date));
            if (price) {
              variableCostEur += row.kWh * price.totalCtPerKWh / 100;
              matchedIntervals++;
            }
          }

          const first = prices[0] || {};
          const fixedCostEur = number(first.monthlyOstromBaseFee) + number(first.monthlyGridFee);
          const weightedAverageCtPerKWh = totalKWh > 0 ? variableCostEur / totalKWh * 100 : 0;

          return json({
            month,
            contractId,
            totalKWh: round(totalKWh, 3),
            weightedAverageCtPerKWh: round(weightedAverageCtPerKWh, 3),
            variableCostEur: round(variableCostEur, 2),
            fixedCostEur: round(fixedCostEur, 2),
            totalCostEur: round(variableCostEur + fixedCostEur, 2),
            consumptionIntervals: consumption.length,
            priceIntervals: prices.length,
            matchedIntervals,
            complete: consumption.length > 0 && matchedIntervals === consumption.length
          });
        }

        throw httpError(404, "API-Endpunkt nicht gefunden.");
      }

      return serveEmbeddedAsset(url.pathname, request.method);
    } catch (error) {
      return json({ error: error.message || "Interner Fehler" }, error.status || 500);
    }
  }
};


const SYNC_MAX_ENVELOPE_CHARS = 1500000;
const SYNC_PAIRING_TTL_MS = 10 * 60 * 1000;
const SYNC_DEVICE_LIMIT = 12;
const SYNC_HISTORY_LIMIT = 24;

async function handleSyncRequest(request, env, url) {
  if (!env.SYNC_VAULT) {
    throw httpError(503, "SYNC_VAULT ist noch nicht als Durable Object eingerichtet.");
  }
  if (request.method !== "POST") {
    throw httpError(405, "Für diesen Sync-Endpunkt ist POST erforderlich.");
  }
  const text = await request.text();
  if (text.length > SYNC_MAX_ENVELOPE_CHARS + 200000) {
    throw httpError(413, "Synchronisierungspaket ist zu groß.");
  }
  let body;
  try { body = JSON.parse(text || "{}"); }
  catch { throw httpError(400, "Ungültige Sync-Anfrage."); }
  const vaultId = syncIdentifier(body.vaultId, "Tresor-ID", 16, 80);
  const id = env.SYNC_VAULT.idFromName(vaultId);
  const stub = env.SYNC_VAULT.get(id);
  const internal = new URL(request.url);
  internal.hostname = "sync.internal";
  internal.pathname = url.pathname.replace(/^\/api\/sync/, "") || "/";
  return stub.fetch(new Request(internal.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, vaultId })
  }));
}

function syncIdentifier(value, label, min = 8, max = 100) {
  const text = String(value || "");
  if (text.length < min || text.length > max || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw httpError(400, `${label} ist ungültig.`);
  }
  return text;
}

function syncName(value) {
  const text = String(value || "").trim().replace(/[<>]/g, "").slice(0, 60);
  return text || "Eldehof-Gerät";
}

function syncScope(value) {
  return value === "household" ? "household" : "full";
}

async function syncHash(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value || ""))
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function syncSafeEqual(a, b) {
  const first = String(a || "");
  const second = String(b || "");
  if (first.length !== second.length) return false;
  let result = 0;
  for (let index = 0; index < first.length; index++) {
    result |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return result === 0;
}

function syncCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const raw = [...bytes].map(byte => alphabet[byte % alphabet.length]).join("");
  return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}`;
}

function syncEnvelope(value) {
  if (!value || typeof value !== "object") {
    throw httpError(400, "Verschlüsseltes Paket fehlt.");
  }
  const ciphertext = String(value.ciphertext || "");
  const iv = String(value.iv || "");
  if (!/^[A-Za-z0-9_-]{16,}$/.test(ciphertext) || ciphertext.length > SYNC_MAX_ENVELOPE_CHARS) {
    throw httpError(413, "Verschlüsseltes Paket ist ungültig oder zu groß.");
  }
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(iv)) {
    throw httpError(400, "Verschlüsselungs-IV ist ungültig.");
  }
  return {
    schema: "eldehof-encrypted-sync-v1",
    algorithm: "AES-GCM-256/HKDF-SHA-256",
    iv,
    ciphertext,
    scope: syncScope(value.scope),
    createdAt: String(value.createdAt || new Date().toISOString()).slice(0, 40),
    payloadBuild: String(value.payloadBuild || "").slice(0, 80)
  };
}

export class EldehofSyncVault {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const body = await request.json();
      const vaultId = syncIdentifier(body.vaultId, "Tresor-ID", 16, 80);
      const path = url.pathname;
      if (path === "/vault/create") return await this.createVault(vaultId, body);
      if (path === "/pair/create") return await this.createPairing(vaultId, body);
      if (path === "/pair/claim") return await this.claimPairing(vaultId, body);
      if (path === "/snapshot/pull") return await this.pullSnapshot(vaultId, body);
      if (path === "/snapshot/push") return await this.pushSnapshot(vaultId, body);
      if (path === "/devices") return await this.listDevices(vaultId, body);
      if (path === "/history") return await this.listHistory(vaultId, body);
      if (path === "/device/revoke") return await this.revokeDevice(vaultId, body);
      if (path === "/vault/delete") return await this.deleteVault(vaultId, body);
      throw httpError(404, "Sync-Endpunkt nicht gefunden.");
    } catch (error) {
      return json({ error: error.message || "Sync-Fehler" }, error.status || 500);
    }
  }

  async meta() {
    return await this.ctx.storage.get("meta") || null;
  }

  async devices() {
    return await this.ctx.storage.get("devices") || {};
  }

  async saveDevices(devices) {
    await this.ctx.storage.put("devices", devices);
  }

  async assertVault(vaultId) {
    const meta = await this.meta();
    if (!meta) throw httpError(404, "Synchronisierungstresor nicht gefunden.");
    if (meta.vaultId !== vaultId) throw httpError(403, "Tresor-ID stimmt nicht überein.");
    return meta;
  }

  async authenticate(vaultId, body, admin = false) {
    const meta = await this.assertVault(vaultId);
    const deviceId = syncIdentifier(body.deviceId, "Geräte-ID", 8, 100);
    const token = String(body.deviceToken || "");
    if (token.length < 32 || token.length > 180) throw httpError(401, "Gerätezugriff fehlt.");
    const devices = await this.devices();
    const device = devices[deviceId];
    if (!device || device.revokedAt) throw httpError(401, "Gerät ist nicht freigegeben.");
    const tokenHash = await syncHash(token);
    if (!syncSafeEqual(tokenHash, device.tokenHash)) throw httpError(401, "Gerätezugriff ist ungültig.");
    if (admin && device.role !== "admin") throw httpError(403, "Nur ein Verwaltungsgerät darf diese Aktion ausführen.");
    device.lastSeenAt = new Date().toISOString();
    devices[deviceId] = device;
    await this.saveDevices(devices);
    return { meta, devices, device, deviceId };
  }

  async createVault(vaultId, body) {
    if (await this.meta()) throw httpError(409, "Dieser Tresor existiert bereits.");
    const deviceId = syncIdentifier(body.deviceId, "Geräte-ID", 8, 100);
    const token = String(body.deviceToken || "");
    if (token.length < 32 || token.length > 180) throw httpError(400, "Gerätezugriff ist ungültig.");
    const envelope = syncEnvelope(body.envelope);
    if (envelope.scope !== "full") throw httpError(400, "Der erste Tresorstand muss den Verwaltungsumfang verwenden.");
    const now = new Date().toISOString();
    const meta = {
      vaultId,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      scopeRevisions: { full: 1, household: 0 },
      latestByScope: { full: 1, household: 0 },
      latestSourceByScope: { full: deviceId, household: "" },
      history: [{ revision: 1, scope: "full", createdAt: now, sourceDeviceId: deviceId }]
    };
    const devices = {
      [deviceId]: {
        id: deviceId,
        name: syncName(body.deviceName),
        role: "admin",
        scope: "full",
        tokenHash: await syncHash(token),
        createdAt: now,
        lastSeenAt: now,
        lastPullAt: "",
        lastPushAt: now,
        lastRevision: 1,
        revokedAt: ""
      }
    };
    await this.ctx.storage.put({
      meta,
      devices,
      pairings: {},
      "snapshot:1": { revision: 1, scope: "full", createdAt: now, sourceDeviceId: deviceId, envelope }
    });
    return json({ ok: true, revision: 1, role: "admin", scope: "full", createdAt: now });
  }

  async createPairing(vaultId, body) {
    const auth = await this.authenticate(vaultId, body, true);
    const devices = auth.devices;
    const activeCount = Object.values(devices).filter(device => !device.revokedAt).length;
    if (activeCount >= SYNC_DEVICE_LIMIT) throw httpError(409, "Maximale Gerätezahl erreicht.");
    const scope = syncScope(body.scope);
    let meta = auth.meta;
    let scopeRevision = Number(meta.scopeRevisions?.[scope] || 0);
    if (scope === "household") {
      const envelope = syncEnvelope(body.envelope);
      if (envelope.scope !== "household") throw httpError(400, "Für den Haushaltsumfang fehlt das verschlüsselte Haushaltspaket.");
      const nowIso = new Date().toISOString();
      const revision = Number(meta.revision || 0) + 1;
      const history = Array.isArray(meta.history) ? meta.history.slice(-(SYNC_HISTORY_LIMIT - 1)) : [];
      history.push({ revision, scope, createdAt: nowIso, sourceDeviceId: auth.deviceId });
      const nextMeta = {
        ...meta,
        revision,
        updatedAt: nowIso,
        scopeRevisions: { ...(meta.scopeRevisions || {}), household: revision },
        latestByScope: { ...(meta.latestByScope || {}), household: revision },
        latestSourceByScope: { ...(meta.latestSourceByScope || {}), household: auth.deviceId },
        history
      };
      await this.ctx.storage.put({
        meta: nextMeta,
        [`snapshot:${revision}`]: { revision, scope, createdAt: nowIso, sourceDeviceId: auth.deviceId, envelope }
      });
      meta = nextMeta;
      scopeRevision = revision;
    } else if (!scopeRevision) {
      throw httpError(409, "Für diesen Synchronisierungsumfang liegt noch kein verschlüsselter Stand vor.");
    }
    const code = syncCode();
    const key = await syncHash(code.replaceAll("-", ""));
    const pairings = await this.ctx.storage.get("pairings") || {};
    const now = Date.now();
    for (const [hash, item] of Object.entries(pairings)) {
      if (Number(item.expiresAt) <= now || item.usedAt) delete pairings[hash];
    }
    pairings[key] = {
      createdAt: new Date(now).toISOString(),
      expiresAt: now + SYNC_PAIRING_TTL_MS,
      createdBy: auth.deviceId,
      scope,
      scopeRevision,
      usedAt: ""
    };
    await this.ctx.storage.put("pairings", pairings);
    return json({ ok: true, code, expiresAt: new Date(now + SYNC_PAIRING_TTL_MS).toISOString(), scope, revision: scopeRevision });
  }

  async claimPairing(vaultId, body) {
    const meta = await this.assertVault(vaultId);
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 12) throw httpError(400, "Kopplungscode ist ungültig.");
    const pairings = await this.ctx.storage.get("pairings") || {};
    const key = await syncHash(code);
    const pairing = pairings[key];
    if (!pairing || pairing.usedAt || Number(pairing.expiresAt) <= Date.now()) {
      throw httpError(410, "Kopplungscode ist abgelaufen oder bereits verwendet.");
    }
    const scopeRevision = Number(meta.scopeRevisions?.[pairing.scope] || pairing.scopeRevision || 0);
    if (!scopeRevision) throw httpError(409, "Der verschlüsselte Umfang ist noch nicht vorbereitet.");
    const deviceId = syncIdentifier(body.deviceId, "Geräte-ID", 8, 100);
    const token = String(body.deviceToken || "");
    if (token.length < 32 || token.length > 180) throw httpError(400, "Gerätezugriff ist ungültig.");
    const devices = await this.devices();
    const activeCount = Object.values(devices).filter(device => !device.revokedAt).length;
    if (activeCount >= SYNC_DEVICE_LIMIT) throw httpError(409, "Maximale Gerätezahl erreicht.");
    if (devices[deviceId] && !devices[deviceId].revokedAt) throw httpError(409, "Gerät ist bereits gekoppelt.");
    const now = new Date().toISOString();
    devices[deviceId] = {
      id: deviceId,
      name: syncName(body.deviceName),
      role: "member",
      scope: pairing.scope,
      tokenHash: await syncHash(token),
      createdAt: now,
      lastSeenAt: now,
      lastPullAt: "",
      lastPushAt: "",
      lastRevision: scopeRevision,
      revokedAt: ""
    };
    pairing.usedAt = now;
    pairings[key] = pairing;
    await this.ctx.storage.put({ devices, pairings });
    return json({ ok: true, revision: scopeRevision, role: "member", scope: pairing.scope, pairedAt: now });
  }

  async pullSnapshot(vaultId, body) {
    const auth = await this.authenticate(vaultId, body, false);
    const scope = auth.device.scope;
    const revision = Number(auth.meta.scopeRevisions?.[scope] || 0);
    if (!revision) throw httpError(409, "Für diesen Geräteumfang liegt noch kein verschlüsselter Stand vor.");
    const snapshot = await this.ctx.storage.get(`snapshot:${revision}`);
    if (!snapshot) throw httpError(409, "Der verschlüsselte Stand ist nicht verfügbar.");
    const now = new Date().toISOString();
    auth.device.lastPullAt = now;
    auth.device.lastRevision = revision;
    auth.devices[auth.deviceId] = auth.device;
    await this.saveDevices(auth.devices);
    return json({
      ok: true,
      revision,
      updatedAt: snapshot.createdAt || auth.meta.updatedAt,
      sourceDeviceId: snapshot.sourceDeviceId || "",
      deviceScope: scope,
      role: auth.device.role,
      snapshot
    });
  }

  async pushSnapshot(vaultId, body) {
    const auth = await this.authenticate(vaultId, body, false);
    const meta = auth.meta;
    const envelope = syncEnvelope(body.envelope);
    if (auth.device.scope === "household" && envelope.scope !== "household") {
      throw httpError(403, "Dieses Gerät darf nur den Haushaltsumfang übertragen.");
    }
    if (auth.device.role !== "admin" && envelope.scope !== auth.device.scope) {
      throw httpError(403, "Der Synchronisierungsumfang stimmt nicht mit der Gerätefreigabe überein.");
    }
    const currentRevision = Number(meta.scopeRevisions?.[envelope.scope] || 0);
    const baseRevision = Math.max(0, Math.round(Number(body.baseRevision) || 0));
    const force = body.force === true;
    if (!force && baseRevision !== currentRevision) {
      return json({
        error: "Der entfernte Stand wurde inzwischen geändert.",
        conflict: true,
        currentRevision,
        updatedAt: meta.updatedAt,
        sourceDeviceId: meta.latestSourceByScope?.[envelope.scope] || ""
      }, 409);
    }
    const now = new Date().toISOString();
    const revision = Number(meta.revision || 0) + 1;
    const history = Array.isArray(meta.history)
      ? meta.history.slice(-(SYNC_HISTORY_LIMIT - 1))
      : [];
    history.push({ revision, scope: envelope.scope, createdAt: now, sourceDeviceId: auth.deviceId });
    const removed = Array.isArray(meta.history)
      ? meta.history.filter(item => !history.some(keep => keep.revision === item.revision))
      : [];
    const nextMeta = {
      ...meta,
      revision,
      updatedAt: now,
      scopeRevisions: { ...(meta.scopeRevisions || {}), [envelope.scope]: revision },
      latestByScope: { ...(meta.latestByScope || {}), [envelope.scope]: revision },
      latestSourceByScope: { ...(meta.latestSourceByScope || {}), [envelope.scope]: auth.deviceId },
      history
    };
    auth.device.lastPushAt = now;
    auth.device.lastRevision = revision;
    auth.device.lastSeenAt = now;
    auth.devices[auth.deviceId] = auth.device;
    await this.ctx.storage.put({
      meta: nextMeta,
      devices: auth.devices,
      [`snapshot:${revision}`]: { revision, scope: envelope.scope, createdAt: now, sourceDeviceId: auth.deviceId, envelope }
    });
    for (const item of removed) {
      if (!Object.values(nextMeta.latestByScope || {}).includes(item.revision)) {
        await this.ctx.storage.delete(`snapshot:${item.revision}`);
      }
    }
    return json({ ok: true, revision, updatedAt: now, forced: force, scope: envelope.scope });
  }

  async listDevices(vaultId, body) {
    const auth = await this.authenticate(vaultId, body, false);
    const revision = Number(auth.meta.scopeRevisions?.[auth.device.scope] || 0);
    return json({
      ok: true,
      revision,
      devices: Object.values(auth.devices).map(device => ({
        id: device.id,
        name: device.name,
        role: device.role,
        scope: device.scope,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        lastPullAt: device.lastPullAt || "",
        lastPushAt: device.lastPushAt || "",
        lastRevision: Number(device.lastRevision || 0),
        revokedAt: device.revokedAt || "",
        current: device.id === auth.deviceId
      }))
    });
  }

  async listHistory(vaultId, body) {
    const auth = await this.authenticate(vaultId, body, false);
    const scope = auth.device.scope;
    const history = (Array.isArray(auth.meta.history) ? auth.meta.history : [])
      .filter(item => item.scope === scope)
      .slice(-SYNC_HISTORY_LIMIT)
      .reverse()
      .map(item => ({
        revision: Number(item.revision || 0),
        scope: item.scope,
        createdAt: item.createdAt,
        sourceDeviceId: item.sourceDeviceId || ""
      }));
    return json({ ok: true, scope, history });
  }

  async revokeDevice(vaultId, body) {
    const auth = await this.authenticate(vaultId, body, true);
    const targetId = syncIdentifier(body.targetDeviceId, "Geräte-ID", 8, 100);
    if (targetId === auth.deviceId) throw httpError(400, "Das aktuell verwendete Verwaltungsgerät kann sich nicht selbst widerrufen.");
    const target = auth.devices[targetId];
    if (!target || target.revokedAt) throw httpError(404, "Gerät wurde nicht gefunden.");
    target.revokedAt = new Date().toISOString();
    auth.devices[targetId] = target;
    await this.saveDevices(auth.devices);
    return json({ ok: true, targetDeviceId: targetId, revokedAt: target.revokedAt });
  }

  async deleteVault(vaultId, body) {
    await this.authenticate(vaultId, body, true);
    if (String(body.confirmation || "") !== vaultId) {
      throw httpError(400, "Tresor-ID muss zur Bestätigung vollständig eingegeben werden.");
    }
    await this.ctx.storage.deleteAll();
    return json({ ok: true, deleted: true });
  }
}

function requireKey(request, env) {
  if (!env.ELDEHOF_APP_KEY) throw httpError(500, "ELDEHOF_APP_KEY fehlt in Cloudflare.");
  if (request.headers.get("x-eldehof-key") !== env.ELDEHOF_APP_KEY) throw httpError(401, "Ungültiger App-Schlüssel.");
}


function vaillantStatus(env) {
  const dataUrl = clean(env.VAILLANT_DATA_URL);
  const configured = /^https:\/\//i.test(dataUrl);
  return {
    ok: true,
    provider: "Vaillant",
    mode: "normalized-read-only-bridge",
    configured,
    status: configured ? "ready" : "awaiting-official-api-access",
    schema: "eldehof-vaillant-month-v1",
    supportedData: [
      "electricityKWh",
      "heatGeneratedKWh",
      "heatingElectricityKWh",
      "dhwElectricityKWh",
      "heatingHeatKWh",
      "dhwHeatKWh"
    ],
    credentialsInBrowser: false,
    passwordRequiredByEldehof: false,
    serialNumberReturned: false
  };
}

async function fetchVaillantMonth(month, env) {
  const template = clean(env.VAILLANT_DATA_URL);
  if (!/^https:\/\//i.test(template)) {
    throw httpError(503, "VAILLANT_DATA_URL ist noch nicht eingerichtet.");
  }

  let target;
  if (template.includes("{month}")) {
    target = template.replaceAll("{month}", encodeURIComponent(month));
  } else {
    const url = new URL(template);
    url.searchParams.set("month", month);
    target = url.toString();
  }

  const headers = {
    accept: "application/json",
    "x-eldehof-schema": "eldehof-vaillant-month-v1"
  };
  const token = clean(env.VAILLANT_DATA_TOKEN);
  if (token) headers.authorization = `Bearer ${token}`;

  const result = await fetchJsonWithTimeout(
    target,
    { method: "GET", headers },
    {
      timeoutMs: 15000,
      retries: 0,
      label: `Vaillant-Daten ${month}`
    }
  );

  if (!result.response.ok) {
    const detail = safeText(
      result.payload?.message ||
      result.payload?.error_description ||
      result.payload?.error ||
      result.raw
    );
    throw httpError(
      result.response.status,
      `Vaillant-Datenadapter (${result.response.status})${detail ? ` • ${detail}` : ""}.`
    );
  }

  return normalizeVaillantMonthPayload(result.payload, month);
}

function normalizeVaillantMonthPayload(payload, requestedMonth) {
  const source =
    payload?.data && typeof payload.data === "object"
      ? payload.data
      : payload?.values && typeof payload.values === "object"
        ? payload.values
        : payload || {};

  const month = /^\d{4}-\d{2}$/.test(String(source.month || payload?.month || ""))
    ? String(source.month || payload.month)
    : requestedMonth;

  const electricityKWh = firstNumber(
    source.electricityKWh,
    source.electricalEnergyKWh,
    source.consumedElectricityKWh,
    source.powerConsumptionKWh,
    source.energyConsumedKWh,
    source.totalElectricityKWh
  );
  const heatGeneratedKWh = firstNumber(
    source.heatGeneratedKWh,
    source.generatedHeatKWh,
    source.thermalEnergyKWh,
    source.heatOutputKWh,
    source.totalHeatKWh
  );

  const heatingElectricityKWh = firstNumber(
    source.heatingElectricityKWh,
    source.heatingConsumedKWh,
    source.spaceHeatingElectricityKWh
  );
  const dhwElectricityKWh = firstNumber(
    source.dhwElectricityKWh,
    source.hotWaterElectricityKWh,
    source.domesticHotWaterElectricityKWh
  );
  const heatingHeatKWh = firstNumber(
    source.heatingHeatKWh,
    source.spaceHeatingHeatKWh,
    source.heatingGeneratedKWh
  );
  const dhwHeatKWh = firstNumber(
    source.dhwHeatKWh,
    source.hotWaterHeatKWh,
    source.domesticHotWaterHeatKWh
  );

  if (!Number.isFinite(electricityKWh) || electricityKWh < 0) {
    throw httpError(
      502,
      "Der Vaillant-Datenadapter hat keinen gültigen elektrischen Monatsverbrauch geliefert."
    );
  }
  if (Number.isFinite(heatGeneratedKWh) && heatGeneratedKWh < 0) {
    throw httpError(502, "Die gelieferte Wärmemenge ist ungültig.");
  }

  const safeOptional = value =>
    Number.isFinite(value) && value >= 0 ? round(value, 3) : null;
  const efficiency =
    electricityKWh > 0 && Number.isFinite(heatGeneratedKWh)
      ? heatGeneratedKWh / electricityKWh
      : null;

  return {
    month,
    electricityKWh: round(electricityKWh, 3),
    heatGeneratedKWh: safeOptional(heatGeneratedKWh),
    heatingElectricityKWh: safeOptional(heatingElectricityKWh),
    dhwElectricityKWh: safeOptional(dhwElectricityKWh),
    heatingHeatKWh: safeOptional(heatingHeatKWh),
    dhwHeatKWh: safeOptional(dhwHeatKWh),
    efficiency: Number.isFinite(efficiency) ? round(efficiency, 3) : null,
    source: "vaillant-official-adapter",
    estimated: source.estimated !== false,
    updatedAt: String(
      source.updatedAt ||
      payload?.updatedAt ||
      new Date().toISOString()
    ),
    schema: "eldehof-vaillant-month-v1"
  };
}

async function buildLivePayload(env) {
  const now = new Date();
  const token = await getToken(env);
  const contractId = await getContractId(env, token);
  const parts = berlinParts(now);
  const month = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
  const monthStartMs = Date.UTC(parts.year, parts.month - 1, 1);
  const queryStart = new Date(Math.min(monthStartMs - 24 * 3600000, now.getTime() - 30 * 24 * 3600000));
  const priceEnd = new Date(now.getTime() + 52 * 3600000);
  const consumptionQs = new URLSearchParams({
    startDate: queryStart.toISOString(),
    endDate: now.toISOString(),
    resolution: "HOUR"
  });

  const [consumptionPayload, pricePayload] = await Promise.all([
    ostromFetch(`/contracts/${encodeURIComponent(contractId)}/energy-consumption?${consumptionQs}`, token, env),
    fetchPrices(queryStart.toISOString(), priceEnd.toISOString(), env, token)
  ]);

  const consumption = extractArray(consumptionPayload).map(normalizeConsumption).filter(Boolean);
  const prices = extractArray(pricePayload).map(normalizePrice).filter(Boolean);
  const priceMap = new Map(prices.map(row => [intervalKey(row.date), row]));
  const combined = consumption.map(row => {
    const price = priceMap.get(intervalKey(row.date));
    return {
      date: row.date,
      kWh: row.kWh,
      totalCtPerKWh: price ? price.totalCtPerKWh : null,
      costEur: price ? round(row.kWh * price.totalCtPerKWh / 100, 5) : null
    };
  });

  const todayKey = berlinDateKey(now);
  const monthRows = combined.filter(row => berlinMonthKey(new Date(row.date)) === month);
  const todayRows = combined.filter(row => berlinDateKey(new Date(row.date)) === todayKey);
  const monthSummary = summarizeCombined(monthRows);
  const todaySummary = summarizeCombined(todayRows);
  const monthPrices = prices.filter(row => berlinMonthKey(new Date(row.date)) === month);
  const fixedCostEur = monthPrices.length
    ? number(monthPrices[0].monthlyOstromBaseFee) + number(monthPrices[0].monthlyGridFee)
    : 0;
  monthSummary.fixedCostEur = round(fixedCostEur, 2);
  monthSummary.totalCostEur = round(monthSummary.variableCostEur + fixedCostEur, 2);
  monthSummary.month = month;
  todaySummary.totalCostEur = todaySummary.variableCostEur;

  const nowHour = new Date(now); nowHour.setUTCMinutes(0, 0, 0);
  const upcoming = prices
    .filter(row => new Date(row.date).getTime() >= nowHour.getTime())
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 48);
  const average24 = averageNumber(upcoming.slice(0, 24).map(row => row.totalCtPerKWh));
  const windows = {};
  for (const hours of [2, 3, 4]) {
    const best = findCheapestWindow(upcoming, hours);
    const expensive = findMostExpensiveWindow(upcoming, hours);
    if (best) {
      best.savingCtPerKWh = round(Math.max(0, number(average24) - best.averageCtPerKWh), 3);
      if (expensive) {
        best.expensiveStart = expensive.start;
        best.expensiveEnd = expensive.end;
        best.expensiveAverageCtPerKWh = expensive.averageCtPerKWh;
        best.spreadCtPerKWh = round(Math.max(0, expensive.averageCtPerKWh - best.averageCtPerKWh), 3);
      }
      windows[String(hours)] = best;
    }
  }

  const latest = consumption.length
    ? consumption.reduce((a, b) => new Date(b.date) > new Date(a.date) ? b : a)
    : null;
  const recentCutoff = now.getTime() - 48 * 3600000;
  const recentIntervals = combined
    .filter(row => new Date(row.date).getTime() >= recentCutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    generatedAt: now.toISOString(),
    contractId,
    zipCode: clean(env.OSTROM_ZIP_CODE) || "19306",
    month,
    latestMeterAt: latest ? latest.date : null,
    currentPrice: currentPriceAt(prices, now),
    averageNext24CtPerKWh: round(number(average24), 3),
    priceForecast: upcoming,
    recentIntervals,
    windows,
    today: todaySummary,
    month: monthSummary,
    assistant: buildAssistantPayload({
      now,
      month,
      prices,
      upcoming,
      combined,
      monthRows,
      monthSummary,
      fixedCostEur
    })
  };
}



async function buildHistoryChunkPayload(env, startDate, endDate) {
  const startedAt = Date.now();
  const label = `${startDate.slice(0, 10)} bis ${endDate.slice(0, 10)}`;

  const token = await getToken(env, false, {
    timeoutMs: 10000,
    retries: 0,
    label: "Ostrom-Anmeldung für Analyseabschnitt"
  });
  const contractId = await getContractId(env, token, {
    timeoutMs: 10000,
    retries: 0,
    label: "Ostrom-Vertrag für Analyseabschnitt"
  });

  const qs = new URLSearchParams({
    startDate,
    endDate,
    resolution: "HOUR"
  });

  const [consumptionResult, priceResult] = await Promise.allSettled([
    ostromFetch(
      `/contracts/${encodeURIComponent(contractId)}/energy-consumption?${qs}`,
      token,
      env,
      {
        timeoutMs: 14000,
        retries: 0,
        label: `Smart-Meter-Daten ${label}`
      }
    ),
    fetchPrices(startDate, endDate, env, token, {
      timeoutMs: 14000,
      retries: 0,
      label: `Strompreise ${label}`
    })
  ]);

  if (consumptionResult.status !== "fulfilled") {
    throw consumptionResult.reason?.status
      ? consumptionResult.reason
      : httpError(
          504,
          `Smart-Meter-Daten für ${label} wurden nicht rechtzeitig geliefert.`
        );
  }

  const consumption = extractArray(consumptionResult.value)
    .map(normalizeConsumption)
    .filter(Boolean);
  const prices =
    priceResult.status === "fulfilled"
      ? extractArray(priceResult.value).map(normalizePrice).filter(Boolean)
      : [];

  if (!consumption.length) {
    throw httpError(
      422,
      `Ostrom hat für ${label} keine Smart-Meter-Werte zurückgegeben.`
    );
  }

  const priceMap = new Map(prices.map(row => [intervalKey(row.date), row]));
  const priceMeta = {};
  for (const price of prices) {
    const month = berlinMonthKey(new Date(price.date));
    if (!priceMeta[month]) {
      priceMeta[month] = {
        monthlyOstromBaseFee: number(price.monthlyOstromBaseFee),
        monthlyGridFee: number(price.monthlyGridFee)
      };
    }
  }

  const rows = consumption.map(row => {
    const price = priceMap.get(intervalKey(row.date));
    return {
      date: row.date,
      kWh: round(number(row.kWh), 6),
      totalCtPerKWh: price ? round(number(price.totalCtPerKWh), 4) : null,
      costEur: price
        ? round(number(row.kWh) * number(price.totalCtPerKWh) / 100, 6)
        : null
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    latestMeterAt: rows.at(-1)?.date || null,
    rows,
    priceMeta,
    diagnostics: {
      mode: "seven-day-chunk",
      durationMs: Date.now() - startedAt,
      consumptionIntervals: rows.length,
      priceIntervals: prices.length,
      priceAvailable: prices.length > 0,
      warning:
        priceResult.status === "rejected"
          ? safeText(
              priceResult.reason?.message ||
              "Preisdaten für diesen Abschnitt fehlen."
            )
          : ""
    }
  };
}

async function buildHistoryPayload(env, days) {
  const startedAt = Date.now();
  const totalDeadlineMs = historyTotalDeadlineMs(days);
  const deadlineAt = startedAt + totalDeadlineMs;
  const now = new Date();
  const end = now;
  const start = new Date(now.getTime() - days * 86400000);

  const token = await getToken(env, false, {
    timeoutMs: Math.min(10000, historyRemainingMs(deadlineAt, 10000)),
    retries: 0,
    label: "Ostrom-Anmeldung für Langzeitanalyse"
  });
  historyAssertTime(deadlineAt, "nach der Ostrom-Anmeldung");

  const contractId = await getContractId(env, token, {
    timeoutMs: Math.min(10000, historyRemainingMs(deadlineAt, 10000)),
    retries: 0,
    label: "Ostrom-Vertrag für Langzeitanalyse"
  });
  historyAssertTime(deadlineAt, "nach dem Vertragsabruf");

  const chunks = historyMonthChunks(start, end);
  const consumptionMap = new Map();
  const priceMap = new Map();
  const warnings = [];
  const stages = [];
  let successfulConsumptionChunks = 0;
  let successfulPriceChunks = 0;
  let processedChunks = 0;
  let deadlineReached = false;

  for (let index = 0; index < chunks.length; index++) {
    const remainingBeforeChunk = deadlineAt - Date.now();
    if (remainingBeforeChunk < 6500) {
      deadlineReached = true;
      warnings.push(
        `Gesamtzeitlimit nach ${processedChunks} von ${chunks.length} Monatsabschnitten erreicht.`
      );
      break;
    }

    const range = chunks[index];
    const label = historyRangeLabel(range);
    const stageStartedAt = Date.now();
    const qs = new URLSearchParams({
      startDate: range.startDate,
      endDate: range.endDate,
      resolution: "HOUR"
    });

    const consumptionBudget = Math.max(
      5000,
      Math.min(12000, remainingBeforeChunk - 2500)
    );
    const priceBudget = Math.max(
      5000,
      Math.min(12000, remainingBeforeChunk - 2500)
    );

    const [consumptionResult, priceResult] = await Promise.allSettled([
      ostromFetch(
        `/contracts/${encodeURIComponent(contractId)}/energy-consumption?${qs}`,
        token,
        env,
        {
          timeoutMs: consumptionBudget,
          retries: 0,
          label: `Smart-Meter-Daten ${label}`
        }
      ),
      fetchPrices(
        range.startDate,
        range.endDate,
        env,
        token,
        {
          timeoutMs: priceBudget,
          retries: 0,
          label: `Strompreise ${label}`
        }
      )
    ]);

    processedChunks++;
    let consumptionCount = 0;
    let priceCount = 0;

    if (consumptionResult.status === "fulfilled") {
      const rows = extractArray(consumptionResult.value)
        .map(normalizeConsumption)
        .filter(Boolean);
      consumptionCount = rows.length;
      if (rows.length) successfulConsumptionChunks++;
      for (const row of rows) consumptionMap.set(intervalKey(row.date), row);
    } else {
      warnings.push(
        `${label}: ${safeText(
          consumptionResult.reason?.message || "Smart-Meter-Daten nicht verfügbar"
        )}`
      );
    }

    if (priceResult.status === "fulfilled") {
      const rows = extractArray(priceResult.value)
        .map(normalizePrice)
        .filter(Boolean);
      priceCount = rows.length;
      if (rows.length) successfulPriceChunks++;
      for (const row of rows) priceMap.set(intervalKey(row.date), row);
    } else {
      warnings.push(
        `${label}: ${safeText(
          priceResult.reason?.message || "Preise nicht verfügbar"
        )}`
      );
    }

    stages.push({
      label,
      consumptionIntervals: consumptionCount,
      priceIntervals: priceCount,
      durationMs: Date.now() - stageStartedAt
    });

    if (Date.now() >= deadlineAt - 1500 && index < chunks.length - 1) {
      deadlineReached = true;
      warnings.push(
        `Gesamtzeitlimit nach ${processedChunks} von ${chunks.length} Monatsabschnitten erreicht.`
      );
      break;
    }
  }

  if (!consumptionMap.size) {
    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    throw httpError(
      504,
      `Die Langzeitanalyse wurde nach ${durationSeconds} Sekunden beendet, aber Ostrom hat keine Smart-Meter-Daten geliefert. ` +
      `${warnings.slice(0, 3).join(" • ") || "Bitte zunächst 30 Tage erneut versuchen."}`
    );
  }

  const consumption = [...consumptionMap.values()]
    .filter(row => new Date(row.date) >= start && new Date(row.date) <= end)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const prices = [...priceMap.values()]
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const combined = consumption.map(row => {
    const price = priceMap.get(intervalKey(row.date));
    return {
      date: row.date,
      kWh: row.kWh,
      totalCtPerKWh: price ? price.totalCtPerKWh : null,
      costEur: price ? round(row.kWh * price.totalCtPerKWh / 100, 6) : null
    };
  });

  const daily = historyDailySummaries(combined);
  const monthly = historyMonthlySummaries(combined, prices);
  const hourlyProfile = historyHourlyProfile(combined);
  const completeDays = daily.filter(
    day => day.intervals >= 20 && day.date < berlinDateKey(now)
  );
  const validHours = combined
    .map(row => number(row.kWh))
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const overall = summarizeCombined(combined);
  const baseLoadKWhPerHour = quantile(validHours, 0.10);
  const averagePrice =
    overall.weightedAverageCtPerKWh ||
    averageNumber(prices.map(row => row.totalCtPerKWh));
  const baseDaily = Number.isFinite(baseLoadKWhPerHour)
    ? baseLoadKWhPerHour * 24
    : null;
  const baseMonthly = Number.isFinite(baseDaily)
    ? baseDaily * 30.4375
    : null;
  const baseAnnual = Number.isFinite(baseDaily)
    ? baseDaily * 365
    : null;

  const highestConsumptionDay = completeDays.length
    ? completeDays.reduce((a, b) => b.totalKWh > a.totalKWh ? b : a)
    : null;
  const costCompleteDays = completeDays.filter(day => day.matchedIntervals >= 20);
  const mostExpensiveDay = costCompleteDays.length
    ? costCompleteDays.reduce(
        (a, b) => b.variableCostEur > a.variableCostEur ? b : a
      )
    : null;
  const cheapestDay = costCompleteDays.length
    ? costCompleteDays.reduce(
        (a, b) => b.variableCostEur < a.variableCostEur ? b : a
      )
    : null;

  return {
    generatedAt: now.toISOString(),
    contractId,
    daysRequested: days,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    latestMeterAt: consumption.at(-1)?.date || null,
    daily,
    monthly,
    hourlyProfile,
    summary: {
      ...overall,
      completeDays: completeDays.length,
      averageDailyKWh: round(
        number(averageNumber(completeDays.map(day => day.totalKWh))),
        3
      ),
      averageDailyCostEur: round(
        number(
          averageNumber(costCompleteDays.map(day => day.variableCostEur))
        ),
        2
      ),
      weekChangePercent: historyPeriodChange(completeDays, 7),
      monthChangePercent: historyPeriodChange(completeDays, 30),
      dataCoveragePercent: combined.length
        ? round(overall.matchedIntervals / combined.length * 100, 1)
        : 0,
      partial:
        warnings.length > 0 ||
        deadlineReached ||
        processedChunks < chunks.length
    },
    baseLoad: {
      kWhPerHour: Number.isFinite(baseLoadKWhPerHour)
        ? round(baseLoadKWhPerHour, 3)
        : null,
      kWhPerDay: Number.isFinite(baseDaily) ? round(baseDaily, 2) : null,
      kWhPerMonth: Number.isFinite(baseMonthly) ? round(baseMonthly, 1) : null,
      kWhPerYear: Number.isFinite(baseAnnual) ? round(baseAnnual, 0) : null,
      costPerMonthEur:
        Number.isFinite(baseMonthly) && Number.isFinite(averagePrice)
          ? round(baseMonthly * averagePrice / 100, 2)
          : null,
      costPerYearEur:
        Number.isFinite(baseAnnual) && Number.isFinite(averagePrice)
          ? round(baseAnnual * averagePrice / 100, 2)
          : null,
      method: "10. Perzentil der stündlichen Smart-Meter-Werte"
    },
    highlights: {
      highestConsumptionDay,
      mostExpensiveDay,
      cheapestDay
    },
    diagnostics: {
      mode: "total-deadline-partial",
      requestedChunks: chunks.length,
      processedChunks,
      successfulConsumptionChunks,
      successfulPriceChunks,
      durationMs: Date.now() - startedAt,
      totalDeadlineMs,
      deadlineReached,
      warnings: warnings.slice(0, 12),
      stages
    }
  };
}

function historyTotalDeadlineMs(days) {
  if (days <= 30) return 50000;
  if (days <= 90) return 85000;
  if (days <= 120) return 100000;
  if (days <= 180) return 135000;
  return 195000;
}

function historyRemainingMs(deadlineAt, fallbackMs) {
  return Math.max(3000, Math.min(fallbackMs, deadlineAt - Date.now() - 1500));
}

function historyAssertTime(deadlineAt, stage) {
  if (Date.now() >= deadlineAt - 1500) {
    throw httpError(
      504,
      `Gesamtzeitlimit der Langzeitanalyse ${stage} erreicht. Bitte erneut mit 30 Tagen starten.`
    );
  }
}

function historyRangeLabel(range) {
  const start = new Date(range.startDate);
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    month: "long",
    year: "numeric"
  }).format(start);
}

function historyMonthChunks(start, end) {
  const chunks = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor < end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const chunkStart = new Date(Math.max(start.getTime(), cursor.getTime()));
    const chunkEnd = new Date(Math.min(end.getTime(), next.getTime()));
    if (chunkEnd > chunkStart) chunks.push({ startDate: chunkStart.toISOString(), endDate: chunkEnd.toISOString() });
    cursor = next;
  }
  return chunks;
}

function berlinHour(date) {
  const part = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(date).find(item => item.type === "hour");
  return Number(part?.value || 0);
}

function historyDailySummaries(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = berlinDateKey(new Date(row.date));
    const value = map.get(key) || {
      date: key, totalKWh: 0, variableCostEur: 0, matchedKWh: 0,
      intervals: 0, matchedIntervals: 0, nightKWh: 0,
      peakHourlyKWh: 0, minimumHourlyKWh: null
    };
    const kWh = number(row.kWh);
    value.totalKWh += kWh;
    value.intervals += 1;
    value.peakHourlyKWh = Math.max(value.peakHourlyKWh, kWh);
    value.minimumHourlyKWh = value.minimumHourlyKWh === null ? kWh : Math.min(value.minimumHourlyKWh, kWh);
    const hour = berlinHour(new Date(row.date));
    if (hour < 6) value.nightKWh += kWh;
    if (Number.isFinite(row.costEur)) {
      value.variableCostEur += number(row.costEur);
      value.matchedKWh += kWh;
      value.matchedIntervals += 1;
    }
    map.set(key, value);
  }
  return [...map.values()].map(day => ({
    ...day,
    totalKWh: round(day.totalKWh, 3),
    variableCostEur: round(day.variableCostEur, 2),
    weightedAverageCtPerKWh: day.matchedKWh > 0 ? round(day.variableCostEur / day.matchedKWh * 100, 3) : null,
    nightKWh: round(day.nightKWh, 3),
    nightSharePercent: day.totalKWh > 0 ? round(day.nightKWh / day.totalKWh * 100, 1) : 0,
    peakHourlyKWh: round(day.peakHourlyKWh, 3),
    minimumHourlyKWh: Number.isFinite(day.minimumHourlyKWh) ? round(day.minimumHourlyKWh, 3) : null
  })).sort((a, b) => a.date.localeCompare(b.date));
}

function historyMonthlySummaries(rows, prices) {
  const map = new Map();
  for (const row of rows || []) {
    const key = berlinMonthKey(new Date(row.date));
    const value = map.get(key) || { month: key, totalKWh: 0, variableCostEur: 0, matchedKWh: 0, intervals: 0, matchedIntervals: 0, dayKeys: new Set() };
    const kWh = number(row.kWh);
    value.totalKWh += kWh;
    value.intervals += 1;
    value.dayKeys.add(berlinDateKey(new Date(row.date)));
    if (Number.isFinite(row.costEur)) {
      value.variableCostEur += number(row.costEur);
      value.matchedKWh += kWh;
      value.matchedIntervals += 1;
    }
    map.set(key, value);
  }
  const priceByMonth = new Map();
  for (const price of prices || []) {
    const key = berlinMonthKey(new Date(price.date));
    if (!priceByMonth.has(key)) priceByMonth.set(key, price);
  }
  return [...map.values()].map(month => {
    const price = priceByMonth.get(month.month);
    const fixedCostEur = price ? number(price.monthlyOstromBaseFee) + number(price.monthlyGridFee) : 0;
    return {
      month: month.month,
      totalKWh: round(month.totalKWh, 2),
      variableCostEur: round(month.variableCostEur, 2),
      fixedCostEur: round(fixedCostEur, 2),
      totalCostEur: round(month.variableCostEur + fixedCostEur, 2),
      weightedAverageCtPerKWh: month.matchedKWh > 0 ? round(month.variableCostEur / month.matchedKWh * 100, 3) : null,
      days: month.dayKeys.size,
      intervals: month.intervals,
      matchedIntervals: month.matchedIntervals,
      complete: month.intervals > 0 && month.intervals === month.matchedIntervals
    };
  }).sort((a, b) => a.month.localeCompare(b.month));
}

function historyHourlyProfile(rows) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, kWh: 0, costEur: 0, matchedKWh: 0, count: 0, matched: 0 }));
  for (const row of rows || []) {
    const bucket = buckets[berlinHour(new Date(row.date))];
    const kWh = number(row.kWh);
    bucket.kWh += kWh;
    bucket.count += 1;
    if (Number.isFinite(row.costEur)) {
      bucket.costEur += number(row.costEur);
      bucket.matchedKWh += kWh;
      bucket.matched += 1;
    }
  }
  return buckets.map(bucket => ({
    hour: bucket.hour,
    averageKWh: bucket.count ? round(bucket.kWh / bucket.count, 4) : 0,
    averageCtPerKWh: bucket.matchedKWh > 0 ? round(bucket.costEur / bucket.matchedKWh * 100, 3) : null,
    samples: bucket.count
  }));
}

function historyPeriodChange(days, periodLength) {
  if (!Array.isArray(days) || days.length < periodLength * 2) return null;
  const current = days.slice(-periodLength);
  const previous = days.slice(-periodLength * 2, -periodLength);
  const currentTotal = current.reduce((sum, day) => sum + number(day.totalKWh), 0);
  const previousTotal = previous.reduce((sum, day) => sum + number(day.totalKWh), 0);
  return previousTotal > 0 ? round((currentTotal - previousTotal) / previousTotal * 100, 1) : null;
}

function buildAssistantPayload({ now, month, prices, upcoming, combined, monthSummary, fixedCostEur }) {
  const pool = upcoming.slice(0, 24).filter(row => Number.isFinite(Number(row.totalCtPerKWh)));
  const current = currentPriceAt(prices, now) || pool[0] || null;
  const sortedPrices = pool.map(row => Number(row.totalCtPerKWh)).sort((a, b) => a - b);
  const averageNext24 = averageNumber(sortedPrices);
  const q25 = quantile(sortedPrices, 0.25);
  const q75 = quantile(sortedPrices, 0.75);
  const currentPrice = current ? Number(current.totalCtPerKWh) : null;
  let priceLevel = "yellow";
  if (Number.isFinite(currentPrice) && Number.isFinite(q25) && currentPrice <= q25) priceLevel = "green";
  else if (Number.isFinite(currentPrice) && Number.isFinite(q75) && currentPrice >= q75) priceLevel = "red";
  const cheaperThreshold = Number.isFinite(currentPrice)
    ? currentPrice - Math.max(1, Math.abs(currentPrice) * 0.10)
    : null;
  const nextCheaper = Number.isFinite(cheaperThreshold)
    ? pool.find(row => new Date(row.date).getTime() > now.getTime() && Number(row.totalCtPerKWh) <= cheaperThreshold)
    : null;

  const days = dailySummaries(combined);
  const todayKey = berlinDateKey(now);
  const completeDays = days.filter(day => day.date < todayKey && day.intervals >= 20);
  const monthDays = completeDays.filter(day => day.date.startsWith(month));
  const costDays = monthDays.filter(day => day.matchedIntervals >= 20);
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const averageDailyKWh = averageNumber(monthDays.map(day => day.totalKWh));
  const averageDailyCost = averageNumber(costDays.map(day => day.variableCostEur));
  const projectedKWh = Number.isFinite(averageDailyKWh)
    ? Math.max(number(monthSummary.totalKWh), averageDailyKWh * daysInMonth)
    : null;
  const projectedVariableCost = Number.isFinite(averageDailyCost)
    ? Math.max(number(monthSummary.variableCostEur), averageDailyCost * daysInMonth)
    : null;
  const projectedTotalCost = Number.isFinite(projectedVariableCost)
    ? projectedVariableCost + number(fixedCostEur)
    : null;
  const confidence = monthDays.length >= 14 ? "high" : monthDays.length >= 6 ? "medium" : monthDays.length >= 2 ? "low" : "insufficient";

  const latestDay = completeDays.at(-1) || null;
  const baselineRows = latestDay ? completeDays.slice(Math.max(0, completeDays.length - 8), -1) : [];
  const baselineKWh = averageNumber(baselineRows.map(day => day.totalKWh));
  let anomalyLevel = "insufficient";
  let differencePercent = null;
  let differenceKWh = null;
  if (latestDay && baselineRows.length >= 3 && Number.isFinite(baselineKWh) && baselineKWh > 0) {
    differenceKWh = latestDay.totalKWh - baselineKWh;
    differencePercent = differenceKWh / baselineKWh * 100;
    const threshold = Math.max(2, baselineKWh * 0.30);
    anomalyLevel = differenceKWh > threshold ? "high" : differenceKWh < -threshold ? "low" : "normal";
  }

  const recentHours = combined
    .filter(row => new Date(row.date).getTime() >= now.getTime() - 48 * 3600000)
    .filter(row => Number.isFinite(Number(row.kWh)));
  const peakHour = recentHours.length
    ? recentHours.reduce((a, b) => Number(b.kWh) > Number(a.kWh) ? b : a)
    : null;

  return {
    priceSignal: {
      level: priceLevel,
      currentCtPerKWh: Number.isFinite(currentPrice) ? round(currentPrice, 3) : null,
      averageNext24CtPerKWh: Number.isFinite(averageNext24) ? round(averageNext24, 3) : null,
      cheapestNext24CtPerKWh: sortedPrices.length ? round(sortedPrices[0], 3) : null,
      mostExpensiveNext24CtPerKWh: sortedPrices.length ? round(sortedPrices.at(-1), 3) : null,
      nextCheaperAt: nextCheaper?.date || null,
      nextCheaperCtPerKWh: nextCheaper ? round(Number(nextCheaper.totalCtPerKWh), 3) : null
    },
    monthForecast: {
      month,
      completeDays: monthDays.length,
      daysInMonth,
      averageDailyKWh: Number.isFinite(averageDailyKWh) ? round(averageDailyKWh, 3) : null,
      projectedKWh: Number.isFinite(projectedKWh) ? round(projectedKWh, 1) : null,
      projectedVariableCostEur: Number.isFinite(projectedVariableCost) ? round(projectedVariableCost, 2) : null,
      projectedTotalCostEur: Number.isFinite(projectedTotalCost) ? round(projectedTotalCost, 2) : null,
      confidence
    },
    dailyAnomaly: {
      level: anomalyLevel,
      date: latestDay?.date || null,
      latestKWh: latestDay ? round(latestDay.totalKWh, 2) : null,
      baselineKWh: Number.isFinite(baselineKWh) ? round(baselineKWh, 2) : null,
      baselineDays: baselineRows.length,
      differenceKWh: Number.isFinite(differenceKWh) ? round(differenceKWh, 2) : null,
      differencePercent: Number.isFinite(differencePercent) ? round(differencePercent, 1) : null
    },
    peakHour: peakHour ? { date: peakHour.date, kWh: round(Number(peakHour.kWh), 3) } : null
  };
}

function dailySummaries(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = berlinDateKey(new Date(row.date));
    const value = map.get(key) || { date: key, totalKWh: 0, variableCostEur: 0, intervals: 0, matchedIntervals: 0 };
    value.totalKWh += number(row.kWh);
    value.intervals += 1;
    if (Number.isFinite(row.costEur)) {
      value.variableCostEur += number(row.costEur);
      value.matchedIntervals += 1;
    }
    map.set(key, value);
  }
  return [...map.values()]
    .map(day => ({ ...day, totalKWh: round(day.totalKWh, 4), variableCostEur: round(day.variableCostEur, 4) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function quantile(sortedValues, q) {
  if (!Array.isArray(sortedValues) || !sortedValues.length) return null;
  const position = (sortedValues.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sortedValues[base + 1];
  return next === undefined ? sortedValues[base] : sortedValues[base] + rest * (next - sortedValues[base]);
}

function summarizeCombined(rows) {
  let totalKWh = 0, matchedKWh = 0, variableCostEur = 0, matchedIntervals = 0;
  for (const row of rows) {
    totalKWh += number(row.kWh);
    if (Number.isFinite(row.costEur)) {
      matchedKWh += number(row.kWh);
      variableCostEur += row.costEur;
      matchedIntervals++;
    }
  }
  return {
    totalKWh: round(totalKWh, 3),
    variableCostEur: round(variableCostEur, 2),
    weightedAverageCtPerKWh: matchedKWh > 0 ? round(variableCostEur / matchedKWh * 100, 3) : 0,
    consumptionIntervals: rows.length,
    matchedIntervals,
    complete: rows.length > 0 && rows.length === matchedIntervals
  };
}

function findCheapestWindow(rows, hours) {
  if (!Array.isArray(rows) || rows.length < hours) return null;
  let best = null;
  for (let i = 0; i <= rows.length - hours; i++) {
    const slice = rows.slice(i, i + hours);
    let consecutive = true;
    for (let j = 1; j < slice.length; j++) {
      if (new Date(slice[j].date).getTime() - new Date(slice[j - 1].date).getTime() !== 3600000) {
        consecutive = false; break;
      }
    }
    if (!consecutive) continue;
    const averageCtPerKWh = averageNumber(slice.map(row => row.totalCtPerKWh));
    if (!Number.isFinite(averageCtPerKWh)) continue;
    const candidate = {
      start: slice[0].date,
      end: new Date(new Date(slice.at(-1).date).getTime() + 3600000).toISOString(),
      hours,
      averageCtPerKWh: round(averageCtPerKWh, 3)
    };
    if (!best || candidate.averageCtPerKWh < best.averageCtPerKWh) best = candidate;
  }
  return best;
}


function findMostExpensiveWindow(rows, hours) {
  if (!Array.isArray(rows) || rows.length < hours) return null;
  let worst = null;
  for (let i = 0; i <= rows.length - hours; i++) {
    const slice = rows.slice(i, i + hours);
    let consecutive = true;
    for (let j = 1; j < slice.length; j++) {
      if (new Date(slice[j].date).getTime() - new Date(slice[j - 1].date).getTime() !== 3600000) {
        consecutive = false; break;
      }
    }
    if (!consecutive) continue;
    const averageCtPerKWh = averageNumber(slice.map(row => row.totalCtPerKWh));
    if (!Number.isFinite(averageCtPerKWh)) continue;
    const candidate = {
      start: slice[0].date,
      end: new Date(new Date(slice.at(-1).date).getTime() + 3600000).toISOString(),
      hours,
      averageCtPerKWh: round(averageCtPerKWh, 3)
    };
    if (!worst || candidate.averageCtPerKWh > worst.averageCtPerKWh) worst = candidate;
  }
  return worst;
}

function currentPriceAt(prices, now) {
  const timestamp = now.getTime();
  const row = prices.find(item => {
    const start = new Date(item.date).getTime();
    return start <= timestamp && timestamp < start + 3600000;
  });
  return row || null;
}

function averageNumber(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function berlinParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function berlinDateKey(date) {
  const p = berlinParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function berlinMonthKey(date) {
  const p = berlinParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

async function getToken(env, forceRefresh = false, options = {}) {
  const clientId = clean(env.OSTROM_CLIENT_ID);
  const clientSecret = clean(env.OSTROM_CLIENT_SECRET);

  if (!clientId || !clientSecret) {
    throw httpError(500, "Ostrom-Secrets fehlen.");
  }

  if (!forceRefresh && tokenCache.value && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.value;
  }

  const endpoints = ostromEndpoints(env);
  const basicPayload = base64Utf8(`${clientId}:${clientSecret}`);
  const authorization = `Basic ${basicPayload}`;

  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("authorization", authorization);
  headers.set("content-type", "application/x-www-form-urlencoded");

  const authRequest = new Request(endpoints.auth, {
    method: "POST",
    headers,
    body: "grant_type=client_credentials"
  });

  const authorizationBeforeFetch = authRequest.headers.get("authorization") || "";
  const headerFingerprint = await sha256Short(authorizationBeforeFetch);

  let response;
  let tokenRaw = "";
  let tokenPayload = {};
  try {
    const tokenResult = await fetchJsonWithTimeout(authRequest, {}, {
      timeoutMs: options.timeoutMs || 15000,
      retries: options.retries ?? 1,
      label: options.label || "Ostrom-Anmeldung"
    });
    response = tokenResult.response;
    tokenRaw = tokenResult.raw;
    tokenPayload = tokenResult.payload;
  } catch (error) {
    throw httpError(
      502,
      [
        "Cloudflare konnte den Ostrom-Token-Endpunkt nicht aufrufen",
        safeText(error?.message || String(error)),
        `Eldehof-Build: ${ELDEHOF_BUILD}`,
        `Header vor fetch: ${authorizationBeforeFetch.startsWith("Basic ") ? "vorhanden" : "fehlt"}`,
        `Client-ID-Länge: ${clientId.length}`,
        `Secret-Länge: ${clientSecret.length}`,
        `Basic-Länge: ${basicPayload.length}`,
        `Header-Fingerabdruck: ${headerFingerprint}`,
        `Ziel: ${endpoints.auth}`
      ].join(" • ")
    );
  }

  const raw = tokenRaw;
  const payload = tokenPayload;

  if (response.ok && payload.access_token) {
    tokenCache = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 3600)) * 1000
    };
    return tokenCache.value;
  }

  const errorName = safeText(payload.error || payload.type);
  const description = safeText(
    payload.error_description || payload.detail || payload.message || raw
  );
  const authChallenge = safeText(response.headers.get("www-authenticate") || "");
  const cfRay = safeText(response.headers.get("cf-ray") || "");
  const server = safeText(response.headers.get("server") || "");

  const diagnostics = [
    `Ostrom-Anmeldung fehlgeschlagen (${response.status})`,
    errorName,
    description,
    authChallenge ? `Serverhinweis: ${authChallenge}` : "",
    `Eldehof-Build: ${ELDEHOF_BUILD}`,
    `Header vor fetch: ${authorizationBeforeFetch.startsWith("Basic ") ? "vorhanden" : "fehlt"}`,
    `Client-ID-Länge: ${clientId.length}`,
    `Secret-Länge: ${clientSecret.length}`,
    `Basic-Länge: ${basicPayload.length}`,
    `Header-Fingerabdruck: ${headerFingerprint}`,
    `Antwort-URL: ${response.url || endpoints.auth}`,
    server ? `Server: ${server}` : "",
    cfRay ? `CF-Ray: ${cfRay}` : "",
    `Umgebung: ${endpoints.mode}`
  ].filter(Boolean).join(" • ");

  throw httpError(response.status || 502, diagnostics);
}

async function sha256Short(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function getContractId(env, token, options = {}) {
  const configuredContract = clean(env.OSTROM_CONTRACT_ID);
  if (configuredContract) return configuredContract;

  if (contractCache.value && contractCache.expiresAt > Date.now()) {
    return contractCache.value;
  }

  let payload;
  try {
    payload = await ostromFetch("/contracts", token, env, options);
  } catch (error) {
    if (error.status === 404) {
      throw httpError(
        422,
        "Ostrom-Anmeldung erfolgreich, aber die Vertragsliste ist für diesen API-Client nicht verfügbar. Lege deine Ostrom-Vertragsnummer in Cloudflare als Secret OSTROM_CONTRACT_ID an."
      );
    }
    throw error;
  }

  const contracts = extractArray(payload);
  if (!contracts.length) {
    throw httpError(
      422,
      "Ostrom-Anmeldung erfolgreich, aber kein Vertrag wurde zurückgegeben. Lege deine Vertragsnummer in Cloudflare als Secret OSTROM_CONTRACT_ID an."
    );
  }
  if (contracts.length > 1) {
    throw httpError(
      409,
      "Mehrere Ostrom-Verträge gefunden. Lege den gewünschten Vertrag als Secret OSTROM_CONTRACT_ID fest."
    );
  }

  const id = contracts[0].id || contracts[0].contractId || contracts[0].contractNumber || contracts[0].uuid;
  if (!id) {
    throw httpError(
      422,
      "Die Ostrom-Antwort enthält keine erkennbare Vertragsnummer. Lege OSTROM_CONTRACT_ID in Cloudflare manuell fest."
    );
  }

  contractCache = { value: String(id), expiresAt: Date.now() + 21600000 };
  return contractCache.value;
}

async function buildClimateArchive(year,env){
  // Kronskamp near Neustadt-Glewe: fixed coordinates, no unreliable zip geocoding.
  const zip="19306";
  const location={latitude:53.40209,longitude:11.58641,name:"Kronskamp",timezone:"Europe/Berlin"};
  const now=new Date();
  const end=year===now.getUTCFullYear()?new Date(Date.now()-7*864e5).toISOString().slice(0,10):year+"-12-31";
  const u=new URL("https://archive-api.open-meteo.com/v1/archive");
  for(const [k,v] of Object.entries({latitude:location.latitude,longitude:location.longitude,start_date:year+"-01-01",end_date:end,daily:"temperature_2m_mean",timezone:"Europe/Berlin",models:"era5_land"}))u.searchParams.set(k,String(v));
  const r=await fetchJsonWithTimeout(u.toString(),{headers:{accept:"application/json"}},{timeoutMs:20000,retries:1,label:"Wetterarchiv"});
  if(!r.response.ok)throw httpError(502,"Wetterhistorie konnte nicht geladen werden.");
  const days=r.payload?.daily?.time||[],temps=r.payload?.daily?.temperature_2m_mean||[],group=new Map();
  for(let i=0;i<days.length;i++){
    const key=String(days[i]).slice(0,7),temp=Number(temps[i]);
    if(!/^\d{4}-\d{2}$/.test(key)||!Number.isFinite(temp))continue;
    if(!group.has(key))group.set(key,{month:key,days:0,sum:0,hdd15:0});
    const x=group.get(key);
    x.days++;x.sum+=temp;x.hdd15+=Math.max(0,15-temp);
  }
  const months=[...group.values()].map(x=>({month:x.month,days:x.days,complete:x.days===new Date(Number(x.month.slice(0,4)),Number(x.month.slice(5,7)),0).getDate(),meanTemp:round(x.sum/x.days,2),hdd15:round(x.hdd15,2)}));
  return {year,provider:"Open-Meteo",model:"ERA5-Land",location:zip,baseTempC:15,cachedAt:new Date().toISOString(),complete:year<now.getUTCFullYear()&&months.length===12&&months.every(x=>x.complete),months};
}
async function buildWeatherPayload(env) {
  const postalCode = clean(env.OSTROM_ZIP_CODE) || "19306";
  // Consistent, fixed weather location for Eldehof and all reference years.
  const location={name:"Kronskamp",admin1:"Mecklenburg-Vorpommern",latitude:53.40209,longitude:11.58641,timezone:"Europe/Berlin"};
  const latitude=location.latitude,longitude=location.longitude;

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(latitude));
  forecastUrl.searchParams.set("longitude", String(longitude));
  forecastUrl.searchParams.set(
    "hourly",
    "temperature_2m,precipitation_probability,weather_code"
  );
  forecastUrl.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code"
  );
  forecastUrl.searchParams.set("timezone", "Europe/Berlin");
  forecastUrl.searchParams.set("forecast_days", "3");
  const forecast = await fetchJsonWithTimeout(
    forecastUrl.toString(),
    { headers: { accept: "application/json" } },
    { timeoutMs: 15000, retries: 1, label: "Wettervorhersage" }
  );
  if (!forecast.response.ok) {
    throw httpError(forecast.response.status, "Die Wettervorhersage konnte nicht geladen werden.");
  }

  const hourlyTimes = Array.isArray(forecast.payload?.hourly?.time)
    ? forecast.payload.hourly.time
    : [];
  const hourlyTemperatures = forecast.payload?.hourly?.temperature_2m || [];
  const hourlyRain = forecast.payload?.hourly?.precipitation_probability || [];
  const hourlyCodes = forecast.payload?.hourly?.weather_code || [];
  const hourly = hourlyTimes.map((time, index) => ({
    time,
    temperatureC: Number.isFinite(Number(hourlyTemperatures[index]))
      ? Number(hourlyTemperatures[index])
      : null,
    precipitationProbability: Number.isFinite(Number(hourlyRain[index]))
      ? Number(hourlyRain[index])
      : null,
    weatherCode: Number.isFinite(Number(hourlyCodes[index]))
      ? Number(hourlyCodes[index])
      : null
  }));

  const dailyTimes = Array.isArray(forecast.payload?.daily?.time)
    ? forecast.payload.daily.time
    : [];
  const highs = forecast.payload?.daily?.temperature_2m_max || [];
  const lows = forecast.payload?.daily?.temperature_2m_min || [];
  const rainMax = forecast.payload?.daily?.precipitation_probability_max || [];
  const dailyCodes = forecast.payload?.daily?.weather_code || [];
  const daily = dailyTimes.map((date, index) => ({
    date,
    temperatureMaxC: Number.isFinite(Number(highs[index]))
      ? Number(highs[index])
      : null,
    temperatureMinC: Number.isFinite(Number(lows[index]))
      ? Number(lows[index])
      : null,
    precipitationProbabilityMax: Number.isFinite(Number(rainMax[index]))
      ? Number(rainMax[index])
      : null,
    weatherCode: Number.isFinite(Number(dailyCodes[index]))
      ? Number(dailyCodes[index])
      : null
  }));

  return {
    generatedAt: new Date().toISOString(),
    provider: "Open-Meteo",
    postalCode,
    location: {
      name: safeText(location?.name || postalCode),
      admin1: safeText(location?.admin1 || ""),
      latitude,
      longitude,
      timezone: safeText(location?.timezone || "Europe/Berlin")
    },
    hourly,
    daily
  };
}

async function fetchPrices(startDate, endDate, env, token, options = {}) {
  const qs = new URLSearchParams({
    startDate,
    endDate,
    resolution: "HOUR",
    zip: clean(env.OSTROM_ZIP_CODE) || "19306"
  });
  const result = await fetchJsonWithTimeout(
    `${ostromEndpoints(env).api}/spot-prices?${qs}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`
      }
    },
    {
      timeoutMs: options.timeoutMs || 18000,
      retries: options.retries ?? 1,
      label: options.label || "Ostrom-Preise"
    }
  );
  if (!result.response.ok) {
    const detail = safeText(result.payload.error_description || result.payload.message || result.payload.error);
    throw httpError(
      result.response.status,
      `Ostrom-Preise konnten nicht geladen werden (${result.response.status})${detail ? ` • ${detail}` : ""}.`
    );
  }
  return result.payload;
}

async function ostromFetch(path, token, env, options = {}) {
  const result = await fetchJsonWithTimeout(
    `${ostromEndpoints(env).api}${path}`,
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }
    },
    {
      timeoutMs: options.timeoutMs || 22000,
      retries: options.retries ?? 1,
      label: options.label || "Ostrom-API"
    }
  );
  if (!result.response.ok) {
    const detail = safeText(result.payload.error_description || result.payload.message || result.payload.error);
    throw httpError(result.response.status, `Ostrom-API-Fehler (${result.response.status})${detail ? ` • ${detail}` : ""}.`);
  }
  return result.payload;
}

async function fetchJsonWithTimeout(input, init = {}, options = {}) {
  const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 20000);
  const retries = Math.max(0, Math.min(2, Number(options.retries) || 0));
  const label = safeText(options.label || "Ostrom-Anfrage") || "Ostrom-Anfrage";
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let timer = null;

    const requestPromise = (async () => {
      try {
        const response = await fetch(input, {
          ...init,
          signal: controller.signal
        });
        const raw = await response.text();
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch {}
        return { response, raw, payload };
      } catch (error) {
        if (controller.signal.aborted) {
          throw httpError(
            504,
            `${label} hat nach ${Math.round(timeoutMs / 1000)} Sekunden nicht geantwortet.`
          );
        }
        throw httpError(
          502,
          `${label} konnte nicht geladen werden • ${safeText(
            error?.message || String(error)
          )}`
        );
      }
    })();

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { controller.abort(); } catch {}
        reject(
          httpError(
            504,
            `${label} wurde nach ${Math.round(timeoutMs / 1000)} Sekunden hart beendet.`
          )
        );
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([requestPromise, timeoutPromise]);

      if (
        (result.response.status === 429 || result.response.status >= 500) &&
        attempt < retries
      ) {
        await sleep(450 * (attempt + 1));
        continue;
      }
      return result;
    } catch (error) {
      lastError =
        error?.status
          ? error
          : httpError(
              502,
              `${label} konnte nicht geladen werden • ${safeText(
                error?.message || String(error)
              )}`
            );

      if (attempt < retries) {
        await sleep(450 * (attempt + 1));
        continue;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError || httpError(502, `${label} konnte nicht geladen werden.`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "items", "results", "contracts", "consumption", "prices"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function normalizePrice(raw) {
  const date = raw.date || raw.timestamp || raw.startDate || raw.startTime;
  if (!date || Number.isNaN(new Date(date).valueOf())) return null;
  const explicitTotal = firstNumber(raw.totalCtPerKWh, raw.grossTotalKwhPrice, raw.grossTotalPrice, raw.unitPrice);
  const energy = firstNumber(raw.grossKwhPrice, raw.grossEnergyPrice, raw.kwhPrice, raw.marketPrice);
  const taxes = firstNumber(raw.grossKwhTaxAndLevies, raw.taxAndLevies, raw.taxesAndLevies);
  const totalCtPerKWh = Number.isFinite(explicitTotal) ? explicitTotal : number(energy) + number(taxes);
  return {
    date: new Date(date).toISOString(),
    totalCtPerKWh: round(totalCtPerKWh, 4),
    energyCtPerKWh: round(number(energy), 4),
    taxesCtPerKWh: round(number(taxes), 4),
    monthlyOstromBaseFee: round(firstNumber(raw.grossMonthlyOstromBaseFee, raw.monthlyOstromBaseFee, 0), 2),
    monthlyGridFee: round(firstNumber(raw.grossMonthlyGridFees, raw.grossMonthlyGridFee, raw.monthlyGridFees, 0), 2)
  };
}

function normalizeConsumption(raw) {
  const date = raw.date || raw.timestamp || raw.startDate || raw.startTime;
  const kWh = firstNumber(raw.kWh, raw.kwh, raw.consumptionKWh, raw.consumption, raw.value);
  if (!date || !Number.isFinite(kWh) || Number.isNaN(new Date(date).valueOf())) return null;
  return { date: new Date(date).toISOString(), kWh };
}

function intervalKey(value) {
  const d = new Date(value);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function priceRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function monthRange(month) {
  const [year, m] = month.split("-").map(Number);
  return {
    startDate: new Date(Date.UTC(year, m - 1, 1)).toISOString(),
    endDate: new Date(Date.UTC(year, m, 1)).toISOString()
  };
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}
function safeText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
}
function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}
function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function round(value, digits) { const f = 10 ** digits; return Math.round((value + Number.EPSILON) * f) / f; }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

const EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjMuNCDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPGxpbmsgcmVsPSJpY29uIiBocmVmPSJpY29uLTE5Mi5wbmciPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0ic3R5bGVzLmNzcz92PTYuMy40Ij4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwLXNoZWxsIj4KICA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPgogICAgPGRpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPjxzcGFuIGNsYXNzPSJicmFuZC1tYXJrIj7ijII8L3NwYW4+PHNwYW4+RWxkZWhvZjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3VidGl0bGUiPlZlcmJyYXVjaHNidWNoPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJidWlsZC1waWxsIj42LjMuNDwvc3Bhbj4KICA8L2hlYWRlcj4KCiAgPG1haW4+CiAgICA8ZGl2IGlkPSJyZWNvdmVyeUJhbm5lciIgY2xhc3M9ImJhbm5lciB3YXJuaW5nIGhpZGRlbiIgcm9sZT0ic3RhdHVzIj4KICAgICAgPGRpdj48c3Ryb25nPkxva2FsZSBTaWNoZXJoZWl0c2tvcGllIGdlZnVuZGVuPC9zdHJvbmc+PHNwYW4+RGVyIG5vcm1hbGUgTW9uYXRzZGF0ZW5zcGVpY2hlciBpc3QgbGVlciwgYWJlciBlaW5lIGZyw7xoZXJlIGxva2FsZSBLb3BpZSBpc3Qgdm9yaGFuZGVuLjwvc3Bhbj48L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0icmVzdG9yZVNoYWRvd0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldpZWRlcmhlcnN0ZWxsZW48L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IGFjdGl2ZSIgaWQ9ImRhc2hib2FyZFZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGFzaGJvYXJkVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPsOcQkVSU0lDSFQ8L3NwYW4+PGgxIGlkPSJkYXNoYm9hcmRUaXRsZSI+VmVyYnJhdWNoIGF1ZiBlaW5lbiBCbGljazwvaDE+PHA+WsOkaGxlcnN0w6RuZGUsIFfDpHJtZXB1bXBlLCBPc3Ryb20tUHJlaXNlIHVuZCBLbGltYSBhdWYgZWluZW4gQmxpY2suPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJkYXNoYm9hcmRBZGRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBsYXRlc3QtcGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkxFVFpURVIgTU9OQVQ8L3NwYW4+PGgyIGlkPSJsYXRlc3RNb250aFRpdGxlIj5Ob2NoIGtlaW5lIE1vbmF0c3dlcnRlPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJlZGl0TGF0ZXN0QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QgaGlkZGVuIiB0eXBlPSJidXR0b24iPkJlYXJiZWl0ZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCIgaWQ9ImxhdGVzdE1ldHJpY3MiPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJjb21wYXJpc29uLWxpbmUiIGlkPSJsYXRlc3RDb21wYXJpc29uIj48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBvc3Ryb20tcGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPgogICAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+T1NUUk9NPC9zcGFuPjxoMj5QcmVpc8O8YmVyc2ljaHQ8L2gyPjxzbWFsbCBpZD0ib3N0cm9tU3RhdHVzIj5Ob2NoIG5pY2h0IGdlbGFkZW48L3NtYWxsPjwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBpZD0icmVmcmVzaE9zdHJvbUJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPkFrdHVhbGlzaWVyZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJvc3Ryb21TZXR1cEhpbnQiIGNsYXNzPSJlbXB0eS1zdGF0ZSBoaWRkZW4iPjxzdHJvbmc+T3N0cm9tIGlzdCBub2NoIG5pY2h0IGVpbmdlcmljaHRldC48L3N0cm9uZz48c3Bhbj5EZW4gRWxkZWhvZi1BcHAtU2NobMO8c3NlbCBmaW5kZXN0IGR1IHVudGVyIERhdGVuIOKGkiBPc3Ryb20uPC9zcGFuPjxidXR0b24gaWQ9ImdvT3N0cm9tU2V0dGluZ3NCdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5FaW5yaWNodGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ib3N0cm9tRGFzaGJvYXJkIiBjbGFzcz0ib3N0cm9tLWdyaWQiPgogICAgICAgICAgPGFydGljbGUgY2xhc3M9InByaWNlLWNhcmQgY3VycmVudCI+PHNwYW4+QWt0dWVsbGVyIFByZWlzPC9zcGFuPjxzdHJvbmcgaWQ9Im9zdHJvbUN1cnJlbnRQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21DdXJyZW50TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8YXJ0aWNsZSBjbGFzcz0icHJpY2UtY2FyZCBiZXN0Ij48c3BhbiBpZD0ib3N0cm9tQmVzdExhYmVsIj5CZXN0ZXMgWmVpdGZlbnN0ZXI8L3NwYW4+PHN0cm9uZyBpZD0ib3N0cm9tQmVzdFByaWNlIj7igJM8L3N0cm9uZz48c21hbGwgaWQ9Im9zdHJvbUJlc3RNZXRhIj7igJM8L3NtYWxsPjwvYXJ0aWNsZT4KICAgICAgICAgIDxhcnRpY2xlIGNsYXNzPSJwcmljZS1jYXJkIHdvcnN0Ij48c3BhbiBpZD0ib3N0cm9tV29yc3RMYWJlbCI+U2NobGVjaHRlc3RlcyBaZWl0ZmVuc3Rlcjwvc3Bhbj48c3Ryb25nIGlkPSJvc3Ryb21Xb3JzdFByaWNlIj7igJM8L3N0cm9uZz48c21hbGwgaWQ9Im9zdHJvbVdvcnN0TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBwcmljZS1jaGFydC13cmFwIj48Y2FudmFzIGlkPSJvc3Ryb21NaW5pQ2hhcnQiIGFyaWEtbGFiZWw9Ik9zdHJvbSBQcmVpc3ZlcmxhdWYiPjwvY2FudmFzPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgZGFzaGJvYXJkLWNoYXJ0LXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5WRVJMQVVGPC9zcGFuPjxoMj5HZXNhbXR2ZXJicmF1Y2g8L2gyPjwvZGl2PjxidXR0b24gY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiBkYXRhLW5hdj0iYW5hbHlzaXNWaWV3IiB0eXBlPSJidXR0b24iPkF1c3dlcnR1bmcgw7ZmZm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAiPjxjYW52YXMgaWQ9ImRhc2hib2FyZENvbnN1bXB0aW9uQ2hhcnQiIGFyaWEtbGFiZWw9Ikdlc2FtdHZlcmJyYXVjaCBkZXIgbGV0enRlbiBNb25hdGUiPjwvY2FudmFzPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgZGFzaGJvYXJkLWNsaW1hdGUtcGFuZWwiIGlkPSJkYXNoYm9hcmRDbGltYXRlUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPgogICAgICAgICAgPGRpdj4KICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImV5ZWJyb3ciPktMSU1BICZhbXA7IFfDhFJNRVBVTVBFPC9zcGFuPgogICAgICAgICAgICA8aDI+V2VsY2hlcyBKYWhyIHdhciB3w6RybWVyIOKAkyB1bmQgd2llIHZpZWwgU3Ryb20gYnJhdWNodGUgZGllIEhlaXp1bmc/PC9oMj4KICAgICAgICAgICAgPHNtYWxsPjIwMjQgLyAyMDI1IC8gMjAyNiDCtyBnbGVpY2hlIE1vbmF0ZSwgZ2xlaWNoZSBKYWhyZXNmYXJiZW48L3NtYWxsPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGlkPSJkYXNoYm9hcmRDbGltYXRlRGV0YWlsc0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPkRldGFpbGF1c3dlcnR1bmc8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQgY2xpbWF0ZS1jb3VwbGVkLWludHJvIj5EaWUgb2JlcmUgS3VydmUgemVpZ3QgZGllIEF1w59lbnRlbXBlcmF0dXIuIERpcmVrdCBkYXJ1bnRlciBzaWVoc3QgZHUgZGVuIDxzdHJvbmc+U3Ryb212ZXJicmF1Y2ggZsO8cnMgSGVpemVuPC9zdHJvbmc+IChvaG5lIFdhcm13YXNzZXIpLiBCZWlkZSBEaWFncmFtbWUgdmVyd2VuZGVuIGRpZXNlbGJlbiBNb25hdGUgdW5kIEphaHJlc2ZhcmJlbi48L3A+CiAgICAgICAgPGRpdiBpZD0iZGFzaGJvYXJkQ2xpbWF0ZUxlZ2VuZCIgY2xhc3M9ImNsaW1hdGUtY291cGxlZC1sZWdlbmQiIGFyaWEtbGFiZWw9IkphaHJlc2ZhcmJlbiI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXJhbmdlIiByb2xlPSJncm91cCIgYXJpYS1sYWJlbD0iWmVpdHJhdW0gZsO8ciBkZW4gSmFocmVzdmVyZ2xlaWNoIj4KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBkYXRhLWNsaW1hdGUtcGVyaW9kPSJoZWF0aW5nIiBjbGFzcz0iYWN0aXZlIiBhcmlhLXByZXNzZWQ9InRydWUiPkhlaXptb25hdGU8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBkYXRhLWNsaW1hdGUtcGVyaW9kPSJhbGwiIGFyaWEtcHJlc3NlZD0iZmFsc2UiPkdhbnplcyBKYWhyPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPHAgaWQ9ImRhc2hib2FyZENsaW1hdGVZZWFyIiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXRpbWVmcmFtZSI+PC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImNsaW1hdGUtY291cGxlZC1wbG90Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNsaW1hdGUtY291cGxlZC10aXRsZSI+PHN0cm9uZz4xLiBBdcOfZW50ZW1wZXJhdHVyPC9zdHJvbmc+PHNwYW4+TW9uYXRzbWl0dGVsIMK3IMKwQyDCtyBlaW5oZWl0bGljaGUgV2V0dGVycXVlbGxlPC9zcGFuPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBjbGltYXRlLWNvdXBsZWQtY2hhcnQiPjxjYW52YXMgaWQ9ImRhc2hib2FyZENsaW1hdGVUZW1wZXJhdHVyZUNoYXJ0IiBhcmlhLWxhYmVsPSJBdcOfZW50ZW1wZXJhdHVyZW4gZGVyIFZlcmdsZWljaHNqYWhyZSI+PC9jYW52YXM+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXBsb3QiPgogICAgICAgICAgPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXRpdGxlIj48c3Ryb25nPjIuIEhlaXpzdHJvbSBkZXIgV8Okcm1lcHVtcGU8L3N0cm9uZz48c3Bhbj5rV2ggcHJvIE1vbmF0IMK3IG9obmUgV2FybXdhc3Nlcjwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgY2xpbWF0ZS1jb3VwbGVkLWNoYXJ0Ij48Y2FudmFzIGlkPSJkYXNoYm9hcmRDbGltYXRlRWxlY3RyaWNDaGFydCIgYXJpYS1sYWJlbD0iSGVpenN0cm9tYmVkYXJmIGRlciBXw6RybWVwdW1wZSBpbSBKYWhyZXN2ZXJnbGVpY2giPjwvY2FudmFzPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJjbGltYXRlLWNvdXBsZWQtbm90aWNlIj5KZSBow7ZoZXIgZGllIHp3ZWl0ZSBLdXJ2ZSwgZGVzdG8gbWVociBTdHJvbSBoYXQgZGllIFfDpHJtZXB1bXBlIGbDvHJzIEhlaXplbiBnZWJyYXVjaHQuIFRlbXBlcmF0dXIgdW5kIEhlaXpzdHJvbSB3ZXJkZW4gbmljaHQgYXVmIGRlcnNlbGJlbiBaYWhsZW5za2FsYSBkYXJnZXN0ZWxsdC4gRmVobGVuZGUgTW9uYXRlIGJsZWliZW4gbGVlci48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnkiIGlkPSJkYXNoYm9hcmRDbGltYXRlVHJlbmQiIHJvbGU9InN0YXR1cyI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZGFzaGJvYXJkLWNsaW1hdGUtbW9udGgtdGl0bGUiPk1vbmF0IGltIERldGFpbCA8c21hbGw+QW50aXBwZW46IFRlbXBlcmF0dXIsIFN0cm9tLCBXw6RybWUgdW5kIEhlaXotQ09QIGFsbGVyIEphaHJlPC9zbWFsbD48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJkYXNoYm9hcmRDbGltYXRlTW9udGhCdXR0b25zIiBjbGFzcz0iZGFzaGJvYXJkLWNsaW1hdGUtbW9udGhzIiByb2xlPSJncm91cCIgYXJpYS1sYWJlbD0iVmVyZ2xlaWNoc21vbmF0IGF1c3fDpGhsZW4iPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImRhc2hib2FyZENsaW1hdGVNb250aERldGFpbCIgY2xhc3M9ImNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwiIGFyaWEtbGl2ZT0icG9saXRlIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIiPgogICAgICAgICAgPHAgaWQ9ImRhc2hib2FyZENsaW1hdGVTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCIgcm9sZT0ic3RhdHVzIj48L3A+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJkYXNoYm9hcmQtY2xpbWF0ZS1hY3Rpb25zIj48YnV0dG9uIGlkPSJkYXNoYm9hcmRDbGltYXRlV2VhdGhlckJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldldHRlcmhpc3RvcmllIGxhZGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KICAgIDwvc2VjdGlvbj4KCiAgICA8c2VjdGlvbiBjbGFzcz0idmlldyIgaWQ9ImNvbnN1bXB0aW9uVmlldyIgYXJpYS1sYWJlbGxlZGJ5PSJjb25zdW1wdGlvblRpdGxlIj4KICAgICAgPGRpdiBjbGFzcz0icGFnZS1oZWFkIj4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5WRVJCUkFVQ0g8L3NwYW4+PGgxIGlkPSJjb25zdW1wdGlvblRpdGxlIj5Nb25hdHN3ZXJ0ZTwvaDE+PHA+R2VzYW10LSB1bmQgQWx0ZW50ZWlsLVZlcmJyYXVjaCBlbnRzdGVoZW4gYXVzIGRlbiBaw6RobGVyc3TDpG5kZW4uIFfDpHJtZXB1bXBlIGtvbW10IGF1cyBkZXIgbXlWQUlMTEFOVC1DU1Y7IFNjaGxlZS9LbHVzIHdpcmQgYXV0b21hdGlzY2ggYmVyZWNobmV0LjwvcD48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBpZD0iYWRkUmVjb3JkQnRuIiB0eXBlPSJidXR0b24iPisgWsOkaGxlcnN0w6RuZGU8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXRvb2xiYXIiPjxzdHJvbmcgaWQ9InJlY29yZENvdW50Ij4wIE1vbmF0ZTwvc3Ryb25nPjxzZWxlY3QgaWQ9InJlY29yZFllYXJGaWx0ZXIiIGFyaWEtbGFiZWw9IkphaHIgZmlsdGVybiI+PG9wdGlvbiB2YWx1ZT0iYWxsIj5BbGxlIEphaHJlPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0icmVjb3JkTGlzdCIgY2xhc3M9InJlY29yZC1saXN0Ij48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iYW5hbHlzaXNWaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImFuYWx5c2lzVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkFVU1dFUlRVTkc8L3NwYW4+PGgxIGlkPSJhbmFseXNpc1RpdGxlIj5WZXJicmF1Y2ggdmVyc3RlaGVuPC9oMT48cD5KYWhyZXN3ZXJ0ZSwgQXVmdGVpbHVuZywgS29zdGVuIHVuZCBXw6RybWVwdW1wZW4tRWZmaXppZW56LjwvcD48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBmaWx0ZXItcGFuZWwiPgogICAgICAgIDxsYWJlbD5EZXRhaWxqYWhyPHNlbGVjdCBpZD0iYW5hbHlzaXNZZWFyIj48L3NlbGVjdD48L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9ImFuYWx5c2lzLWFsbC15ZWFycy1oaW50Ij48c3Ryb25nPk1laHJqYWhyZXN2ZXJnbGVpY2g8L3N0cm9uZz48c3Bhbj5BbGxlIHZvcmhhbmRlbmVuIEphaHJlIHdlcmRlbiBnZW1laW5zYW0gZGFyZ2VzdGVsbHQuIFZlcmdhbmdlbmUgSmFocmUgZ2VzdHJpY2hlbHQsIGRhcyBha3R1ZWxsZSBKYWhyIGR1cmNoZ2V6b2dlbi48L3NwYW4+PC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9Im1ldHJpYy1ncmlkIGFuYWx5c2lzLW1ldHJpY3MiIGlkPSJhbmFseXNpc01ldHJpY3MiPjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5BVUZURUlMVU5HPC9zcGFuPjxoMj5Xw6RybWVwdW1wZSDCtyBBbHRlbnRlaWwgwrcgU2NobGVlL0tsdXM8L2gyPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImxlZ2VuZCI+PHNwYW4gY2xhc3M9ImhlYXQiPlfDpHJtZXB1bXBlPC9zcGFuPjxzcGFuIGNsYXNzPSJhbm5leCI+QWx0ZW50ZWlsPC9zcGFuPjxzcGFuIGNsYXNzPSJyZXN0Ij5TY2hsZWUvS2x1czwvc3Bhbj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJhbGxvY2F0aW9uQ2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5NRUhSSkFIUkVTVkVSR0xFSUNIPC9zcGFuPjxoMj5HZXNhbXR2ZXJicmF1Y2ggbmFjaCBNb25hdGVuPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGlkPSJ5ZWFyQ29tcGFyaXNvbkxlZ2VuZCIgY2xhc3M9InllYXItY29tcGFyaXNvbi1sZWdlbmQiPjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9InRvdGFsQ2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ib3N0cm9tUHJpY2VTdGF0c1BhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5PU1RST00tUFJFSVNFPC9zcGFuPjxoMj7DmCBrV2gtUHJlaXMgwrcgTW9uYXQgwrcgUXVhcnRhbCDCtyBKYWhyPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJyZWZyZXNoT3N0cm9tUHJpY2VTdGF0c0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPk9zdHJvbS1QcmVpc2UgYWt0dWFsaXNpZXJlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RGVyIEFyYmVpdHNwcmVpcyB3aXJkIGF1cyBkZW4gdm9uIE9zdHJvbSBnZWxpZWZlcnRlbiBTdHVuZGVucHJlaXNlbiB1bmQgZGVpbmVtIHRhdHPDpGNobGljaGVuIE9zdHJvbS1WZXJicmF1Y2ggdmVyYnJhdWNoc2dld2ljaHRldCBiZXJlY2huZXQuIFF1YXJ0YWxzLSB1bmQgSmFocmVzd2VydGUgc2luZCBkYWhlciBrZWluIGVpbmZhY2hlciBNaXR0ZWx3ZXJ0IGRlciBNb25hdGUuPC9wPgogICAgICAgIDxzZWN0aW9uIGNsYXNzPSJtZXRyaWMtZ3JpZCBhbmFseXNpcy1tZXRyaWNzIiBpZD0ib3N0cm9tUHJpY2VTdGF0c01ldHJpY3MiPjwvc2VjdGlvbj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJvc3Ryb21BdmVyYWdlUHJpY2VDaGFydCIgYXJpYS1sYWJlbD0iRHVyY2hzY2huaXR0bGljaGVyIE9zdHJvbS1BcmJlaXRzcHJlaXMgcHJvIE1vbmF0Ij48L2NhbnZhcz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPsOYIEFyYmVpdHNwcmVpczwvdGg+PHRoPkVmZmVrdGl2IGlua2wuIEZpeGtvc3RlbjwvdGg+PHRoPk9zdHJvbS1WZXJicmF1Y2g8L3RoPjx0aD5TdGF0dXM8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9Im9zdHJvbVByaWNlU3RhdHNUYWJsZSI+PC90Ym9keT48L3RhYmxlPjwvZGl2PgogICAgICAgIDxwIGlkPSJvc3Ryb21QcmljZVN0YXRzU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgPC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJjbGltYXRlQW5hbHlzaXNQYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+V0lUVEVSVU5HU0JFUkVJTklHVU5HPC9zcGFuPjxoMj5IZWl6d8Okcm1lICYgV2V0dGVyPC9oMj48L2Rpdj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgaWQ9ImxvYWRDbGltYXRlV2VhdGhlckJ0biIgdHlwZT0iYnV0dG9uIj5XZXR0ZXJkYXRlbiBsYWRlbjwvYnV0dG9uPjwvZGl2PjxwIGNsYXNzPSJtdXRlZCI+SGVpemdyYWR0YWdlIChCYXNpcyAxNSDCsEMpLCBnZXRyZW5udGUgSGVpei0gdW5kIFdhcm13YXNzZXJ3w6RybWUuIFZlcmdsZWljaCBqZSBLYWxlbmRlcm1vbmF0IG1pdCBkZW4gSGVpemdyYWR0YWdlbiB2b24gMjAyNCB1bmQgMjAyNS48L3A+PGRpdiBjbGFzcz0ibWV0cmljLWdyaWQgYW5hbHlzaXMtbWV0cmljcyIgaWQ9ImNsaW1hdGVNZXRyaWNzIj48L2Rpdj48ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPsOYIFdldHRlciDCsEM8L3RoPjx0aD5WYWlsbGFudCBhdcOfZW4gwrBDPC90aD48dGg+UmF1bSDCsEM8L3RoPjx0aD5TcGVpY2hlciDCsEM8L3RoPjx0aD5IR1Q8L3RoPjx0aD5IZWl6d8Okcm1lIGtXaDwvdGg+PHRoPldhcm13YXNzZXIga1doPC90aD48dGg+V2l0dGVydW5nc2JlcmVpbmlndCBrV2g8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImNsaW1hdGVSb3dzIj48L3Rib2R5PjwvdGFibGU+PC9kaXY+PHAgaWQ9ImNsaW1hdGVJbmZvIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD48ZGl2IGlkPSJjbGltYXRlTXVsdGlZZWFyIiBjbGFzcz0iY2xpbWF0ZS15ZWFyLWNvbXBhcmlzb24iPjwvZGl2Pjwvc2VjdGlvbj48c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPktPU1RFTjwvc3Bhbj48aDI+TW9uYXRsaWNoZSBTdHJvbWtvc3RlbjwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBsYXJnZSI+PGNhbnZhcyBpZD0iY29zdENoYXJ0Ij48L2NhbnZhcz48L2Rpdj48L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9ImNvcFBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5Xw4RSTUVQVU1QRTwvc3Bhbj48aDI+QXJiZWl0c3phaGw8L2gyPjwvZGl2PjwvZGl2PjxwIGNsYXNzPSJtdXRlZCI+V2lyZCBudXIgYXVzIE1vbmF0ZW4gbWl0IGRva3VtZW50aWVydGVyIGVyemV1Z3RlciBXw6RybWUgYmVyZWNobmV0LjwvcD48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJjb3BDaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1PTkFURTwvc3Bhbj48aDI+SmFocmVzw7xiZXJzaWNodDwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0idGFibGUtc2Nyb2xsIj48dGFibGU+PHRoZWFkPjx0cj48dGg+TW9uYXQ8L3RoPjx0aD5HZXNhbXQ8L3RoPjx0aD5XUDwvdGg+PHRoPkFsdGVudGVpbDwvdGg+PHRoPlNjaGxlZS9LbHVzPC90aD48dGg+S29zdGVuPC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJhbmFseXNpc1RhYmxlIj48L3Rib2R5PjwvdGFibGU+PC9kaXY+PC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iZGF0YVZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGF0YVRpdGxlIj4KICAgICAgPGRpdiBjbGFzcz0icGFnZS1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5EQVRFTjwvc3Bhbj48aDEgaWQ9ImRhdGFUaXRsZSI+QmFja3VwICYgRWluc3RlbGx1bmdlbjwvaDE+PHA+WsOkaGxlcnN0w6RuZGUsIG15VkFJTExBTlQtSW1wb3J0LCBTaWNoZXJ1bmcgdW5kIE9zdHJvbS48L3A+PC9kaXY+PC9kaXY+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkRBVEVOUVVBTElUw4RUPC9zcGFuPjxoMj5Nb25hdHN3ZXJ0ZSBwcsO8ZmVuPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBjb21wYWN0LW1ldHJpY3MiIGlkPSJxdWFsaXR5TWV0cmljcyI+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0icXVhbGl0eUlzc3VlcyIgY2xhc3M9Imlzc3VlLWxpc3QiPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ibWV0ZXJQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+WsOESExFUlNUw4ROREU8L3NwYW4+PGgyPkdlc2FtdCAmIEFsdGVudGVpbDwvaDI+PC9kaXY+PGJ1dHRvbiBpZD0iYWRkTWV0ZXJCdG4iIGNsYXNzPSJwcmltYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+KyBFaW50cmFnZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkR1IHRyw6Rnc3QgbnVyIGRpZSBiZWlkZW4gYWt0dWVsbGVuIFrDpGhsZXJzdMOkbmRlIGVpbi4gRWxkZWhvZiBiZXJlY2huZXQgZGFyYXVzIGF1dG9tYXRpc2NoIGRlbiBNb25hdHN2ZXJicmF1Y2guIEF1c2dhbmdzcHVua3QgaXN0IGRlciAwMS4xMC4yMDI2IG1pdCBHZXNhbXQgMzQuMjU1IGtXaCB1bmQgQWx0ZW50ZWlsIDkuMDQ1IGtXaC48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQgbWV0ZXItbGF0ZXN0IiBpZD0ibWV0ZXJMYXRlc3QiPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9Im1ldGVySGlzdG9yeSIgY2xhc3M9Im1ldGVyLWhpc3RvcnkiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3cgbWV0ZXItYWN0aW9ucyI+PGJ1dHRvbiBpZD0idW5kb0xhdGVzdE1ldGVyQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkxldHp0ZW4gWsOkaGxlcnN0YW5kIHp1csO8Y2tuZWhtZW48L2J1dHRvbj48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0idmFpbGxhbnRJbXBvcnRQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+V8OEUk1FUFVNUEU8L3NwYW4+PGgyPm15VkFJTExBTlQtRGF0ZW4gaW1wb3J0aWVyZW48L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+V8OkaGxlIGFyb1RIRVJNIHVuZCB1bmlUT1dFUiBnZW1laW5zYW0gb2RlciBkaWUgw6RsdGVyZSBFbGRlaG9mLU1vbmF0c2ltcG9ydC1DU1YuIERpZSBUZW1wZXJhdHVyZGF0ZWllbiBhdXMgU3lzdGVtLCBab25lIDAgdW5kIFdhcm13YXNzZXJzcGVpY2hlciBrw7ZubmVuIHp1c8OkdHpsaWNoIG9kZXIgZWluemVsbiBpbXBvcnRpZXJ0IHdlcmRlbi4gTnVyIE1vbmF0c2FnZ3JlZ2F0ZSB3ZXJkZW4gZ2VzcGVpY2hlcnQuIFrDpGhsZXJzdMOkbmRlIHVuZCBQcmVpc2UgYmxlaWJlbiB1bnZlcsOkbmRlcnQuPC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBwcmltYXJ5Ij5DU1YtRGF0ZWllbiBhdXN3w6RobGVuPGlucHV0IGlkPSJ2YWlsbGFudENzdkZpbGVzSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iLmNzdix0ZXh0L2Nzdix0ZXh0L3BsYWluIiBtdWx0aXBsZSBoaWRkZW4+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0idmFpbGxhbnRJbXBvcnRTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+Tm9jaCBrZWluZSBEYXRlaWVuIGF1c2dld8OkaGx0LjwvcD4KICAgICAgPC9zZWN0aW9uPgoKCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9InN5bmNQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+R0VSw4RURS1TWU5DPC9zcGFuPjxoMj5BdWYgYWxsZW4gR2Vyw6R0ZW4gYWt0dWVsbDwvaDI+PC9kaXY+PHNwYW4gaWQ9InN5bmNCYWRnZSIgY2xhc3M9InN5bmMtYmFkZ2UiPm5pY2h0IGVpbmdlcmljaHRldDwvc3Bhbj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkVsZGVob2Ygc3luY2hyb25pc2llcnQgTW9uYXRzd2VydGUsIFrDpGhsZXJzdMOkbmRlLCBpbXBvcnRpZXJ0ZSBWYWlsbGFudC1XZXJ0ZSB1bmQgYmVyZWNobmV0ZSBPc3Ryb20tS29zdGVuIHZlcnNjaGzDvHNzZWx0IMO8YmVyIGRlbiBiZXN0ZWhlbmRlbiBDbG91ZGZsYXJlLVRyZXNvci4gTmFjaCBlaW5lciDDhG5kZXJ1bmcgd2lyZCBhdXRvbWF0aXNjaCBob2NoZ2VsYWRlbjsgYmVpbSDDlmZmbmVuIG9kZXIgWnVyw7xja2tlaHJlbiBpbiBkaWUgQXBwIHdpcmQgYXV0b21hdGlzY2ggZGVyIG5ldWVzdGUgU3RhbmQgZ2VsYWRlbi48L3A+CiAgICAgICAgPGRpdiBpZD0ic3luY1NldHVwQm94Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5EaWVzZXMgR2Vyw6R0IGJlbmVubmVuPGlucHV0IGlkPSJzeW5jQ3JlYXRlRGV2aWNlTmFtZSIgdHlwZT0idGV4dCIgbWF4bGVuZ3RoPSI2MCIgcGxhY2Vob2xkZXI9InouIEIuIGlQYWQgS8O8Y2hlIj48L2xhYmVsPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzeW5jQ3JlYXRlQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5HZXLDpHRlLVN5bmMgZWlucmljaHRlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRldGFpbHMgY2xhc3M9InN5bmMtam9pbi1ib3giPjxzdW1tYXJ5PkRpZXNlcyBHZXLDpHQgbWl0IGJlc3RlaGVuZGVtIEVsZGVob2Yga29wcGVsbjwvc3VtbWFyeT4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+VHJlc29yLUlEPGlucHV0IGlkPSJzeW5jSm9pblZhdWx0SWQiIHR5cGU9InRleHQiIGF1dG9jb21wbGV0ZT0ib2ZmIj48L2xhYmVsPgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPktvcHBsdW5nc2NvZGU8aW5wdXQgaWQ9InN5bmNKb2luQ29kZSIgdHlwZT0idGV4dCIgYXV0b2NvbXBsZXRlPSJvbmUtdGltZS1jb2RlIiBwbGFjZWhvbGRlcj0iWFhYWC1YWFhYLVhYWFgiPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+V2llZGVyaGVyc3RlbGx1bmdzc2NobMO8c3NlbDx0ZXh0YXJlYSBpZD0ic3luY0pvaW5SZWNvdmVyeSIgcm93cz0iMyIgYXV0b2NvbXBsZXRlPSJvZmYiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5EaWVzZXMgR2Vyw6R0IGJlbmVubmVuPGlucHV0IGlkPSJzeW5jSm9pbkRldmljZU5hbWUiIHR5cGU9InRleHQiIG1heGxlbmd0aD0iNjAiIHBsYWNlaG9sZGVyPSJ6LiBCLiBpUGhvbmUiPjwvbGFiZWw+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8YnV0dG9uIGlkPSJzeW5jSm9pbkJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+R2Vyw6R0IGtvcHBlbG48L2J1dHRvbj4KICAgICAgICAgIDwvZGV0YWlscz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJzeW5jQWN0aXZlQm94IiBjbGFzcz0iaGlkZGVuIj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIHN5bmMtbWV0cmljcyI+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPkdlcsOkdDwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jRGV2aWNlVGV4dCI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJzeW5jUm9sZVRleHQiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgICA8YXJ0aWNsZT48c3Bhbj5UcmVzb3ItVmVyc2lvbjwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jUmV2aXNpb25UZXh0Ij4wPC9zdHJvbmc+PHNtYWxsIGlkPSJzeW5jTGFzdFRleHQiPm5vY2ggbmllPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPkF1dG9tYXRpazwvc3Bhbj48c3Ryb25nPmFrdGl2PC9zdHJvbmc+PHNtYWxsPmJlaSBBcHAtU3RhcnQsIFLDvGNra2VociB1bmQgbmFjaCDDhG5kZXJ1bmdlbjwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzeW5jTm93QnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5KZXR6dCBzeW5jaHJvbmlzaWVyZW48L2J1dHRvbj48YnV0dG9uIGlkPSJzeW5jUGFpckJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5OZXVlcyBHZXLDpHQga29wcGVsbjwvYnV0dG9uPjxidXR0b24gaWQ9InN5bmNEaXNjb25uZWN0QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkRpZXNlcyBHZXLDpHQgdHJlbm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRpdiBpZD0ic3luY1BhaXJSZXN1bHQiIGNsYXNzPSJzeW5jLXBhaXItcmVzdWx0IGhpZGRlbiI+PHN0cm9uZz5Lb3BwbHVuZ3NkYXRlbiBmw7xyIGRhcyBuZXVlIEdlcsOkdDwvc3Ryb25nPjxzcGFuPlRyZXNvci1JRDwvc3Bhbj48Y29kZSBpZD0ic3luY1BhaXJWYXVsdCI+4oCTPC9jb2RlPjxzcGFuPkNvZGUgKDEwIE1pbnV0ZW4pPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpckNvZGUiPuKAkzwvY29kZT48c3Bhbj5XaWVkZXJoZXJzdGVsbHVuZ3NzY2hsw7xzc2VsPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpclJlY292ZXJ5Ij7igJM8L2NvZGU+PHNtYWxsIGlkPSJzeW5jUGFpckV4cGlyeSI+PC9zbWFsbD48L2Rpdj4KICAgICAgICAgIDxwIGlkPSJzeW5jU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgICA8L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5TSUNIRVJVTkc8L3NwYW4+PGgyPlByaXZhdGVzIEJhY2t1cDwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EYXMgcHJpdmF0ZSBCYWNrdXAgZW50aMOkbHQgZGVpbmUgVmVyYnJhdWNoc2RhdGVuIHVuZCDigJMgc29mZXJuIGdlc3BlaWNoZXJ0IOKAkyBhdWNoIGRlbiBPc3Ryb20tQXBwLVNjaGzDvHNzZWwuIE5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbi48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRCYWNrdXBCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkJhY2t1cCBleHBvcnRpZXJlbjwvYnV0dG9uPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBzZWNvbmRhcnkiPkJhY2t1cCBpbXBvcnRpZXJlbjxpbnB1dCBpZD0iaW1wb3J0QmFja3VwSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iYXBwbGljYXRpb24vanNvbiwuanNvbiIgaGlkZGVuPjwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRDc3ZCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+Q1NWIGV4cG9ydGllcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPHAgaWQ9ImJhY2t1cFN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im9zdHJvbVNldHRpbmdzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0IHZlcmJpbmRlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+RWxkZWhvZi1BcHAtU2NobMO8c3NlbDxpbnB1dCBpZD0ib3N0cm9tQXBwS2V5SW5wdXQiIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9Im9mZiIgcGxhY2Vob2xkZXI9IkFwcC1TY2hsw7xzc2VsIj48L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+WmVpdGZlbnN0ZXI8c2VsZWN0IGlkPSJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0Ij48b3B0aW9uIHZhbHVlPSIxIj4xIFN0dW5kZTwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjIiPjIgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjMiPjMgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjQiPjQgU3R1bmRlbjwvb3B0aW9uPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InN3aXRjaC1yb3ciPjxpbnB1dCBpZD0ib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIgdHlwZT0iY2hlY2tib3giPjxzcGFuPkF1dG9tYXRpc2NoIGFsbGUgMTAgTWludXRlbiBha3R1YWxpc2llcmVuPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+PGJ1dHRvbiBpZD0ic2F2ZU9zdHJvbUJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuICYgcHLDvGZlbjwvYnV0dG9uPjxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21IaXN0b3J5QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkhpc3RvcmlzY2hlIFByZWlzZSBsYWRlbjwvYnV0dG9uPjxidXR0b24gaWQ9ImRpc2Nvbm5lY3RPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+VmVyYmluZHVuZyBlbnRmZXJuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBpZD0ib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgICAgPHAgaWQ9Im9zdHJvbUhpc3RvcnlTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+SGlzdG9yaXNjaGUgUHJlaXNlIG5vY2ggbmljaHQgZ2VwcsO8ZnQuPC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPktPU1RFTjwvc3Bhbj48aDI+RmFsbGJhY2stV2VydGU8L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QXJiZWl0c3ByZWlzIOKCrC9rV2g8aW5wdXQgaWQ9ImZhbGxiYWNrUHJpY2VJbnB1dCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+TW9uYXRsaWNoZSBGaXhrb3N0ZW4g4oKsPGlucHV0IGlkPSJkZWZhdWx0QmFzZUZlZUlucHV0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMSI+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJzYXZlQ29zdFNldHRpbmdzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPlNwZWljaGVybjwvYnV0dG9uPgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CiAgPC9tYWluPgoKICA8bmF2IGNsYXNzPSJib3R0b20tbmF2IiBhcmlhLWxhYmVsPSJIYXVwdG5hdmlnYXRpb24iPgogICAgPGJ1dHRvbiBjbGFzcz0iYWN0aXZlIiBkYXRhLW5hdj0iZGFzaGJvYXJkVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7ijII8L3NwYW4+w5xiZXJzaWNodDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iY29uc3VtcHRpb25WaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKWpDwvc3Bhbj5WZXJicmF1Y2g8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS1uYXY9ImFuYWx5c2lzVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7ilqU8L3NwYW4+QXVzd2VydHVuZzwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iZGF0YVZpZXciIHR5cGU9ImJ1dHRvbiI+PHNwYW4+4pqZPC9zcGFuPkRhdGVuPC9idXR0b24+CiAgPC9uYXY+CjwvZGl2PgoKPGRpdiBpZD0icmVjb3JkTW9kYWwiIGNsYXNzPSJtb2RhbCBoaWRkZW4iIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbGxlZGJ5PSJyZWNvcmRNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWw+PC9kaXY+CiAgPGZvcm0gY2xhc3M9Im1vZGFsLWNhcmQiIGlkPSJyZWNvcmRGb3JtIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1PTkFUIEJFQVJCRUlURU48L3NwYW4+PGgyIGlkPSJyZWNvcmRNb2RhbFRpdGxlIj5Nb25hdCBiZWFyYmVpdGVuPC9oMj48L2Rpdj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imljb24tYnV0dG9uIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPGlucHV0IGlkPSJlZGl0aW5nTW9udGhPcmlnaW5hbCIgdHlwZT0iaGlkZGVuIj4KICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPk1vbmF0PGlucHV0IGlkPSJyZWNvcmRNb250aCIgdHlwZT0ibW9udGgiIHJlYWRvbmx5PjwvbGFiZWw+CiAgICAgIDxzcGFuPjwvc3Bhbj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+R2VzYW10dmVyYnJhdWNoIGtXaDxpbnB1dCBpZD0icmVjb3JkVG90YWwiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIj48L2xhYmVsPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BbHRlbnRlaWwga1doPGlucHV0IGlkPSJyZWNvcmRBbm5leCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPlfDpHJtZXB1bXBlIGtXaDxpbnB1dCBpZD0icmVjb3JkSGVhdFB1bXAiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIj48L2xhYmVsPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj7DmCBTdHJvbXByZWlzIGN0L2tXaDxpbnB1dCBpZD0icmVjb3JkUHJpY2VDdCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkZpeGtvc3RlbiDigqw8aW5wdXQgaWQ9InJlY29yZEJhc2VGZWUiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9ImRlcml2ZWRQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5TY2hsZWUvS2x1czog4oCTPC9kaXY+CiAgICA8cCBpZD0icmVjb3JkU291cmNlSGludCIgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+PC9wPgogICAgPGRldGFpbHMgY2xhc3M9ImRldGFpbHMtY2FyZCI+PHN1bW1hcnk+V8Okcm1lcHVtcGVuLURldGFpbHMgKG9wdGlvbmFsKTwvc3VtbWFyeT48ZGl2IGNsYXNzPSJmb3JtLWdyaWQgZGV0YWlsLWdyaWQiPjxsYWJlbCBjbGFzcz0iZmllbGQiPkVyemV1Z3RlIFfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRHZW5lcmF0ZWQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48bGFiZWwgY2xhc3M9ImZpZWxkIj5IZWl6c3Ryb20ga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48bGFiZWwgY2xhc3M9ImZpZWxkIj5XYXJtd2Fzc2Vyc3Ryb20ga1doPGlucHV0IGlkPSJyZWNvcmREaHdFbGVjdHJpY2l0eSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPkhlaXp3w6RybWUga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0aW5nSGVhdCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPldhcm13YXNzZXJ3w6RybWUga1doPGlucHV0IGlkPSJyZWNvcmREaHdIZWF0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PC9kaXY+PC9kZXRhaWxzPgogICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+Tm90aXo8dGV4dGFyZWEgaWQ9InJlY29yZE5vdGUiIHJvd3M9IjMiIG1heGxlbmd0aD0iODAwIj48L3RleHRhcmVhPjwvbGFiZWw+CiAgICA8cCBpZD0icmVjb3JkVmFsaWRhdGlvbiIgY2xhc3M9InZhbGlkYXRpb24tdGV4dCI+PC9wPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+PHNwYW4gY2xhc3M9InNwYWNlciI+PC9zcGFuPjxidXR0b24gY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbD5BYmJyZWNoZW48L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJzdWJtaXQiPsOEbmRlcnVuZ2VuIHNwZWljaGVybjwvYnV0dG9uPjwvZGl2PgogIDwvZm9ybT4KPC9kaXY+Cgo8ZGl2IGlkPSJtZXRlck1vZGFsIiBjbGFzcz0ibW9kYWwgaGlkZGVuIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWxsZWRieT0ibWV0ZXJNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbD48L2Rpdj4KICA8Zm9ybSBjbGFzcz0ibW9kYWwtY2FyZCIgaWQ9Im1ldGVyRm9ybSI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDIgaWQ9Im1ldGVyTW9kYWxUaXRsZSI+TmV1ZSBBYmxlc3VuZzwvaDI+PC9kaXY+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJpY29uLWJ1dHRvbiIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPHAgaWQ9Im1ldGVyUHJldmlvdXMiIGNsYXNzPSJtZXRlci1wcmV2aW91cyI+PC9wPgogICAgPHAgaWQ9Im1ldGVyVGFyZ2V0TW9udGgiIGNsYXNzPSJtdXRlZCI+PC9wPgogICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QWJsZXNlZGF0dW08aW5wdXQgaWQ9Im1ldGVyRGF0ZSIgdHlwZT0iZGF0ZSIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgPHNwYW4+PC9zcGFuPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5HZXNhbXQtWsOkaGxlcnN0YW5kIGtXaDxpbnB1dCBpZD0ibWV0ZXJUb3RhbCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiIHJlcXVpcmVkPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkFsdGVudGVpbC1aw6RobGVyc3RhbmQga1doPGlucHV0IGlkPSJtZXRlckFubmV4IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0ibWV0ZXJQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5Nb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXV0b21hdGlzY2ggYmVyZWNobmV0LjwvZGl2PgogICAgPHAgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+RGllIFfDpHJtZXB1bXBlIHdpcmQgbmljaHQgaGllciBlaW5nZXRyYWdlbi4gU2llIGtvbW10IGF1c3NjaGxpZcOfbGljaCBhdXMgZGVtIG15VkFJTExBTlQtQ1NWLUltcG9ydC48L3A+CiAgICA8cCBpZD0ibWV0ZXJWYWxpZGF0aW9uIiBjbGFzcz0idmFsaWRhdGlvbi10ZXh0Ij48L3A+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj48c3BhbiBjbGFzcz0ic3BhY2VyIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iIGRhdGEtY2xvc2UtbWV0ZXItbW9kYWw+QWJicmVjaGVuPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgdHlwZT0ic3VibWl0Ij5aw6RobGVyc3TDpG5kZSBzcGVpY2hlcm48L2J1dHRvbj48L2Rpdj4KICA8L2Zvcm0+CjwvZGl2PgoKPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJ0b2FzdCBoaWRkZW4iIHJvbGU9InN0YXR1cyIgYXJpYS1saXZlPSJwb2xpdGUiPjwvZGl2Pgo8c2NyaXB0IHNyYz0iYXBwLmpzP3Y9Ni4zLjQiPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K","type":"text/html; charset=utf-8","cache":"no-cache"},"/styles.css":{"body":"OnJvb3R7CiAgY29sb3Itc2NoZW1lOmRhcms7CiAgLS1iZzojMDYxMDFjOwogIC0tcGFuZWw6IzBjMWEyYTsKICAtLXBhbmVsMjojMTAyMjM1OwogIC0tbGluZTpyZ2JhKDE3MSwxOTgsMjIwLC4xNCk7CiAgLS10ZXh0OiNmNGY4ZmI7CiAgLS1tdXRlZDojOTRhOGJhOwogIC0tZ3JlZW46IzcyZGM1NzsKICAtLW9yYW5nZTojZmY5ZjQzOwogIC0tYmx1ZTojNGQ5Y2ZmOwogIC0teWVsbG93OiNmMmQxNWY7CiAgLS1yZWQ6I2ZmNmI2YjsKICAtLXNoYWRvdzowIDE4cHggNTVweCByZ2JhKDAsMCwwLC4yNCk7CiAgLS1yYWRpdXM6MjBweDsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbHtiYWNrZ3JvdW5kOnZhcigtLWJnKTttaW4taGVpZ2h0OjEwMCU7Zm9udC1mYW1pbHk6SW50ZXIsLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixzYW5zLXNlcmlmOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQpib2R5e21hcmdpbjowO2JhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCB0b3AgcmlnaHQscmdiYSg2MCwxMjAsMTcwLC4xMCksdHJhbnNwYXJlbnQgMzUlKSx2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7bWluLWhlaWdodDoxMDB2aH0KYnV0dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXR9CmJ1dHRvbntjdXJzb3I6cG9pbnRlcn0KYnV0dG9uOmRpc2FibGVke29wYWNpdHk6LjQ4O2N1cnNvcjpub3QtYWxsb3dlZH0KLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQouYXBwLXNoZWxse21heC13aWR0aDoxMTgwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjAgMjJweCAxMTJweH0KLnRvcGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6Y2FsYygxNnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKSAwIDE4cHg7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MzA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQodG8gYm90dG9tLHJnYmEoNiwxNiwyOCwuOTgpLHJnYmEoNiwxNiwyOCwuODYpLHJnYmEoNiwxNiwyOCwwKSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCl9Ci5icmFuZHtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0Ojg1MDtsZXR0ZXItc3BhY2luZzotLjAzZW19LmJyYW5kLW1hcmt7ZGlzcGxheTppbmxpbmUtZ3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6MzZweDtoZWlnaHQ6MzZweDtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxZTYzMzMsIzJmOGU0OSk7Ym94LXNoYWRvdzowIDZweCAyNHB4IHJnYmEoNTMsMTkwLDkxLC4xOCl9Ci5zdWJ0aXRsZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWxlZnQ6NDZweDttYXJnaW4tdG9wOi00cHh9LmJ1aWxkLXBpbGx7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4xMik7Y29sb3I6I2I5ZjVhYTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTE0LDIyMCw4NywuMjIpO3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLXJhZGl1czo5OTlweH0KbWFpbntkaXNwbGF5OmJsb2NrfS52aWV3e2Rpc3BsYXk6bm9uZTthbmltYXRpb246ZmFkZSAuMThzIGVhc2V9LnZpZXcuYWN0aXZle2Rpc3BsYXk6YmxvY2t9QGtleWZyYW1lcyBmYWRle2Zyb217b3BhY2l0eTouNTt0cmFuc2Zvcm06dHJhbnNsYXRlWSg0cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5wYWdlLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDoyMnB4O21hcmdpbjoxOHB4IDAgMjRweH0ucGFnZS1oZWFkIGgxe2ZvbnQtc2l6ZTpjbGFtcCgyOHB4LDV2dyw0NHB4KTttYXJnaW46M3B4IDAgN3B4O2xpbmUtaGVpZ2h0OjEuMDU7bGV0dGVyLXNwYWNpbmc6LS4wNGVtfS5wYWdlLWhlYWQgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7bWF4LXdpZHRoOjY4MHB4O2xpbmUtaGVpZ2h0OjEuNX0uZXllYnJvd3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xNmVtO2ZvbnQtd2VpZ2h0Ojg1MDtjb2xvcjojN2Y5ZGI0O21hcmdpbi1ib3R0b206NXB4fQoucGFuZWx7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHJnYmEoMTUsMzEsNDgsLjk2KSxyZ2JhKDEwLDI0LDM5LC45OCkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjE4cHg7Ym94LXNoYWRvdzp2YXIoLS1zaGFkb3cpfQoucGFuZWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE4cHh9LnBhbmVsLWhlYWQgaDJ7bWFyZ2luOjJweCAwIDJweDtmb250LXNpemU6MjFweDtsZXR0ZXItc3BhY2luZzotLjAyNWVtfS5wYW5lbC1oZWFkIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0KLnByaW1hcnksLnNlY29uZGFyeSwuZGFuZ2VyLC5maWxlLWJ1dHRvbnthcHBlYXJhbmNlOm5vbmU7Ym9yZGVyLXJhZGl1czoxM3B4O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnQ7cGFkZGluZzoxMXB4IDE1cHg7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLXRleHQpO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjhweDt0ZXh0LWRlY29yYXRpb246bm9uZTttaW4taGVpZ2h0OjQ0cHh9LnByaW1hcnl7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyZjhlNDksIzFmNmMzOCk7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMjgpO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDQ0LDE2MSw3NywuMTgpfS5wcmltYXJ5OmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMDYpfS5zZWNvbmRhcnksLmZpbGUtYnV0dG9ue2JhY2tncm91bmQ6IzEyMjYzYTtib3JkZXItY29sb3I6cmdiYSgxNzAsMjAwLDIyNCwuMTQpO2NvbG9yOiNkY2U5ZjN9LnNlY29uZGFyeTpob3ZlciwuZmlsZS1idXR0b246aG92ZXJ7YmFja2dyb3VuZDojMTczMDQ5fS5kYW5nZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xMCk7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjI1KTtjb2xvcjojZmZhYWE5fS5jb21wYWN0e21pbi1oZWlnaHQ6MzZweDtwYWRkaW5nOjhweCAxMXB4O2ZvbnQtc2l6ZToxM3B4fS5pY29uLWJ1dHRvbntib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjOWQ3ZTI7Zm9udC1zaXplOjMwcHg7bGluZS1oZWlnaHQ6MTtwYWRkaW5nOjAgNnB4fQoubWV0cmljLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNSxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxNnB4O21pbi13aWR0aDowfS5tZXRyaWMtZ3JpZCBhcnRpY2xlIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbTo3cHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZTpjbGFtcCgxOXB4LDN2dywyNnB4KTtsaW5lLWhlaWdodDoxLjE7ZGlzcGxheTpibG9jazt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Lm1ldHJpYy1ncmlkIGFydGljbGUgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojN2Y5NmFhO2ZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NnB4O2xpbmUtaGVpZ2h0OjEuMzV9LmNvbXBhcmlzb24tbGluZXttYXJnaW46MTVweCAwIDA7Y29sb3I6I2I4YzhkNTtmb250LXNpemU6MTNweH0uY29tcGFyaXNvbi1saW5lLnBvc2l0aXZle2NvbG9yOiNmZmIxYTh9LmNvbXBhcmlzb24tbGluZS5uZWdhdGl2ZXtjb2xvcjojYTVlNjlhfS5jb21wYXJpc29uLWxpbmUubmV1dHJhbHtjb2xvcjojYjhjOGQ1fQoub3N0cm9tLXBhbmVse292ZXJmbG93OmhpZGRlbn0ub3N0cm9tLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ucHJpY2UtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMGIxYjJiO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MThweH0ucHJpY2UtY2FyZDpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowIGF1dG8gMCAwO3dpZHRoOjRweDtiYWNrZ3JvdW5kOiM2ZDg1OTl9LnByaWNlLWNhcmQuYmVzdDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ncmVlbil9LnByaWNlLWNhcmQud29yc3Q6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tcmVkKX0ucHJpY2UtY2FyZC5jdXJyZW50OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLWJsdWUpfS5wcmljZS1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9LnByaWNlLWNhcmQgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjI3cHg7bWFyZ2luOjhweCAwIDRweH0ucHJpY2UtY2FyZCBzbWFsbHtjb2xvcjojOWNiMGMwfS5lbXB0eS1zdGF0ZXtib3JkZXI6MXB4IGRhc2hlZCByZ2JhKDE3MCwyMDAsMjI0LC4yKTtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjAyKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6OXB4IDE0cHg7YWxpZ24taXRlbXM6Y2VudGVyfS5lbXB0eS1zdGF0ZSBzdHJvbmd7d2lkdGg6MTAwJX0uZW1wdHktc3RhdGUgc3Bhbntjb2xvcjp2YXIoLS1tdXRlZCk7ZmxleDoxO21pbi13aWR0aDoyMDBweH0ucHJpY2UtY2hhcnQtd3JhcHttYXJnaW4tdG9wOjE2cHh9Ci5jaGFydC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDoyNjBweDt3aWR0aDoxMDAlO21pbi13aWR0aDowfS5jaGFydC13cmFwLmxhcmdle2hlaWdodDozNDBweH0uY2hhcnQtd3JhcCBjYW52YXN7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtkaXNwbGF5OmJsb2NrfS5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjI2MHB4fS5sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNXB4O21hcmdpbjotNnB4IDAgMTRweDtjb2xvcjojYjhjNmQyO2ZvbnQtc2l6ZToxMnB4fS5sZWdlbmQgc3BhbjpiZWZvcmV7Y29udGVudDoiIjtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjNweDttYXJnaW4tcmlnaHQ6NnB4fS5sZWdlbmQgLmhlYXQ6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tb3JhbmdlKX0ubGVnZW5kIC5hbm5leDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ibHVlKX0ubGVnZW5kIC5yZXN0OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyl9Ci5yZWNvcmQtdG9vbGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MTRweH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0LC5maWx0ZXItcGFuZWwgc2VsZWN0e2JhY2tncm91bmQ6IzBiMWEyYTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEwcHggMTJweH0ucmVjb3JkLWxpc3R7ZGlzcGxheTpncmlkO2dhcDoxMHB4fS5yZWNvcmQtcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6bWlubWF4KDE1MHB4LDEuM2ZyKSByZXBlYXQoNCxtaW5tYXgoOTBweCwuODVmcikpIGF1dG87Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGExOTI4O2JvcmRlci1yYWRpdXM6MTVweDtwYWRkaW5nOjEzcHggMTRweH0ucmVjb3JkLXJvdzpob3ZlcntiYWNrZ3JvdW5kOiMwZTIwMzJ9LnJlY29yZC1tb250aCBzdHJvbmd7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTVweH0ucmVjb3JkLW1vbnRoIHNtYWxse2Rpc3BsYXk6YmxvY2s7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6M3B4fS5yZWNvcmQtdmFsdWUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOiM3Zjk2YWE7Zm9udC1zaXplOjEwcHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wOGVtfS5yZWNvcmQtdmFsdWUgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kfS5yZWNvcmQtcm93LmludmFsaWR7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjMpfQouZmlsdGVyLXBhbmVse2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczplbmR9LmZpbHRlci1wYW5lbCBsYWJlbHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWluLXdpZHRoOjE1MHB4fS5hbmFseXNpcy1tZXRyaWNze21hcmdpbi1ib3R0b206MThweH0uYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDUsbWlubWF4KDAsMWZyKSl9Ci50YWJsZS1zY3JvbGx7b3ZlcmZsb3c6YXV0bztib3JkZXItcmFkaXVzOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzIwcHh9dGgsdGR7cGFkZGluZzoxMnB4IDEzcHg7dGV4dC1hbGlnbjpyaWdodDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmb250LXNpemU6MTNweH10aDpmaXJzdC1jaGlsZCx0ZDpmaXJzdC1jaGlsZHt0ZXh0LWFsaWduOmxlZnR9dGh7Zm9udC1zaXplOjExcHg7Y29sb3I6Izg4YTBiNTtsZXR0ZXItc3BhY2luZzouMDVlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7YmFja2dyb3VuZDojMGExOTI4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MH10Ym9keSB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLmNvbXBhY3QtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSl9Lmlzc3VlLWxpc3R7ZGlzcGxheTpncmlkO2dhcDo4cHg7bWFyZ2luLXRvcDoxNHB4fS5pc3N1ZXtkaXNwbGF5OmZsZXg7Z2FwOjEycHg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTJweCAxM3B4O2JvcmRlci1yYWRpdXM6MTNweDtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0uaXNzdWUud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yMil9Lmlzc3VlLmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4yNSl9Lmlzc3VlIGRpdnttaW4td2lkdGg6MH0uaXNzdWUgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEzcHh9Lmlzc3VlIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6M3B4fS5tdXRlZHtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS41NX0uYWN0aW9uLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5zdGF0dXMtdGV4dHttaW4taGVpZ2h0OjEuNGVtO21hcmdpbjoxMnB4IDAgMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHh9LnN0YXR1cy10ZXh0Lm9re2NvbG9yOiNhNWU2OWF9LnN0YXR1cy10ZXh0LmVycm9ye2NvbG9yOiNmZmFhYTl9LnNldHRpbmdzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTNweDttYXJnaW46MTRweCAwfS5maWVsZHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjojOWRiMGMwO2ZvbnQtc2l6ZToxMnB4fS5maWVsZCBpbnB1dCwuZmllbGQgc2VsZWN0LC5maWVsZCB0ZXh0YXJlYXt3aWR0aDoxMDAlO2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTcxLDE5OCwyMjAsLjE2KTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEycHg7b3V0bGluZTpub25lfS5maWVsZCBpbnB1dDpmb2N1cywuZmllbGQgc2VsZWN0OmZvY3VzLC5maWVsZCB0ZXh0YXJlYTpmb2N1c3tib3JkZXItY29sb3I6cmdiYSg3NywxNTYsMjU1LC41NSk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NywxNTYsMjU1LC4wOCl9LnN3aXRjaC1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjExcHggMTNweDtjb2xvcjojYzdkNWRmfS5zd2l0Y2gtcm93IGlucHV0e3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7YWNjZW50LWNvbG9yOiMzYzlhNTN9Ci5iYW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTZweDttYXJnaW46MTJweCAwIDE4cHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxNXB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGQyMDMyfS5iYW5uZXIud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yOCk7YmFja2dyb3VuZDpyZ2JhKDI0MiwyMDksOTUsLjA2KX0uYmFubmVyIHN0cm9uZywuYmFubmVyIHNwYW57ZGlzcGxheTpibG9ja30uYmFubmVyIHNwYW57Y29sb3I6I2IzYzBjYTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjNweH0KLmJvdHRvbS1uYXZ7cG9zaXRpb246Zml4ZWQ7ei1pbmRleDo0MDtsZWZ0OjUwJTtib3R0b206bWF4KDEycHgsZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7d2lkdGg6bWluKDYyMHB4LGNhbGMoMTAwJSAtIDI0cHgpKTtiYWNrZ3JvdW5kOnJnYmEoOCwyMCwzMywuOTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTYpO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjdweDtib3gtc2hhZG93OjAgMTZweCA1MHB4IHJnYmEoMCwwLDAsLjQyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxNnB4KX0uYm90dG9tLW5hdiBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojODU5OWFhO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjlweCA4cHg7ZGlzcGxheTpncmlkO2dhcDozcHg7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MDttaW4td2lkdGg6MH0uYm90dG9tLW5hdiBidXR0b24gc3Bhbntmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfS5ib3R0b20tbmF2IGJ1dHRvbi5hY3RpdmV7YmFja2dyb3VuZDojMTUzMTQ3O2NvbG9yOiNmNGY4ZmJ9Ci5tb2RhbHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7cGFkZGluZzoxOHB4fS5tb2RhbC1iYWNrZHJvcHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNzIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDVweCl9Lm1vZGFsLWNhcmR7cG9zaXRpb246cmVsYXRpdmU7d2lkdGg6bWluKDc2MHB4LDEwMCUpO21heC1oZWlnaHQ6Y2FsYygxMDB2aCAtIDM2cHgpO292ZXJmbG93OmF1dG87YmFja2dyb3VuZDojMGIxYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTgpO2JvcmRlci1yYWRpdXM6MjJweDtwYWRkaW5nOjIycHg7Ym94LXNoYWRvdzowIDMwcHggOTBweCByZ2JhKDAsMCwwLC41NSl9Lm1vZGFsLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxOHB4fS5tb2RhbC1oZWFkIGgye21hcmdpbjoycHggMCAwfS5mb3JtLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0uZGVyaXZlZC1wcmV2aWV3e21hcmdpbjoxNHB4IDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTJweCAxNHB4O2ZvbnQtd2VpZ2h0OjgwMH0uZGVyaXZlZC1wcmV2aWV3LmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zNSk7Y29sb3I6I2ZmYWFhOX0uZGV0YWlscy1jYXJke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbjoxMnB4IDA7YmFja2dyb3VuZDojMDgxNzI1fS5kZXRhaWxzLWNhcmQgc3VtbWFyeXtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjEycHggMTRweDtjb2xvcjojYzdkNWRmO2ZvbnQtd2VpZ2h0OjcwMH0uZGV0YWlscy1jYXJkIC5kZXRhaWwtZ3JpZHtwYWRkaW5nOjAgMTRweCAxNHB4fS52YWxpZGF0aW9uLXRleHR7bWluLWhlaWdodDoxLjJlbTtjb2xvcjojZmZhYWE5O2ZvbnQtc2l6ZToxMnB4fS5tb2RhbC1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OXB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjE2cHh9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntmbGV4OjF9Ci50b2FzdHtwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjE1MDtsZWZ0OjUwJTtib3R0b206MTAwcHg7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7YmFja2dyb3VuZDojMTkzNjRkO2NvbG9yOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIwMCwyMjAsMjM2LC4xNik7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTFweCAxNXB4O2JveC1zaGFkb3c6MCAxNnB4IDUwcHggcmdiYSgwLDAsMCwuNCk7bWF4LXdpZHRoOm1pbig5MHZ3LDU2MHB4KTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpey5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9LnJlY29yZC1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxNTBweCwxLjJmcikgcmVwZWF0KDIsbWlubWF4KDk1cHgsLjhmcikpIGF1dG99LnJlY29yZC1yb3cgLnJlY29yZC12YWx1ZTpudGgtb2YtdHlwZSg0KSwucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVlOm50aC1vZi10eXBlKDUpe2Rpc3BsYXk6bm9uZX0ub3N0cm9tLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnByaWNlLWNhcmQuY3VycmVudHtncmlkLWNvbHVtbjoxLy0xfS5jb21wYWN0LW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfX0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmFwcC1zaGVsbHtwYWRkaW5nOjAgMTJweCAxMDRweH0udG9wYmFye3BhZGRpbmctbGVmdDo0cHg7cGFkZGluZy1yaWdodDo0cHh9LmJyYW5ke2ZvbnQtc2l6ZToyMXB4fS5icmFuZC1tYXJre3dpZHRoOjMzcHg7aGVpZ2h0OjMzcHh9LnN1YnRpdGxle21hcmdpbi1sZWZ0OjQzcHh9LnBhZ2UtaGVhZHthbGlnbi1pdGVtczpzdHJldGNoO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjttYXJnaW4tdG9wOjlweH0ucGFnZS1oZWFkIC5wcmltYXJ5e3dpZHRoOjEwMCV9LnBhZ2UtaGVhZCBoMXtmb250LXNpemU6MzFweH0ucGFuZWx7cGFkZGluZzoxNnB4O2JvcmRlci1yYWRpdXM6MTdweDttYXJnaW4tYm90dG9tOjEzcHh9LnBhbmVsLWhlYWR7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5wYW5lbC1oZWFkIGgye2ZvbnQtc2l6ZToxOHB4fS5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsbWlubWF4KDAsMWZyKSk7Z2FwOjlweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtwYWRkaW5nOjEzcHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZToyMHB4fS5vc3Ryb20tZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5wcmljZS1jYXJkLmN1cnJlbnR7Z3JpZC1jb2x1bW46YXV0b30ucHJpY2UtY2FyZHtwYWRkaW5nOjE1cHh9LnByaWNlLWNhcmQgc3Ryb25ne2ZvbnQtc2l6ZToyNHB4fS5jaGFydC13cmFwLC5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjIyNXB4fS5jaGFydC13cmFwLmxhcmdle2hlaWdodDoyNzBweH0ucmVjb3JkLXRvb2xiYXJ7YWxpZ24taXRlbXM6c3RyZXRjaH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0e21heC13aWR0aDoxNDVweH0ucmVjb3JkLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjlweH0ucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVle2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9LnJlY29yZC1yb3cgLmVkaXQtcmVjb3Jke2dyaWQtY29sdW1uOjI7Z3JpZC1yb3c6MX0ucmVjb3JkLW1vbnRoIHNtYWxse21heC13aWR0aDoyMzBweH0uZmlsdGVyLXBhbmVse2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtwYWRkaW5nOjE0cHh9LmZpbHRlci1wYW5lbCBsYWJlbHttaW4td2lkdGg6MH0uc2V0dGluZ3MtZ3JpZCwuZm9ybS1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmRldGFpbHMtY2FyZCAuZGV0YWlsLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uYWN0aW9uLXJvdz4qe2ZsZXg6MSAxIDE1MHB4fS5ib3R0b20tbmF2e3dpZHRoOmNhbGMoMTAwJSAtIDE2cHgpO2JvdHRvbTptYXgoOHB4LGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7Ym9yZGVyLXJhZGl1czoxN3B4fS5ib3R0b20tbmF2IGJ1dHRvbntmb250LXNpemU6MTBweDtwYWRkaW5nOjhweCAzcHh9LmJvdHRvbS1uYXYgYnV0dG9uIHNwYW57Zm9udC1zaXplOjE4cHh9Lm1vZGFse3BhZGRpbmc6OHB4fS5tb2RhbC1jYXJke3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE4cHg7bWF4LWhlaWdodDpjYWxjKDEwMHZoIC0gMTZweCl9Lm1vZGFsLWFjdGlvbnN7ZmxleC13cmFwOndyYXB9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntkaXNwbGF5Om5vbmV9Lm1vZGFsLWFjdGlvbnMgYnV0dG9ue2ZsZXg6MSAxIDEyMHB4fS5iYW5uZXJ7YWxpZ24taXRlbXM6c3RyZXRjaDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59LmJhbm5lciBidXR0b257YWxpZ24tc2VsZjpmbGV4LXN0YXJ0fX0KQG1lZGlhKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsqe3Njcm9sbC1iZWhhdmlvcjphdXRvIWltcG9ydGFudDthbmltYXRpb246bm9uZSFpbXBvcnRhbnQ7dHJhbnNpdGlvbjpub25lIWltcG9ydGFudH19CgovKiBFbGRlaG9mIDYuMC4xIOKAkyBsb2thbGVyIG15VkFJTExBTlQtSW1wb3J0ICovCiN2YWlsbGFudEltcG9ydFBhbmVsIC5hY3Rpb24tcm93e21hcmdpbi10b3A6MTRweH0KI3ZhaWxsYW50SW1wb3J0U3RhdHVzLm9re2NvbG9yOiNhNWU2OWF9CiN2YWlsbGFudEltcG9ydFN0YXR1cy5lcnJvcntjb2xvcjojZmZhYWE5fQoKLyogRWxkZWhvZiA2LjEuMCDigJMgWsOkaGxlcnN0w6RuZGUgYWxzIGVpbnppZ2UgbWFudWVsbGUgVmVyYnJhdWNoc2VpbmdhYmUgKi8KLnJlY29yZC1zdGF0dXMtYmFkZ2V7anVzdGlmeS1zZWxmOmVuZDtmb250LXNpemU6MTFweDtjb2xvcjojOWRiMGMwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzo2cHggOHB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDojMDgxNzI1fQoubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfQoubWV0ZXItaGlzdG9yeXtkaXNwbGF5OmdyaWQ7Z2FwOjdweDttYXJnaW46MTRweCAwfS5tZXRlci1oaXN0b3J5LXJvd3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxMDBweCwxZnIpIHJlcGVhdCgyLG1pbm1heCgxMTBweCwxZnIpKSBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjEwcHggMTJweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiMwODE3MjU7Zm9udC1zaXplOjEycHh9Lm1ldGVyLWhpc3Rvcnktcm93IHNwYW4sLm1ldGVyLWhpc3Rvcnktcm93IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0ubWV0ZXItaGlzdG9yeS1yb3cgc3Ryb25ne2ZvbnQtc2l6ZToxMnB4fS5tZXRlci1hY3Rpb25ze21hcmdpbi10b3A6MTJweH0ubWV0ZXItcHJldmlvdXN7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1O2NvbG9yOiNiOWM3ZDI7bGluZS1oZWlnaHQ6MS41fS5jb21wYWN0LW5vdGV7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfS5tZXRlci1sYXRlc3QubWV0cmljLWdyaWQgYXJ0aWNsZTpmaXJzdC1jaGlsZHtncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0ubWV0ZXItaGlzdG9yeS1yb3cgc3BhbntncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvdyBzbWFsbHtkaXNwbGF5Om5vbmV9LnJlY29yZC1zdGF0dXMtYmFkZ2V7Zm9udC1zaXplOjEwcHh9fQoKLyogRWxkZWhvZiA2LjEuMSDigJMgTW9uYXRzd2VydGUgd2llZGVyIGJlYXJiZWl0YmFyICovCi5maWVsZCBpbnB1dFtyZWFkb25seV17b3BhY2l0eTouNzI7Y3Vyc29yOmRlZmF1bHQ7YmFja2dyb3VuZDojMGIxNzIyfS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kO3doaXRlLXNwYWNlOm5vd3JhcH0KCi8qIEVsZGVob2YgNi4yLjAgKi8KLmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e2Rpc3BsYXk6Z3JpZDtnYXA6NXB4O2ZsZXg6MTttaW4td2lkdGg6MjQwcHg7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDojMGIxYTJhfS5hbmFseXNpcy1hbGwteWVhcnMtaGludCBzdHJvbmd7Zm9udC1zaXplOjEzcHh9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50IHNwYW57Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2xpbmUtaGVpZ2h0OjEuNH0ueWVhci1jb21wYXJpc29uLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHggMTZweDttYXJnaW46LTRweCAwIDEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgc3BhbntkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2NvbG9yOiNiOGM2ZDI7Zm9udC1zaXplOjEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgaXtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDoyOHB4O2hlaWdodDowO2JvcmRlci10b3A6M3B4IHNvbGlkIGN1cnJlbnRDb2xvcn0ueWVhci1jb21wYXJpc29uLWxlZ2VuZCAucGFzdCBpe2JvcmRlci10b3Atc3R5bGU6ZGFzaGVkfS5zeW5jLWJhZGdle2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGIxYTJhO2NvbG9yOnZhcigtLW11dGVkKTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6ODAwfS5zeW5jLWJhZGdlLm9re2NvbG9yOiNhNWU2OWE7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMyl9LnN5bmMtYmFkZ2UuYnVzeXtjb2xvcjojOWZkMGZmO2JvcmRlci1jb2xvcjpyZ2JhKDc3LDE1NiwyNTUsLjM1KX0uc3luYy1iYWRnZS5lcnJvcntjb2xvcjojZmZhYWE5O2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zKX0uc3luYy1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfS5zeW5jLWpvaW4tYm94e21hcmdpbi10b3A6MTRweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nLXRvcDoxMnB4fS5zeW5jLWpvaW4tYm94IHN1bW1hcnl7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6I2RjZTlmMztmb250LXdlaWdodDo4MDB9LnN5bmMtcGFpci1yZXN1bHR7ZGlzcGxheTpncmlkO2dhcDo3cHg7bWFyZ2luLXRvcDoxNHB4O3BhZGRpbmc6MTRweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzcsMTU2LDI1NSwuMjgpO2JhY2tncm91bmQ6IzBhMWQzMDtib3JkZXItcmFkaXVzOjE0cHh9LnN5bmMtcGFpci1yZXN1bHQgc3Bhbiwuc3luYy1wYWlyLXJlc3VsdCBzbWFsbHtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjExcHh9LnN5bmMtcGFpci1yZXN1bHQgY29kZXtkaXNwbGF5OmJsb2NrO3dvcmQtYnJlYWs6YnJlYWstYWxsO2NvbG9yOiNkYmVlZmY7YmFja2dyb3VuZDojMDcxNDIxO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6OHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH1AbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsuZmlsdGVyLXBhbmVse2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e21pbi13aWR0aDowfS5zeW5jLW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnN5bmMtbWV0cmljcy5tZXRyaWMtZ3JpZCBhcnRpY2xlOmxhc3QtY2hpbGR7Z3JpZC1jb2x1bW46MS8tMX19CgoucHJpY2UtcnVubmluZ3tkaXNwbGF5OmlubGluZS1ibG9jazttYXJnaW4tbGVmdDo1cHg7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDpyZ2JhKDc3LDE1NiwyNTUsLjEyKTtjb2xvcjojOWZkMGZmO2ZvbnQtc2l6ZTo5cHg7Zm9udC13ZWlnaHQ6ODAwO3ZlcnRpY2FsLWFsaWduOm1pZGRsZX0ucHJpY2Utc3RhdHMtbm90ZXtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9CgovKiBFbGRlaG9mIDYuMy4xIOKAkyBLbGltYS1Db2NrcGl0OiByZXNwb25zaXZlIGFuZCBsZWdpYmxlIGFjcm9zcyBpT1MsIEFuZHJvaWQgYW5kIGRlc2t0b3AuICovCi5kYXNoYm9hcmQtY2xpbWF0ZS1wYW5lbHtvdmVyZmxvdzpoaWRkZW59Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzLm1ldHJpYy1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSk7bWFyZ2luLWJvdHRvbToxOHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtY2hhcnQtdG9we2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7bWFyZ2luOjEwcHggMH0KLmRhc2hib2FyZC1jbGltYXRlLWNoYXJ0LXRvcD5zdHJvbmd7Zm9udC1zaXplOjE0cHg7Y29sb3I6I2NjZGFlNX0KLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaHtkaXNwbGF5OmlubGluZS1mbGV4O2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTNweDtwYWRkaW5nOjRweDtnYXA6M3B4fQouZGFzaGJvYXJkLWNsaW1hdGUtc3dpdGNoIGJ1dHRvbntib3JkZXI6MDtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojOWViMmM0O2ZvbnQ6aW5oZXJpdDtmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7cGFkZGluZzo5cHggMTNweDtjdXJzb3I6cG9pbnRlcn0KLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6IzFiM2I1MTtjb2xvcjojZWVmYWZmfQouZGFzaGJvYXJkLWNsaW1hdGUtc3dpdGNoIGJ1dHRvbjpmb2N1cy12aXNpYmxle291dGxpbmU6MnB4IHNvbGlkICM4M2M3ZWM7b3V0bGluZS1vZmZzZXQ6MnB4fQouZGFzaGJvYXJkLWNsaW1hdGUtY2hhcnQtd3JhcC5jaGFydC13cmFwe2hlaWdodDoyMzVweH0KLmRhc2hib2FyZC1jbGltYXRlLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjlweCAxNXB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiNiNWM3ZDU7bWFyZ2luLXRvcDoxMHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtbGVnZW5kIHNwYW46OmJlZm9yZXtjb250ZW50OiIiO3dpZHRoOjEwcHg7aGVpZ2h0OjEwcHg7Ym9yZGVyLXJhZGl1czozcHg7ZGlzcGxheTppbmxpbmUtYmxvY2s7YmFja2dyb3VuZDp2YXIoLS1sZWdlbmQtY29sb3IpO21hcmdpbi1yaWdodDo2cHg7dmVydGljYWwtYWxpZ246YmFzZWxpbmV9Ci5kYXNoYm9hcmQtY2xpbWF0ZS10cmVuZHtjb2xvcjojYjhjYmQ4O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNDU7bWFyZ2luOjEwcHggMCAwO21pbi1oZWlnaHQ6MThweH0KLmRhc2hib2FyZC1jbGltYXRlLWZvb3RlcntkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2dhcDoxMnB4O2ZsZXgtd3JhcDp3cmFwO21hcmdpbi10b3A6OHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtZm9vdGVyIC5zdGF0dXMtdGV4dHtmbGV4OjEgMSAxNjBweDttYXJnaW46MDtmb250LXNpemU6MTJweH0KI2NsaW1hdGVBbmFseXNpc1BhbmVse3Njcm9sbC1tYXJnaW4tdG9wOjEwMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsKIC5kYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0KIC5kYXNoYm9hcmQtY2xpbWF0ZS1jaGFydC13cmFwLmNoYXJ0LXdyYXB7aGVpZ2h0OjIxNXB4fQogLmRhc2hib2FyZC1jbGltYXRlLXBhbmVsIC5wYW5lbC1oZWFke2FsaWduLWl0ZW1zOmZsZXgtc3RhcnR9CiAuZGFzaGJvYXJkLWNsaW1hdGUtcGFuZWwgLnBhbmVsLWhlYWQgYnV0dG9ue21heC13aWR0aDo0MCU7d2hpdGUtc3BhY2U6bm9ybWFsfQogLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCBidXR0b257cGFkZGluZzo5cHggMTBweDtmb250LXNpemU6MTJweH0KIC5kYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIgYnV0dG9ue3dpZHRoOjEwMCV9Cn0KCi8qIDYuMy4zOiBsZWdpYmxlIGFubnVhbCBlbmVyZ3kvdGVtcGVyYXR1cmUgY29tcGFyaXNvbnMgKi8KLmNsaW1hdGUtZGFzaGJvYXJkLWhlYWR7YWxpZ24taXRlbXM6Y2VudGVyfQouZGFzaGJvYXJkLWNsaW1hdGUteWVhci1maWVsZHtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo0cHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxMnB4O21pbi13aWR0aDoxMDJweH0KLmRhc2hib2FyZC1jbGltYXRlLXllYXItZmllbGQgc2VsZWN0e3dpZHRoOjEwMCU7YmFja2dyb3VuZDojMGIyMTMyO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzEsMTk4LDIyMCwuMyk7Ym9yZGVyLXJhZGl1czoxMXB4O2NvbG9yOnZhcigtLXRleHQpO3BhZGRpbmc6OXB4IDExcHg7Zm9udDppbmhlcml0O2ZvbnQtc2l6ZToxNXB4O2ZvbnQtd2VpZ2h0OjcwMDttaW4taGVpZ2h0OjQycHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1pbnRyb3ttYXJnaW46MCAwIDE2cHg7Zm9udC1zaXplOjEzcHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1jaGFydC13cmFwLmNoYXJ0LXdyYXB7aGVpZ2h0OjI3MHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtZXhwbGFuYXRpb257Y29sb3I6I2I5Y2NkYztmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjU7bWFyZ2luOjdweCAwIDE5cHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC10aXRsZXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6YmFzZWxpbmU7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo3MDA7bWFyZ2luOjEwcHggMCA5cHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC10aXRsZSBzbWFsbHtmb250LXdlaWdodDo0MDA7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0ZWQpfQouZGFzaGJvYXJkLWNsaW1hdGUtbW9udGhze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDEyLG1pbm1heCgwLDFmcikpO2dhcDo1cHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aHMgYnV0dG9ue21pbi13aWR0aDowO3BhZGRpbmc6OXB4IDFweDtib3JkZXItcmFkaXVzOjlweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTYxLDE5NiwyMjMsLjIpO2JhY2tncm91bmQ6IzBiMWMyYztjb2xvcjojYWVjMWQyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjcwMDtjdXJzb3I6cG9pbnRlcn0KLmRhc2hib2FyZC1jbGltYXRlLW1vbnRocyBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6IzI0NDk1ZTtib3JkZXItY29sb3I6Izc4YjVkNztjb2xvcjojZmZmfQouZGFzaGJvYXJkLWNsaW1hdGUtbW9udGhzIGJ1dHRvbjpmb2N1cy12aXNpYmxle291dGxpbmU6MnB4IHNvbGlkICNhNGQ0ZWY7b3V0bGluZS1vZmZzZXQ6MnB4fQouZGFzaGJvYXJkLWNsaW1hdGUtbW9udGgtZGV0YWlse2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzEsMTk4LDIyMCwuMTgpO2JhY2tncm91bmQ6cmdiYSgxNiwzOCw1NiwuNyk7Ym9yZGVyLXJhZGl1czoxNXB4O3BhZGRpbmc6MTZweDttYXJnaW46MTJweCAwIDB9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC1kZXRhaWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6YmFzZWxpbmU7ZmxleC13cmFwOndyYXA7Z2FwOjVweCAxMnB4O21hcmdpbi1ib3R0b206MTJweH0KLmRhc2hib2FyZC1jbGltYXRlLW1vbnRoLWRldGFpbC1oZWFkIHN0cm9uZ3tmb250LXNpemU6MThweH0uZGFzaGJvYXJkLWNsaW1hdGUtbW9udGgtZGV0YWlsLWhlYWQgc21hbGx7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlmZDFlNn0KLmRhc2hib2FyZC1jbGltYXRlLW1vbnRoLWRldGFpbC1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSk7Z2FwOjEycHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC1kZXRhaWwtZ3JpZCBkaXZ7bWluLXdpZHRoOjB9LmRhc2hib2FyZC1jbGltYXRlLW1vbnRoLWRldGFpbC1ncmlkIHNwYW57ZGlzcGxheTpibG9jaztmb250LXNpemU6MTFweDtjb2xvcjojOTJhZGMwO21hcmdpbi1ib3R0b206NHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtbW9udGgtZGV0YWlsLWdyaWQgc3Ryb25ne2ZvbnQtc2l6ZToxN3B4O2xpbmUtaGVpZ2h0OjEuMzt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC1kZXRhaWw+cHtmb250LXNpemU6MTJweDtjb2xvcjojYjFjOGQ2O21hcmdpbjoxM3B4IDAgMDtsaW5lLWhlaWdodDoxLjV9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwfQpAbWVkaWEobWF4LXdpZHRoOjY1MHB4KXsKLmRhc2hib2FyZC1jbGltYXRlLW1vbnRoc3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDYsbWlubWF4KDAsMWZyKSk7Z2FwOjZweH0KLmRhc2hib2FyZC1jbGltYXRlLW1vbnRoLWRldGFpbC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0KLmRhc2hib2FyZC1jbGltYXRlLWNoYXJ0LXdyYXAuY2hhcnQtd3JhcHtoZWlnaHQ6MjQwcHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIgLmRhc2hib2FyZC1jbGltYXRlLWFjdGlvbnN7d2lkdGg6MTAwJTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIgLmRhc2hib2FyZC1jbGltYXRlLWFjdGlvbnMgYnV0dG9ue3dpZHRoOjEwMCU7Zm9udC1zaXplOjEycHg7cGFkZGluZzoxMHB4IDVweH0KfQoKLyogNi4zLjQ6IHdlYXRoZXIgYW5kIGhlYXQtcHVtcCBwb3dlciBhbGlnbmVkIG1vbnRobHkgY29tcGFyaXNvbiAqLwouY2xpbWF0ZS1jb3VwbGVkLWludHJve2ZvbnQtc2l6ZToxM3B4O21hcmdpbjotMnB4IDAgMTJweH0KLmNsaW1hdGUtY291cGxlZC1sZWdlbmR7ZGlzcGxheTpmbGV4O2dhcDoxNnB4O2ZsZXgtd3JhcDp3cmFwO21hcmdpbjowIDAgMTNweDtjb2xvcjojZDdlNmVmO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTRweH0KLmNsaW1hdGUtY291cGxlZC1sZWdlbmQgc3BhbntkaXNwbGF5OmZsZXg7Z2FwOjdweDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5jbGltYXRlLWNvdXBsZWQtbGVnZW5kIGksLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgdGggaXt3aWR0aDoxMnB4O2hlaWdodDoxMnB4O2JvcmRlci1yYWRpdXM6NHB4O2Rpc3BsYXk6aW5saW5lLWJsb2NrO2ZsZXg6bm9uZX0KLmNsaW1hdGUtY291cGxlZC1yYW5nZXtkaXNwbGF5OmlubGluZS1mbGV4O2dhcDozcHg7cGFkZGluZzo0cHg7YmFja2dyb3VuZDojMDgxNzI1O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4fQouY2xpbWF0ZS1jb3VwbGVkLXJhbmdlIGJ1dHRvbntwYWRkaW5nOjlweCAxM3B4O2JvcmRlci1yYWRpdXM6OXB4O2ZvbnQtd2VpZ2h0OjYwMDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjowO2NvbG9yOiNiNWM1ZDY7Y3Vyc29yOnBvaW50ZXI7Zm9udC1zaXplOjEzcHh9Ci5jbGltYXRlLWNvdXBsZWQtcmFuZ2UgYnV0dG9uLmFjdGl2ZXtiYWNrZ3JvdW5kOiMxYjNiNTE7Y29sb3I6I2ZmZn0KLmNsaW1hdGUtY291cGxlZC10aW1lZnJhbWV7Zm9udC1zaXplOjEycHg7Y29sb3I6Izk5YWZiZTttYXJnaW46OXB4IDAgMThweH0KLmNsaW1hdGUtY291cGxlZC1wbG90e21hcmdpbjowIDAgMThweH0KLmNsaW1hdGUtY291cGxlZC10aXRsZXtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjVweCAxMnB4O2FsaWduLWl0ZW1zOmJhc2VsaW5lO21hcmdpbi1ib3R0b206NXB4fQouY2xpbWF0ZS1jb3VwbGVkLXRpdGxlIHN0cm9uZ3tmb250LXNpemU6MTZweH0KLmNsaW1hdGUtY291cGxlZC10aXRsZSBzcGFue2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5NGFiYmF9Ci5jbGltYXRlLWNvdXBsZWQtY2hhcnQuY2hhcnQtd3JhcHtoZWlnaHQ6MjA4cHh9Ci5jbGltYXRlLWNvdXBsZWQtbm90aWNle2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTtjb2xvcjojYThiZWQwO21hcmdpbjo1cHggMCAxNXB4fQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnl7cGFkZGluZzoxNHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSgxMjUsMTg2LDIxNiwuMjUpO2JhY2tncm91bmQ6IzEwMjczYTtib3JkZXItcmFkaXVzOjE1cHg7bWFyZ2luOjEwcHggMCAyMHB4fQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnk+c3Ryb25ne2ZvbnQtc2l6ZToxNHB4O2Rpc3BsYXk6YmxvY2t9Ci5jbGltYXRlLWNvdXBsZWQtc3VtbWFyeT5we2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTtjb2xvcjojYWRjMmQzO21hcmdpbjo5cHggMCAwfQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnktbWV0cmljc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgzLG1pbm1heCgwLDFmcikpO2dhcDo4cHg7bWFyZ2luLXRvcDoxMnB4fQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnktbWV0cmljcz5kaXZ7YmFja2dyb3VuZDojMGExYzJjO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEwcHg7bWluLXdpZHRoOjB9Ci5jbGltYXRlLWNvdXBsZWQtc3VtbWFyeS1tZXRyaWNzIHNwYW4sLmNsaW1hdGUtY291cGxlZC1zdW1tYXJ5LW1ldHJpY3Mgc21hbGx7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTFweDtjb2xvcjojYTFiYmNhO2xpbmUtaGVpZ2h0OjEuNDV9Ci5jbGltYXRlLWNvdXBsZWQtc3VtbWFyeS1tZXRyaWNzIHN0cm9uZ3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxOHB4O21hcmdpbjo1cHggMDt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Ci5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlse2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzEsMTk4LDIyMCwuMik7YmFja2dyb3VuZDpyZ2JhKDEwLDI3LDQyLC42KTtib3JkZXItcmFkaXVzOjE1cHg7cGFkZGluZzoxM3B4O21hcmdpbi10b3A6MTNweH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1oZWFkZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmJhc2VsaW5lO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2ZsZXgtd3JhcDp3cmFwO2dhcDo1cHggMTRweDttYXJnaW46MnB4IDAgMTBweH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1oZWFkZXIgc3Ryb25ne2ZvbnQtc2l6ZToxNXB4fS5jbGltYXRlLWNvdXBsZWQtbW9udGgtaGVhZGVyIHNwYW57Zm9udC1zaXplOjEycHg7Y29sb3I6I2EzYmFjZH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgLnRhYmxlLXNjcm9sbHtvdmVyZmxvdy14OmF1dG99Ci5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlsIHRhYmxle3dpZHRoOjEwMCU7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlO3doaXRlLXNwYWNlOm5vd3JhcDtmb250LXNpemU6MTJweH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgdGgsLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgdGR7cGFkZGluZzoxMHB4IDExcHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSgxNzEsMTk4LDIyMCwuMTIpO3RleHQtYWxpZ246bGVmdH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgdGh7Y29sb3I6I2I5ZDFkZn0uY2xpbWF0ZS1jb3VwbGVkLW1vbnRoLWRldGFpbCB0Ym9keSB0aHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo3cHh9Ci5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlsIHB7Zm9udC1zaXplOjEycHg7bGluZS1oZWlnaHQ6MS42O2NvbG9yOiNjM2Q0ZGU7bWFyZ2luOjExcHggMCAycHh9CkBtZWRpYShtYXgtd2lkdGg6NjUwcHgpewouY2xpbWF0ZS1jb3VwbGVkLWNoYXJ0LmNoYXJ0LXdyYXB7aGVpZ2h0OjE5MHB4fQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnktbWV0cmljc3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0KLmNsaW1hdGUtY291cGxlZC1zdW1tYXJ5LW1ldHJpY3M+ZGl2Omxhc3QtY2hpbGR7Z3JpZC1jb2x1bW46MS8tMX0KLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWx7cGFkZGluZzo5cHh9Ci5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlsIHRkLC5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlsIHRoe3BhZGRpbmc6OXB4IDhweH0KfQo=","type":"text/css; charset=utf-8","cache":"no-cache"},"/app.js":{"body":"KCgpID0+IHsKICAidXNlIHN0cmljdCI7CgogIGNvbnN0IEFQUF9CVUlMRCA9ICI2LjMuNC1XRUFUSEVSLUhFQVQtUE9XRVItQ09NUEFSSVNPTi0yMDI2MTAzMSI7CiAgY29uc3QgREFUQV9LRVkgPSAiZWxkZWhvZi12My1yZWNvcmRzIjsKICBjb25zdCBTRVRUSU5HU19LRVkgPSAiZWxkZWhvZi12My1zZXR0aW5ncyI7CiAgY29uc3QgVkFJTExBTlRfTU9OVEhTX0tFWSA9ICJlbGRlaG9mLXYzLXZhaWxsYW50LW1vbnRocy12MzgwIjsKICBjb25zdCBPU1RST01fQ0FDSEVfS0VZID0gImVsZGVob2YtdjMtb3N0cm9tLWxpdmUtY2FjaGUiOwogIGNvbnN0IE9TVFJPTV9DT05UUk9MX0tFWSA9ICJlbGRlaG9mLXY1LW9zdHJvbS1jb250cm9sLXY1NDEiOwogIGNvbnN0IFNIQURPV19LRVkgPSAiZWxkZWhvZi12Ni1yZWNvcmRzLXNoYWRvdyI7CiAgY29uc3QgU0hBRE9XX01FVEFfS0VZID0gImVsZGVob2YtdjYtcmVjb3Jkcy1zaGFkb3ctbWV0YSI7CiAgY29uc3QgTEFTVF9CQUNLVVBfS0VZID0gImVsZGVob2YtdjYtbGFzdC1iYWNrdXAtYXQiOwogIGNvbnN0IE1FVEVSX0tFWSA9ICJlbGRlaG9mLXY2LW1ldGVyLXJlYWRpbmdzLXY2MTAiOwogIGNvbnN0IE1FVEVSX01FVEFfS0VZID0gImVsZGVob2YtdjYtbWV0ZXItcmVhZGluZ3MtdXBkYXRlZC12NjIwIjsKICBjb25zdCBISVNUT1JZX1NFRURfS0VZID0gImVsZGVob2YtdjYtaGlzdG9yeS1zZWVkLXY2MTAiOwogIGNvbnN0IFNZTkNfU1RBVEVfS0VZID0gImVsZGVob2YtdjYtc3luYy1zdGF0ZS12NjIwIjsKICBjb25zdCBTWU5DX1NFQ1JFVF9MRUdBQ1lfS0VZID0gImVsZGVob2YtdjYtc3luYy1zZWNyZXQtdjYyMCI7CiAgY29uc3QgU1lOQ19QQVlMT0FEX1NDSEVNQSA9ICJlbGRlaG9mLXN5bmMtcGF5bG9hZC12NjIwIjsKICBjb25zdCBTWU5DX0VOVkVMT1BFX1NDSEVNQSA9ICJlbGRlaG9mLWVuY3J5cHRlZC1zeW5jLXYxIjsKICBjb25zdCBPU1RST01fSElTVE9SWV9LRVkgPSAiZWxkZWhvZi12Ni1vc3Ryb20taGlzdG9yeS1zdGF0dXMtdjYyMCI7CiAgY29uc3QgT1NUUk9NX1BSSUNFX1NUQVRTX0tFWSA9ICJlbGRlaG9mLXY2LW9zdHJvbS1wcmljZS1zdGF0cy12NjIxIjsKICBjb25zdCBNT05USFMgPSBbIkphbiIsIkZlYiIsIk3DpHIiLCJBcHIiLCJNYWkiLCJKdW4iLCJKdWwiLCJBdWciLCJTZXAiLCJPa3QiLCJOb3YiLCJEZXoiXTsKICBjb25zdCBDT0xPUlMgPSB7IHRvdGFsOiIjNzJkYzU3IiwgaGVhdDoiI2ZmOWY0MyIsIGFubmV4OiIjNGQ5Y2ZmIiwgcmVzdDoiI2YyZDE1ZiIsIGNvbXBhcmU6IiM5YzdkZmYiLCBjb3N0OiIjNWZjN2MyIiwgZ3JpZDoicmdiYSgxNzEsMTk4LDIyMCwuMTQpIiwgdGV4dDoiIzk0YThiYSIgfTsKICBjb25zdCBZRUFSX0NPTE9SUyA9IFsiIzcyZGM1NyIsIiM0ZDljZmYiLCIjOWM3ZGZmIiwiI2ZmOWY0MyIsIiNmMmQxNWYiLCIjNWZjN2MyIiwiI2ZmN2I4YSJdOwogIGNvbnN0IEhJU1RPUklDQUxfU0VFRCA9IHsiaGVhdFB1bXAiOnsiMjAyMy0xMiI6MTU1MCwiMjAyNC0wMSI6MTk4MCwiMjAyNC0wMiI6MTExMywiMjAyNC0wMyI6OTA3LCIyMDI0LTA0Ijo1MzUsIjIwMjQtMDUiOjE1NiwiMjAyNC0wNiI6MTEwLCIyMDI0LTA3IjoxMTAsIjIwMjQtMDgiOjEwOCwiMjAyNC0wOSI6MTk4LCIyMDI0LTEwIjo0OTAsIjIwMjQtMTEiOjEwMDMsIjIwMjQtMTIiOjEzMDUsIjIwMjUtMDEiOjE2OTQsIjIwMjUtMDIiOjE0NzgsIjIwMjUtMDMiOjEwMDUsIjIwMjUtMDQiOjQ5OCwiMjAyNS0wNSI6MzY3LCIyMDI1LTA2IjoxMzcsIjIwMjUtMDciOjEwNiwiMjAyNS0wOCI6MTI4LCIyMDI1LTA5IjoxODUsIjIwMjUtMTAiOjYwNywiMjAyNS0xMSI6MTA0MCwiMjAyNS0xMiI6MTI2NSwiMjAyNi0wMSI6MTg1NSwiMjAyNi0wMiI6MTQ4OCwiMjAyNi0wMyI6ODk1LCIyMDI2LTA0Ijo2NTYsIjIwMjYtMDUiOjMwMCwiMjAyNi0wNiI6MTI2LCIyMDI2LTA3IjoxMjgsIjIwMjYtMDgiOjEyMSwiMjAyNi0wOSI6MTM3fSwiYW5uZXgiOnsiMjAyNC0wMSI6MjEwLCIyMDI0LTAyIjoyMTAsIjIwMjQtMDMiOjIxOSwiMjAyNC0wNCI6MjAwLCIyMDI0LTA1IjoyMjIsIjIwMjQtMDYiOjE2NCwiMjAyNC0wNyI6MjE5LCIyMDI0LTA4IjoyMDEsIjIwMjQtMDkiOjE5MiwiMjAyNC0xMCI6MjM3LCIyMDI0LTExIjoyMjcsIjIwMjQtMTIiOjI2NiwiMjAyNS0wMSI6MjYxLCIyMDI1LTAyIjoyMzUsIjIwMjUtMDMiOjIyMSwiMjAyNS0wNCI6MjM4LCIyMDI1LTA1IjoyMjEsIjIwMjUtMDYiOjIzNywiMjAyNS0wNyI6MjQwLCIyMDI1LTA4IjoyMzIsIjIwMjUtMDkiOjMwOCwiMjAyNS0xMCI6MjIwLCIyMDI1LTExIjoyMzcsIjIwMjUtMTIiOjI3MywiMjAyNi0wMSI6MjQwLCIyMDI2LTAyIjoyMjUsIjIwMjYtMDMiOjI3MCwiMjAyNi0wNCI6MjE1LCIyMDI2LTA1IjoyMjAsIjIwMjYtMDYiOjI1MCwiMjAyNi0wNyI6MjEwLCIyMDI2LTA4IjoyNDAsIjIwMjYtMDkiOjI2NX0sInRvdGFsIjp7IjIwMjQtMDEiOjI0NTAsIjIwMjQtMDIiOjE2MTUsIjIwMjQtMDMiOjEzMjAsIjIwMjQtMDQiOjkzMywiMjAyNC0wNSI6NzMxLCIyMDI0LTA2Ijo1ODcsIjIwMjQtMDciOjYyMCwiMjAyNC0wOCI6NTQwLCIyMDI0LTA5Ijo2MTIsIjIwMjQtMTAiOjEwMTksIjIwMjQtMTEiOjE1MjEsIjIwMjQtMTIiOjE4NTcsIjIwMjUtMDEiOjIyODIsIjIwMjUtMDIiOjIwMjMsIjIwMjUtMDMiOjE0MTQsIjIwMjUtMDQiOjk2MCwiMjAyNS0wNSI6OTMzLCIyMDI1LTA2Ijo3NTEsIjIwMjUtMDciOjY4MCwiMjAyNS0wOCI6Njc2LCIyMDI1LTA5Ijo4MTQsIjIwMjUtMTAiOjExMDUsIjIwMjUtMTEiOjE2MTUsIjIwMjUtMTIiOjE4NTAsIjIwMjYtMDEiOjI0NTAsIjIwMjYtMDIiOjIwNjAsIjIwMjYtMDMiOjE1OTcsIjIwMjYtMDQiOjEwNTEsIjIwMjYtMDUiOjc2NywiMjAyNi0wNiI6NjYyLCIyMDI2LTA3Ijo2MDgsIjIwMjYtMDgiOjY4NSwiMjAyNi0wOSI6NjU1fX07CiAgY29uc3QgQkFTRUxJTkVfTUVURVJfUkVBRElORyA9IHtkYXRlOiIyMDI2LTEwLTAxIix0b3RhbDozNDI1NSxhbm5leDo5MDQ1LG5vdGU6IlN0YXJ0d2VydCBmw7xyIGRpZSBhdXRvbWF0aXNjaGUgQmVyZWNobnVuZyBhYiBPa3RvYmVyIDIwMjYifTsKICBjb25zdCAkID0gaWQgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwoKICBsZXQgc2V0dGluZ3MgPSBsb2FkU2V0dGluZ3MoKTsKICBsZXQgcmVjb3JkcyA9IGxvYWRSZWNvcmRzKCk7CiAgbGV0IHZhaWxsYW50TW9udGhzID0gbG9hZFZhaWxsYW50TW9udGhzKCk7CiAgbGV0IG9zdHJvbUxpdmUgPSBsb2FkT3N0cm9tQ2FjaGUoKTsKICBsZXQgb3N0cm9tQnVzeSA9IGZhbHNlOwogIGxldCBvc3Ryb21UaW1lciA9IG51bGw7CiAgbGV0IHRvYXN0VGltZXIgPSBudWxsOwogIGxldCByZXNpemVUaW1lciA9IG51bGw7CiAgbGV0IGN1cnJlbnRWaWV3ID0gImRhc2hib2FyZFZpZXciOwogIGxldCBtZXRlclJlYWRpbmdzID0gbG9hZE1ldGVyUmVhZGluZ3MoKTsKICBsZXQgc3luY1N0YXRlID0gbG9hZFN5bmNTdGF0ZSgpOwogIGxldCBzeW5jQnVzeSA9IGZhbHNlOwogIGxldCBzeW5jQXBwbHlpbmcgPSBmYWxzZTsKICBsZXQgc3luY0RlYm91bmNlVGltZXIgPSBudWxsOwogIGxldCBzeW5jUG9sbFRpbWVyID0gbnVsbDsKICBsZXQgb3N0cm9tSGlzdG9yeUJ1c3kgPSBmYWxzZTsKICBsZXQgb3N0cm9tUHJpY2VTdGF0cyA9IGxvYWRPc3Ryb21QcmljZVN0YXRzKCk7CiAgbGV0IG9zdHJvbVByaWNlU3RhdHNCdXN5ID0gZmFsc2U7CgogIC8qIENsaW1hdGUgNi4zOiBWYWlsbGFudCBob3VybHkgZGF0YSBhcmUgcmVkdWNlZCB0byBwcml2YWN5LXByZXNlcnZpbmcgbW9udGhseSBhZ2dyZWdhdGVzLiAqLwogIGNvbnN0IENMSU1BVEVfTU9OVEhfS0VZPSJlbGRlaG9mLXY2LWNsaW1hdGUtbW9udGhzLXY2MzAiOwogIGNvbnN0IENMSU1BVEVfV0VBVEhFUl9LRVk9ImVsZGVob2YtdjYtY2xpbWF0ZS13ZWF0aGVyLXY2MzAiOwogIGxldCBjbGltYXRlTW9udGhzPWxvYWRDbGltYXRlTW9udGhzKCk7CiAgZnVuY3Rpb24gY2xpbWF0ZVdlYXRoZXJPYmplY3QodmFsdWUpewogICAgcmV0dXJuIHZhbHVlICYmIHR5cGVvZiB2YWx1ZT09PSJvYmplY3QiICYmICFBcnJheS5pc0FycmF5KHZhbHVlKT92YWx1ZTp7fTsKICB9CiAgbGV0IGNsaW1hdGVXZWF0aGVyPWNsaW1hdGVXZWF0aGVyT2JqZWN0KHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oQ0xJTUFURV9XRUFUSEVSX0tFWSkse30pKTsKICBsZXQgY2xpbWF0ZUJ1c3k9ZmFsc2U7CiAgZnVuY3Rpb24gY2xpbWF0ZU51bWJlcihyYXcpe3JldHVybiByYXc9PW51bGx8fHJhdz09PSIiP251bGw6KE51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3KSk/TnVtYmVyKHJhdyk6bnVsbCk7fQogIGZ1bmN0aW9uIGNsaW1hdGVTYW5pdGl6ZShpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHggb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pewogICAgICBjb25zdCBtb250aD1TdHJpbmcoeD8ubW9udGh8fCIiKTsKICAgICAgaWYoIS9eXGR7NH0tKDBbMS05XXwxWzAtMl0pJC8udGVzdChtb250aCkpY29udGludWU7CiAgICAgIGNvbnN0IHJvdz17bW9udGgsdXBkYXRlZEF0OlN0cmluZyh4LnVwZGF0ZWRBdHx8IiIpfTsKICAgICAgZm9yKGNvbnN0IGsgb2YgWyJvdXRkb29yTWVhbiIsIm91dGRvb3JNaW4iLCJvdXRkb29yTWF4Iiwib3V0ZG9vckhvdXJzIiwicm9vbU1lYW4iLCJyb29tSG91cnMiLCJzZXRwb2ludE1lYW4iLCJzZXRwb2ludEhvdXJzIiwiZGh3TWVhbiIsImRod0hvdXJzIl0pcm93W2tdPWNsaW1hdGVOdW1iZXIoeFtrXSk7CiAgICAgIG1hcC5zZXQobW9udGgscm93KTsKICAgIH0KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOwogIH0KICBmdW5jdGlvbiBsb2FkQ2xpbWF0ZU1vbnRocygpe3JldHVybiBjbGltYXRlU2FuaXRpemUoc2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShDTElNQVRFX01PTlRIX0tFWSksW10pKTt9CiAgZnVuY3Rpb24gc2F2ZUNsaW1hdGVNb250aHMoaXRlbXMpewogICAgY2xpbWF0ZU1vbnRocz1jbGltYXRlU2FuaXRpemUoaXRlbXMpOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oQ0xJTUFURV9NT05USF9LRVksSlNPTi5zdHJpbmdpZnkoY2xpbWF0ZU1vbnRocykpOwogICAgaWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygxMjAwKTsKICB9CiAgZnVuY3Rpb24gY2xpbWF0ZVByZXZpZXcoZmlsZXMpewogICAgY29uc3QgY29scz17InN5c3RlbS10ZW1wZXJhdHVyZSI6W1siT3V0ZG9vclRlbXBlcmF0dXJlIiwib3V0ZG9vciJdXSwiem9uZS10ZW1wZXJhdHVyZSI6W1siQ3VycmVudFJvb21UZW1wZXJhdHVyZSIsInJvb20iXSxbIk1hbnVhbE1vZGVTZXRwb2ludEhlYXRpbmciLCJzZXRwb2ludCJdXSwiZGh3LXRlbXBlcmF0dXJlIjpbWyJEaHdUYW5rVGVtcGVyYXR1cmUiLCJkaHciXV19OwogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCBmaWxlIG9mIGZpbGVzLmZpbHRlcihmPT5jb2xzW2YudHlwZV0pKXsKICAgICAgZm9yKGNvbnN0IHIgb2YgZmlsZS5yb3dzKXsKICAgICAgICBpZighbWFwLmhhcyhyLm1vbnRoS2V5KSltYXAuc2V0KHIubW9udGhLZXkse21vbnRoOnIubW9udGhLZXksc2VyaWVzOnt9fSk7CiAgICAgICAgY29uc3QgYnVja2V0PW1hcC5nZXQoci5tb250aEtleSk7CiAgICAgICAgZm9yKGNvbnN0IFtjb2x1bW4sa2luZF0gb2YgY29sc1tmaWxlLnR5cGVdKXsKICAgICAgICAgIGNvbnN0IHZhbHVlPXIudmFsdWVzW2NvbHVtbl07CiAgICAgICAgICBpZighTnVtYmVyLmlzRmluaXRlKHZhbHVlKSljb250aW51ZTsKICAgICAgICAgIGlmKCFidWNrZXQuc2VyaWVzW2tpbmRdKWJ1Y2tldC5zZXJpZXNba2luZF09bmV3IE1hcCgpOwogICAgICAgICAgY29uc3Qgb2xkPWJ1Y2tldC5zZXJpZXNba2luZF0uZ2V0KHIuZGF0ZVRpbWUpOwogICAgICAgICAgaWYob2xkIT09dW5kZWZpbmVkJiZNYXRoLmFicyhvbGQtdmFsdWUpPi4wNSl0aHJvdyBFcnJvcigiQWJ3ZWljaGVuZGUgZG9wcGVsdGUgVGVtcGVyYXR1cm1lc3N1bmdlbiBpbiAiK3IubW9udGhLZXkpOwogICAgICAgICAgYnVja2V0LnNlcmllc1traW5kXS5zZXQoci5kYXRlVGltZSx2YWx1ZSk7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0ubWFwKGI9PnsKICAgICAgY29uc3Qgcm93PXttb250aDpiLm1vbnRoLHVwZGF0ZWRBdDpzdGFtcH07CiAgICAgIGZvcihjb25zdCBraW5kIG9mIFsib3V0ZG9vciIsInJvb20iLCJzZXRwb2ludCIsImRodyJdKXsKICAgICAgICBjb25zdCB2PVsuLi4oYi5zZXJpZXNba2luZF0/LnZhbHVlcygpfHxbXSldOwogICAgICAgIGlmKCF2Lmxlbmd0aCljb250aW51ZTsKICAgICAgICByb3dba2luZCsiTWVhbiJdPU1hdGgucm91bmQodi5yZWR1Y2UoKGEseCk9PmEreCwwKS92Lmxlbmd0aCoxMDApLzEwMDsKICAgICAgICByb3dba2luZCsiSG91cnMiXT12Lmxlbmd0aDsKICAgICAgICBpZihraW5kPT09Im91dGRvb3IiKXtyb3cub3V0ZG9vck1pbj1NYXRoLm1pbiguLi52KTtyb3cub3V0ZG9vck1heD1NYXRoLm1heCguLi52KTt9CiAgICAgIH0KICAgICAgcmV0dXJuIHJvdzsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBjbGltYXRlSW1wb3J0KGl0ZW1zKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKGNsaW1hdGVNb250aHMubWFwKHI9PltyLm1vbnRoLHJdKSk7CiAgICBmb3IoY29uc3Qgcm93IG9mIGl0ZW1zKW1hcC5zZXQocm93Lm1vbnRoLHsuLi5tYXAuZ2V0KHJvdy5tb250aCksLi4ucm93fSk7CiAgICBzYXZlQ2xpbWF0ZU1vbnRocyhbLi4ubWFwLnZhbHVlcygpXSk7CiAgfQogIGZ1bmN0aW9uIG1vbnRobHlWYWlsbGFudEltcG9ydHMoZmlsZXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCBmaWxlIG9mIGZpbGVzLmZpbHRlcihmPT5mLnR5cGU9PT0ibW9udGhseS1lbmVyZ3kiKSl7CiAgICAgIGZvcihjb25zdCByb3cgb2YgZmlsZS5yb3dzKXsKICAgICAgICBjb25zdCByYXc9cm93LnZhbHVlcyxtPXJvdy5tb250aEtleTsKICAgICAgICBpZihyYXcuY29tcGxldGUhPT10cnVlfHxyYXcuZXN0aW1hdGVkPT09dHJ1ZXx8bT5jdXJyZW50TW9udGhLZXkoKSljb250aW51ZTsKICAgICAgICBjb25zdCBmaWVsZHM9WyJlbGVjdHJpY2l0eUtXaCIsImhlYXRHZW5lcmF0ZWRLV2giLCJoZWF0aW5nRWxlY3RyaWNpdHlLV2giLCJkaHdFbGVjdHJpY2l0eUtXaCIsImhlYXRpbmdIZWF0S1doIiwiZGh3SGVhdEtXaCJdOwogICAgICAgIGlmKGZpZWxkcy5zb21lKGs9PiFOdW1iZXIuaXNGaW5pdGUocmF3W2tdKXx8cmF3W2tdPDApKWNvbnRpbnVlOwogICAgICAgIGNvbnN0IHllYXI9TnVtYmVyKG0uc2xpY2UoMCw0KSksbW9udGg9TnVtYmVyKG0uc2xpY2UoNSkpOwogICAgICAgIG1hcC5zZXQobSx7bW9udGg6bSxlbGVjdHJpY2l0eUtXaDpyYXcuZWxlY3RyaWNpdHlLV2gsaGVhdEdlbmVyYXRlZEtXaDpyYXcuaGVhdEdlbmVyYXRlZEtXaCxoZWF0aW5nRWxlY3RyaWNpdHlLV2g6cmF3LmhlYXRpbmdFbGVjdHJpY2l0eUtXaCxkaHdFbGVjdHJpY2l0eUtXaDpyYXcuZGh3RWxlY3RyaWNpdHlLV2gsaGVhdGluZ0hlYXRLV2g6cmF3LmhlYXRpbmdIZWF0S1doLGRod0hlYXRLV2g6cmF3LmRod0hlYXRLV2gsY29tcGxldGU6dHJ1ZSxjb3ZlcmFnZVN0YXJ0Om0rIi0wMSIsY292ZXJhZ2VFbmQ6bSsiLSIrU3RyaW5nKG5ldyBEYXRlKHllYXIsbW9udGgsMCkuZ2V0RGF0ZSgpKS5wYWRTdGFydCgyLCIwIiksYmxvY2tlZDpmYWxzZX0pOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV07CiAgfQogIGNvbnN0IGNsaW1hdGVGbXQ9KHYsZD0wKT0+TnVtYmVyLmlzRmluaXRlKHYpP251bSh2LGQpOiLigJMiOwogIGZ1bmN0aW9uIGNsaW1hdGVXZWF0aGVyRm9yKG1vbnRoKXtyZXR1cm4gY2xpbWF0ZVdlYXRoZXI/Llttb250aC5zbGljZSgwLDQpXT8ubW9udGhzPy5maW5kKHg9PngubW9udGg9PT1tb250aCl8fG51bGw7fQogIGZ1bmN0aW9uIGNsaW1hdGVSb3dzRm9yKHllYXIpewogICAgY29uc3QgcmVmZXJlbmNlPW5ldyBNYXAoKTsKICAgIGZvcihsZXQgaT0xO2k8PTEyO2krKyl7CiAgICAgIGNvbnN0IG1tPVN0cmluZyhpKS5wYWRTdGFydCgyLCIwIik7CiAgICAgIGNvbnN0IGhpc3Q9WzIwMjQsMjAyNV0ubWFwKHk9PmNsaW1hdGVXZWF0aGVyRm9yKHkrIi0iK21tKSkuZmlsdGVyKHc9Pnc/LmNvbXBsZXRlJiZOdW1iZXIuaXNGaW5pdGUody5oZGQxNSkpOwogICAgICBpZihoaXN0Lmxlbmd0aD09PTIpcmVmZXJlbmNlLnNldChtbSwoaGlzdFswXS5oZGQxNStoaXN0WzFdLmhkZDE1KS8yKTsKICAgIH0KICAgIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6MTJ9LChfLGkpPT57CiAgICAgIGNvbnN0IG1vbnRoPXllYXIrIi0iK1N0cmluZyhpKzEpLnBhZFN0YXJ0KDIsIjAiKTsKICAgICAgY29uc3Qgcj1yZWNvcmRGb3JNb250aChtb250aCksdz1jbGltYXRlV2VhdGhlckZvcihtb250aCksc2Vuc29yPWNsaW1hdGVNb250aHMuZmluZCh4PT54Lm1vbnRoPT09bW9udGgpLHZhbGlkPXc/LmNvbXBsZXRlJiZOdW1iZXIuaXNGaW5pdGUody5oZGQxNSk7CiAgICAgIGNvbnN0IGhlYXQ9TnVtYmVyLmlzRmluaXRlKHI/LmhlYXRpbmdIZWF0KT9yLmhlYXRpbmdIZWF0Om51bGw7CiAgICAgIGNvbnN0IGRodz1OdW1iZXIuaXNGaW5pdGUocj8uZGh3SGVhdCk/ci5kaHdIZWF0Om51bGw7CiAgICAgIGNvbnN0IGJhc2VsaW5lPXJlZmVyZW5jZS5nZXQobW9udGguc2xpY2UoNSkpOwogICAgICAvLyBCZWxvdyAxNSBkZWdyZWUtZGF5cywgbm9ybWFsaXphdGlvbiBpcyBudW1lcmljYWxseSB1bnN0YWJsZSAoc3VtbWVyIGhlYXRpbmcgbmVhcmx5IG9mZikuCiAgICAgIGNvbnN0IG5vcm1hbGl6ZWQ9aGVhdCE9PW51bGwmJnZhbGlkJiZ3LmhkZDE1Pj0xNSYmTnVtYmVyLmlzRmluaXRlKGJhc2VsaW5lKSYmYmFzZWxpbmU+PTE1P2hlYXQqYmFzZWxpbmUvdy5oZGQxNTpudWxsOwogICAgICByZXR1cm4ge21vbnRoLHcsc2Vuc29yLGhlYXQsZGh3LHZhbGlkLG5vcm1hbGl6ZWR9OwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJDbGltYXRlTXVsdGlZZWFyKCl7CiAgICBjb25zdCBlbD0kKCJjbGltYXRlTXVsdGlZZWFyIik7aWYoIWVsKXJldHVybjsKICAgIGNvbnN0IGF2YWlsYWJsZT1bLi4ubmV3IFNldChyZWNvcmRzLm1hcChyPT5OdW1iZXIoci5tb250aD8uc2xpY2UoMCw0KSkpKV0uZmlsdGVyKHk9Pnk+PTIwMjQmJnk8PW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSkuc29ydCgpOwogICAgY29uc3QgY2FuZGlkYXRlcz1hdmFpbGFibGUubWFwKHk9Pih7eWVhcjp5LHJvd3M6Y2xpbWF0ZVJvd3NGb3IoeSl9KSkuZmlsdGVyKHg9Pngucm93cy5maWx0ZXIocj0+ci5ub3JtYWxpemVkIT09bnVsbCkubGVuZ3RoPj0zKTsKICAgIGlmKGNhbmRpZGF0ZXMubGVuZ3RoPDIpe2VsLnRleHRDb250ZW50PSJEZXIgZGlyZWt0ZSBKYWhyZXN2ZXJnbGVpY2ggZXJzY2hlaW50LCBzb2JhbGQgbWluZGVzdGVucyB6d2VpIEphaHJlIGpld2VpbHMgZHJlaSB2b2xsc3TDpG5kaWdlIHZlcmdsZWljaGJhcmUgTW9uYXRlIG1pdCBIZWl6d8Okcm1lIHVuZCBXZXR0ZXJkYXRlbiBiZXNpdHplbi4iO3JldHVybjt9CiAgICBjb25zdCBtb250aHM9QXJyYXkuZnJvbSh7bGVuZ3RoOjEyfSwoXyxpKT0+aSsxKS5maWx0ZXIobT0+Y2FuZGlkYXRlcy5ldmVyeShjPT5jLnJvd3NbbS0xXT8ubm9ybWFsaXplZCE9PW51bGwpKTsKICAgIGlmKG1vbnRocy5sZW5ndGg8Myl7ZWwudGV4dENvbnRlbnQ9IkbDvHIgZGllc2UgSmFocmUgZ2lidCBlcyBub2NoIG5pY2h0IGdlbsO8Z2VuZCBnZW1laW5zYW1lIE1vbmF0ZS4gRmVobGVuZGUgVmFpbGxhbnQtV8Okcm1lLSBvZGVyIFdldHRlcndlcnRlIGVyZ8Okbnplbi4iO3JldHVybjt9CiAgICBjb25zdCBiYXNlWWVhcj1jYW5kaWRhdGVzWzBdLnllYXIsYmFzZUhlYXQ9bW9udGhzLnJlZHVjZSgocyxtKT0+cytjYW5kaWRhdGVzWzBdLnJvd3NbbS0xXS5ub3JtYWxpemVkLDApOwogICAgY29uc3QgaGVhZGVyPSc8cCBjbGFzcz0ibXV0ZWQiPkRpcmVrdHZlcmdsZWljaCBudXIgZ2xlaWNoZXIsIHZvbGxzdMOkbmRpZyBlcmZhc3N0ZXIgTW9uYXRlOiAnK21vbnRocy5tYXAobT0+TU9OVEhTW20tMV0pLmpvaW4oIiwgIikrJy4gV2FybXdhc3NlciBpc3QgYXVzZ2VzY2hsb3NzZW4uPC9wPic7CiAgICBjb25zdCB0YWJsZT0nPGRpdiBjbGFzcz0idGFibGUtc2Nyb2xsIj48dGFibGU+PHRoZWFkPjx0cj48dGg+SmFocjwvdGg+PHRoPkhlaXp3w6RybWUgZ2VtZXNzZW4ga1doPC90aD48dGg+V2l0dGVydW5nc2JlcmVpbmlndCBrV2g8L3RoPjx0aD5HZWdlbsO8YmVyICcrYmFzZVllYXIrJzwvdGg+PC90cj48L3RoZWFkPjx0Ym9keT4nKwogICAgICBjYW5kaWRhdGVzLm1hcChjPT57CiAgICAgICAgY29uc3Qgb3JpZ2luYWw9bW9udGhzLnJlZHVjZSgocyxtKT0+cytjLnJvd3NbbS0xXS5oZWF0LDApOwogICAgICAgIGNvbnN0IGFkanVzdGVkPW1vbnRocy5yZWR1Y2UoKHMsbSk9PnMrYy5yb3dzW20tMV0ubm9ybWFsaXplZCwwKTsKICAgICAgICBjb25zdCBkZWx0YT1iYXNlSGVhdD4wPyhhZGp1c3RlZC9iYXNlSGVhdC0xKSoxMDA6bnVsbDsKICAgICAgICByZXR1cm4gJzx0cj48dGQ+JytjLnllYXIrJzwvdGQ+PHRkPicrbnVtKG9yaWdpbmFsKSsnPC90ZD48dGQ+JytudW0oYWRqdXN0ZWQpKyc8L3RkPjx0ZD4nKyhkZWx0YT09PW51bGw/IuKAkyI6cGN0KGRlbHRhKSkrJzwvdGQ+PC90cj4nOwogICAgICB9KS5qb2luKCIiKSsnPC90Ym9keT48L3RhYmxlPjwvZGl2Pic7CiAgICBlbC5pbm5lckhUTUw9aGVhZGVyK3RhYmxlOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQ2xpbWF0ZUFuYWx5c2lzKCl7CiAgICBpZighJCgiY2xpbWF0ZU1ldHJpY3MiKSlyZXR1cm47CiAgICBjb25zdCB5ZWFyPU51bWJlcigkKCJhbmFseXNpc1llYXIiKS52YWx1ZSl8fG5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSxyb3dzPWNsaW1hdGVSb3dzRm9yKHllYXIpOwogICAgY29uc3QgaD1yb3dzLmZpbHRlcih4PT54LmhlYXQhPT1udWxsKSx3PXJvd3MuZmlsdGVyKHg9PnguZGh3IT09bnVsbCksbj1yb3dzLmZpbHRlcih4PT54Lm5vcm1hbGl6ZWQhPT1udWxsKSx3ZWF0aGVyPXJvd3MuZmlsdGVyKHg9PngudmFsaWQpOwogICAgY29uc3QgbWV0cmljcz1bCiAgICAgIFsiSGVpenfDpHJtZSIsaC5sZW5ndGg/Y2xpbWF0ZUZtdChoLnJlZHVjZSgocyx4KT0+cyt4LmhlYXQsMCkpKyIga1doIjoi4oCTIixoLmxlbmd0aCsiIE1vbmF0ZSJdLAogICAgICBbIldhcm13YXNzZXJ3w6RybWUiLHcubGVuZ3RoP2NsaW1hdGVGbXQody5yZWR1Y2UoKHMseCk9PnMreC5kaHcsMCkpKyIga1doIjoi4oCTIiwib2huZSBXaXR0ZXJ1bmdzYmVyZWluaWd1bmciXSwKICAgICAgWyJIZWl6Z3JhZHRhZ2UiLHdlYXRoZXIubGVuZ3RoP2NsaW1hdGVGbXQod2VhdGhlci5yZWR1Y2UoKHMseCk9PnMreC53LmhkZDE1LDApKSsiIEvCt2QiOiLigJMiLCJCYXNpcyAxNSDCsEM7IHZvbGxzdMOkbmRpZ2UgTW9uYXRlIl0sCiAgICAgIFsiQmVyZWluaWd0ZSBIZWl6d8Okcm1lIixuLmxlbmd0aD9jbGltYXRlRm10KG4ucmVkdWNlKChzLHgpPT5zK3gubm9ybWFsaXplZCwwKSkrIiBrV2giOiLigJMiLG4ubGVuZ3RoKyIgdmVyZ2xlaWNoYmFyZSBNb25hdGUiXQogICAgXTsKICAgICQoImNsaW1hdGVNZXRyaWNzIikuaW5uZXJIVE1MPW1ldHJpY3MubWFwKChbYSxiLGNdKT0+JzxhcnRpY2xlPjxzcGFuPicrZXNjYXBlSHRtbChhKSsnPC9zcGFuPjxzdHJvbmc+Jytlc2NhcGVIdG1sKGIpKyc8L3N0cm9uZz48c21hbGw+Jytlc2NhcGVIdG1sKGMpKyc8L3NtYWxsPjwvYXJ0aWNsZT4nKS5qb2luKCIiKTsKICAgICQoImNsaW1hdGVSb3dzIikuaW5uZXJIVE1MPXJvd3MubWFwKHg9Pic8dHI+PHRkPicrZXNjYXBlSHRtbChtb250aExhYmVsKHgubW9udGgsZmFsc2UpKSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHgudz8ubWVhblRlbXAsMSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LnNlbnNvcj8ub3V0ZG9vck1lYW4sMSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LnNlbnNvcj8ucm9vbU1lYW4sMSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LnNlbnNvcj8uZGh3TWVhbiwxKSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHgudmFsaWQ/eC53LmhkZDE1Om51bGwpKyc8L3RkPjx0ZD4nK2NsaW1hdGVGbXQoeC5oZWF0KSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHguZGh3KSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHgubm9ybWFsaXplZCkrJzwvdGQ+PC90cj4nKS5qb2luKCIiKTsKICAgIHJlbmRlckNsaW1hdGVNdWx0aVllYXIoKTsKICAgICQoImNsaW1hdGVJbmZvIikudGV4dENvbnRlbnQ9KGNsaW1hdGVCdXN5PyJIaXN0b3Jpc2NoZSBXZXR0ZXJkYXRlbiB3ZXJkZW4gZ2VsYWRlbiDigKYgIjoiIikrKG4ubGVuZ3RoP24ubGVuZ3RoKyIgd2l0dGVydW5nc2JlcmVpbmlndGUgTW9uYXRlLiI6IkJpdHRlIGhpc3RvcmlzY2hlIFdldHRlcmRhdGVuIGxhZGVuLiAiKSsiUmVmZXJlbnogamUgS2FsZW5kZXJtb25hdDogSGVpemdyYWR0YWdlIDIwMjQvMjAyNS4gTnVyIGdsZWljaGUgWmVpdHLDpHVtZSB2ZXJnbGVpY2hlbiwgV2FybXdhc3NlciBnZXRyZW5udC4iOwogIH0KICBhc3luYyBmdW5jdGlvbiBsb2FkQ2xpbWF0ZVdlYXRoZXIoKXsKICAgIGlmKGNsaW1hdGVCdXN5KXJldHVybjsKICAgIGlmKCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe3RvYXN0KCJFbGRlaG9mLUFwcC1TY2hsw7xzc2VsIHVudGVyIERhdGVuIOKGkiBPc3Ryb20gc3BlaWNoZXJuIik7cmV0dXJuO30KICAgIC8vIEpTT04ucGFyc2UobnVsbCkgcmV0dXJucyBudWxsOyBhbHdheXMgcmVzdG9yZSBhIG11dGFibGUgb2JqZWN0IHdpdGhvdXQgY2xlYXJpbmcgYW55IG90aGVyIGFwcCBkYXRhLgogICAgY2xpbWF0ZVdlYXRoZXI9Y2xpbWF0ZVdlYXRoZXJPYmplY3QoY2xpbWF0ZVdlYXRoZXIpOwogICAgY2xpbWF0ZUJ1c3k9dHJ1ZTtjbGltYXRlV2VhdGhlckVycm9yPSIiO3JlbmRlckNsaW1hdGVBbmFseXNpcygpO3JlbmRlckRhc2hib2FyZENsaW1hdGUoKTsKICAgIHRyeXsKICAgICAgY29uc3QgeWVhcnM9Wy4uLm5ldyBTZXQoWy4uLnJlY29yZHMubWFwKHI9Pk51bWJlcihyLm1vbnRoLnNsaWNlKDAsNCkpKSwyMDI0LDIwMjVdKV0uZmlsdGVyKHk9Pnk+PTIwMjMmJnk8PW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSkuc29ydCgpOwogICAgICBmb3IoY29uc3QgeWVhciBvZiB5ZWFycyl7CiAgICAgICAgaWYoY2xpbWF0ZVdlYXRoZXI/Llt5ZWFyXT8uY29tcGxldGUmJkRhdGUubm93KCktRGF0ZS5wYXJzZShjbGltYXRlV2VhdGhlclt5ZWFyXS5jYWNoZWRBdHx8IiIpPDkwKjg2NDAwZTMpY29udGludWU7CiAgICAgICAgY29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2goIi9hcGkvd2VhdGhlci9hcmNoaXZlP3llYXI9Iit5ZWFyLHtoZWFkZXJzOnsieC1lbGRlaG9mLWtleSI6c2V0dGluZ3Mub3N0cm9tQXBwS2V5fSxjYWNoZToibm8tc3RvcmUifSk7CiAgICAgICAgY29uc3QgcGF5bG9hZD1hd2FpdCByZXNwb25zZS5qc29uKCk7CiAgICAgICAgaWYoIXJlc3BvbnNlLm9rKXRocm93IEVycm9yKHBheWxvYWQuZXJyb3J8fCJIaXN0b3Jpc2NoZSBXZXR0ZXJkYXRlbiBmZWhsZW4iKTsKICAgICAgICBpZighcGF5bG9hZHx8IUFycmF5LmlzQXJyYXkocGF5bG9hZC5tb250aHMpfHxwYXlsb2FkLnllYXIhPT15ZWFyKXsKICAgICAgICAgIHRocm93IEVycm9yKCJEYXMgV2V0dGVyYXJjaGl2IGxpZWZlcnRlIGtlaW5lIGfDvGx0aWdlbiBNb25hdHN3ZXJ0ZSBmw7xyICIreWVhcisiLiIpOwogICAgICAgIH0KICAgICAgICBjbGltYXRlV2VhdGhlclt5ZWFyXT1wYXlsb2FkOwogICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKENMSU1BVEVfV0VBVEhFUl9LRVksSlNPTi5zdHJpbmdpZnkoY2xpbWF0ZVdlYXRoZXIpKTsKICAgICAgICByZW5kZXJDbGltYXRlQW5hbHlzaXMoKTtyZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7CiAgICAgIH0KICAgICAgdG9hc3QoIldldHRlcmhpc3RvcmllIGFrdHVhbGlzaWVydCIpOwogICAgfWNhdGNoKGUpe2NsaW1hdGVXZWF0aGVyRXJyb3I9ZS5tZXNzYWdlO3RvYXN0KCJXZXR0ZXI6ICIrZS5tZXNzYWdlKTt9CiAgICBmaW5hbGx5e2NsaW1hdGVCdXN5PWZhbHNlO3JlbmRlckNsaW1hdGVBbmFseXNpcygpO3JlbmRlckRhc2hib2FyZENsaW1hdGUoKTt9CiAgfQoKICBmdW5jdGlvbiBzYWZlSnNvblBhcnNlKHZhbHVlLCBmYWxsYmFjaz1udWxsKXsgdHJ5e3JldHVybiBKU09OLnBhcnNlKHZhbHVlKTt9Y2F0Y2h7cmV0dXJuIGZhbGxiYWNrO30gfQogIGZ1bmN0aW9uIG51bGxhYmxlTnVtYmVyKHZhbHVlKXsgaWYodmFsdWU9PT0iInx8dmFsdWU9PT1udWxsfHx2YWx1ZT09PXVuZGVmaW5lZClyZXR1cm4gbnVsbDsgY29uc3Qgbj1OdW1iZXIodmFsdWUpOyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pP246bnVsbDsgfQogIGZ1bmN0aW9uIHNvcnRlZChpdGVtcz1yZWNvcmRzKXsgcmV0dXJuIFsuLi5pdGVtc10uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsgfQogIGZ1bmN0aW9uIGN1cnJlbnRNb250aEtleSgpeyBjb25zdCBkPW5ldyBEYXRlKCk7IHJldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9YDsgfQogIGZ1bmN0aW9uIG1vbnRoTGFiZWwobW9udGgsbG9uZz10cnVlKXsgY29uc3QgW3ksbV09U3RyaW5nKG1vbnRoKS5zcGxpdCgiLSIpLm1hcChOdW1iZXIpOyBpZigheXx8IW0pcmV0dXJuIG1vbnRoOyByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIixsb25nP3ttb250aDoibG9uZyIseWVhcjoibnVtZXJpYyJ9Onttb250aDoic2hvcnQiLHllYXI6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHksbS0xLDEpKTsgfQogIGZ1bmN0aW9uIG51bSh2YWx1ZSxkaWdpdHM9MCl7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHZhbHVlKSk/bmV3IEludGwuTnVtYmVyRm9ybWF0KCJkZS1ERSIse21pbmltdW1GcmFjdGlvbkRpZ2l0czpkaWdpdHMsbWF4aW11bUZyYWN0aW9uRGlnaXRzOmRpZ2l0c30pLmZvcm1hdChOdW1iZXIodmFsdWUpKToi4oCTIjsgfQogIGZ1bmN0aW9uIGV1cm8odmFsdWUpeyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcih2YWx1ZSkpP25ldyBJbnRsLk51bWJlckZvcm1hdCgiZGUtREUiLHtzdHlsZToiY3VycmVuY3kiLGN1cnJlbmN5OiJFVVIifSkuZm9ybWF0KE51bWJlcih2YWx1ZSkpOiLigJMiOyB9CiAgZnVuY3Rpb24gcGN0KHZhbHVlKXsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIodmFsdWUpKT9gJHt2YWx1ZT4wPyIrIjoiIn0ke251bSh2YWx1ZSwxKX0gJWA6IuKAkyI7IH0KICBmdW5jdGlvbiBlc2NhcGVIdG1sKHZhbHVlKXsgcmV0dXJuIFN0cmluZyh2YWx1ZT8/IiIpLnJlcGxhY2UoL1smPD4iJ10vZyxjaD0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsIlwiIjoiJnF1b3Q7IiwiJyI6IiYjMzk7In1bY2hdKSk7IH0KICBmdW5jdGlvbiBjc3ZDZWxsKHZhbHVlKXsgY29uc3Qgcz1TdHJpbmcodmFsdWU/PyIiKTsgcmV0dXJuIGAiJHtzLnJlcGxhY2UoLyIvZywnIiInKX0iYDsgfQogIGZ1bmN0aW9uIGRhdGVTdGFtcCgpeyBjb25zdCBkPW5ldyBEYXRlKCk7IHJldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKGQuZ2V0RGF0ZSgpKS5wYWRTdGFydCgyLCIwIil9YDsgfQoKICBmdW5jdGlvbiBzYW5pdGl6ZVJlY29yZChyYXcpewogICAgY29uc3QgbW9udGg9U3RyaW5nKHJhdz8ubW9udGh8fCIiKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChtb250aCkpcmV0dXJuIG51bGw7CiAgICByZXR1cm4gewogICAgICBtb250aCwKICAgICAgaGVhdFB1bXA6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRQdW1wKSwKICAgICAgYW5uZXg6bnVsbGFibGVOdW1iZXIocmF3LmFubmV4KSwKICAgICAgdG90YWw6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsKSwKICAgICAgcHJpY2VDdDpudWxsYWJsZU51bWJlcihyYXcucHJpY2VDdCA/PyByYXcuYXZlcmFnZVByaWNlQ3QpLAogICAgICBiYXNlRmVlOm51bGxhYmxlTnVtYmVyKHJhdy5iYXNlRmVlKSwKICAgICAgbm90ZTpTdHJpbmcocmF3Lm5vdGV8fCIiKS50cmltKCkuc2xpY2UoMCw4MDApLAogICAgICBoZWF0R2VuZXJhdGVkOm51bGxhYmxlTnVtYmVyKHJhdy5oZWF0R2VuZXJhdGVkKSwKICAgICAgaGVhdGluZ0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKHJhdy5oZWF0aW5nRWxlY3RyaWNpdHkpLAogICAgICBkaHdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcihyYXcuZGh3RWxlY3RyaWNpdHkpLAogICAgICBoZWF0aW5nSGVhdDpudWxsYWJsZU51bWJlcihyYXcuaGVhdGluZ0hlYXQpLAogICAgICBkaHdIZWF0Om51bGxhYmxlTnVtYmVyKHJhdy5kaHdIZWF0KSwKICAgICAgaGVhdFB1bXBTb3VyY2U6U3RyaW5nKHJhdy5oZWF0UHVtcFNvdXJjZXx8IiIpLnNsaWNlKDAsNjApLAogICAgICBoZWF0UHVtcFVwZGF0ZWRBdDpyYXcuaGVhdFB1bXBVcGRhdGVkQXQ/U3RyaW5nKHJhdy5oZWF0UHVtcFVwZGF0ZWRBdCk6bnVsbCwKICAgICAgbWV0ZXJSZWFkaW5nRGF0ZTpyYXcubWV0ZXJSZWFkaW5nRGF0ZT9TdHJpbmcocmF3Lm1ldGVyUmVhZGluZ0RhdGUpOm51bGwsCiAgICAgIHByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZTpyYXcucHJldmlvdXNNZXRlclJlYWRpbmdEYXRlP1N0cmluZyhyYXcucHJldmlvdXNNZXRlclJlYWRpbmdEYXRlKTpudWxsLAogICAgICB0b3RhbE1ldGVyUmVhZGluZzpudWxsYWJsZU51bWJlcihyYXcudG90YWxNZXRlclJlYWRpbmcpLAogICAgICBhbm5leE1ldGVyUmVhZGluZzpudWxsYWJsZU51bWJlcihyYXcuYW5uZXhNZXRlclJlYWRpbmcpLAogICAgICBtZXRlclNvdXJjZTpTdHJpbmcocmF3Lm1ldGVyU291cmNlfHwiIikuc2xpY2UoMCw2MCksCiAgICAgIHByaWNlU291cmNlOlN0cmluZyhyYXcucHJpY2VTb3VyY2V8fCIiKS5zbGljZSgwLDgwKSwKICAgICAgcHJpY2VVcGRhdGVkQXQ6cmF3LnByaWNlVXBkYXRlZEF0P1N0cmluZyhyYXcucHJpY2VVcGRhdGVkQXQpOm51bGwsCiAgICAgIG9zdHJvbVZhcmlhYmxlQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tVmFyaWFibGVDb3N0RXVyKSwKICAgICAgb3N0cm9tVG90YWxDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy5vc3Ryb21Ub3RhbENvc3RFdXIpLAogICAgICBvc3Ryb21Db25zdW1wdGlvbktXaDpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tQ29uc3VtcHRpb25LV2gpLAogICAgICBvc3Ryb21QcmljZUNvbXBsZXRlOkJvb2xlYW4ocmF3Lm9zdHJvbVByaWNlQ29tcGxldGUpLAogICAgICB1cGRhdGVkQXQ6cmF3LnVwZGF0ZWRBdD9TdHJpbmcocmF3LnVwZGF0ZWRBdCk6bnVsbCwKICAgICAgY2xvc2VkOkJvb2xlYW4ocmF3LmNsb3NlZCksCiAgICAgIGNsb3NlZEF0OnJhdy5jbG9zZWRBdD9TdHJpbmcocmF3LmNsb3NlZEF0KTpudWxsCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZVJlY29yZHMoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10peyBjb25zdCByPXNhbml0aXplUmVjb3JkKHJhdyk7IGlmKHIpbWFwLnNldChyLm1vbnRoLHIpOyB9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gZGVyaXZlZChyKXsgaWYoIVtyPy5oZWF0UHVtcCxyPy5hbm5leCxyPy50b3RhbF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSlyZXR1cm4gbnVsbDsgcmV0dXJuIHIudG90YWwtci5oZWF0UHVtcC1yLmFubmV4OyB9CiAgZnVuY3Rpb24gY29tcGxldGUocil7IGNvbnN0IHJlc3Q9ZGVyaXZlZChyKTsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdD49MDsgfQogIGZ1bmN0aW9uIHJlY29yZENvc3Qocil7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUocj8ub3N0cm9tVG90YWxDb3N0RXVyKSYmcj8ub3N0cm9tUHJpY2VDb21wbGV0ZSlyZXR1cm4gTnVtYmVyKHIub3N0cm9tVG90YWxDb3N0RXVyKTsKICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUocj8udG90YWwpKXJldHVybiBudWxsOwogICAgY29uc3QgcHJpY2U9TnVtYmVyLmlzRmluaXRlKHIucHJpY2VDdCk/ci5wcmljZUN0LzEwMDpOdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMik7CiAgICBjb25zdCBiYXNlPU51bWJlci5pc0Zpbml0ZShyLmJhc2VGZWUpP3IuYmFzZUZlZTpOdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApOwogICAgcmV0dXJuIHIudG90YWwqcHJpY2UrYmFzZTsKICB9CiAgZnVuY3Rpb24gcmVjb3JkQ29wKHIpeyByZXR1cm4gTnVtYmVyKHI/LmhlYXRQdW1wKT4wJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHI/LmhlYXRHZW5lcmF0ZWQpKT9OdW1iZXIoci5oZWF0R2VuZXJhdGVkKS9OdW1iZXIoci5oZWF0UHVtcCk6bnVsbDsgfQoKICBmdW5jdGlvbiByYXdTZXR0aW5ncygpeyBjb25zdCB2PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU0VUVElOR1NfS0VZKSx7fSk7IHJldHVybiB2JiZ0eXBlb2Ygdj09PSJvYmplY3QiJiYhQXJyYXkuaXNBcnJheSh2KT92Ont9OyB9CiAgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCl7CiAgICBjb25zdCByYXc9cmF3U2V0dGluZ3MoKTsKICAgIHJldHVybiB7CiAgICAgIC4uLnJhdywKICAgICAgZmFsbGJhY2tQcmljZTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5mYWxsYmFja1ByaWNlKSk/TnVtYmVyKHJhdy5mYWxsYmFja1ByaWNlKTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5wcmljZSkpP051bWJlcihyYXcucHJpY2UpOjAuMzIsCiAgICAgIGRlZmF1bHRCYXNlRmVlOk51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3LmRlZmF1bHRCYXNlRmVlKSk/TnVtYmVyKHJhdy5kZWZhdWx0QmFzZUZlZSk6MCwKICAgICAgb3N0cm9tQXBwS2V5OlN0cmluZyhyYXcub3N0cm9tQXBwS2V5fHwiIiksCiAgICAgIG9zdHJvbUF1dG9SZWZyZXNoOnJhdy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlLAogICAgICBwcmVmZXJyZWRXaW5kb3dIb3VyczpbMSwyLDMsNF0uaW5jbHVkZXMoTnVtYmVyKHJhdy5wcmVmZXJyZWRXaW5kb3dIb3VycykpP051bWJlcihyYXcucHJlZmVycmVkV2luZG93SG91cnMpOjMKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncygpewogICAgY29uc3QgcHJldmlvdXM9cmF3U2V0dGluZ3MoKTsKICAgIGNvbnN0IG1lcmdlZD17Li4ucHJldmlvdXMsCiAgICAgIGZhbGxiYWNrUHJpY2U6TnVtYmVyKHNldHRpbmdzLmZhbGxiYWNrUHJpY2UpfHwwLAogICAgICBkZWZhdWx0QmFzZUZlZTpOdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWUpfHwwLAogICAgICBvc3Ryb21BcHBLZXk6U3RyaW5nKHNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiIpLAogICAgICBvc3Ryb21BdXRvUmVmcmVzaDpzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlLAogICAgICBwcmVmZXJyZWRXaW5kb3dIb3VyczpbMSwyLDMsNF0uaW5jbHVkZXMoTnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKSk/TnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKTozCiAgICB9OwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0VUVElOR1NfS0VZLEpTT04uc3RyaW5naWZ5KG1lcmdlZCkpOwogICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLm1lcmdlZH07CiAgfQoKICBmdW5jdGlvbiByZWFkUHJpbWFyeVJlY29yZHMoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oREFUQV9LRVkpLG51bGwpOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3Nhbml0aXplUmVjb3JkcyhyYXcpOm51bGw7IH0KICBmdW5jdGlvbiByZWFkU2hhZG93UmVjb3JkcygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTSEFET1dfS0VZKSxudWxsKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9zYW5pdGl6ZVJlY29yZHMocmF3KTpbXTsgfQogIGZ1bmN0aW9uIGxvYWRSZWNvcmRzKCl7CiAgICBjb25zdCBwcmltYXJ5PXJlYWRQcmltYXJ5UmVjb3JkcygpOwogICAgaWYocHJpbWFyeSE9PW51bGwpcmV0dXJuIHByaW1hcnk7CiAgICBmb3IoY29uc3Qga2V5IG9mIFsiZWxkZWhvZi12MS1kYXRhIiwiZW5lcmhhdXMtdjEtZGF0YSJdKXsKICAgICAgY29uc3QgbGVnYWN5PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSxudWxsKTsKICAgICAgaWYoQXJyYXkuaXNBcnJheShsZWdhY3kpKXsKICAgICAgICBjb25zdCBtaWdyYXRlZD1zYW5pdGl6ZVJlY29yZHMobGVnYWN5KTsKICAgICAgICBpZihtaWdyYXRlZC5sZW5ndGgpbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkobWlncmF0ZWQpKTsKICAgICAgICByZXR1cm4gbWlncmF0ZWQ7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBbXTsKICB9CiAgZnVuY3Rpb24gc2F2ZVJlY29yZHMobmV4dCx7cmVhc29uPSLDhG5kZXJ1bmciLGFsbG93RW1wdHk9ZmFsc2V9PXt9KXsKICAgIGNvbnN0IGNsZWFuPXNhbml0aXplUmVjb3JkcyhuZXh0KTsKICAgIGNvbnN0IHByZXZpb3VzPXJlYWRQcmltYXJ5UmVjb3JkcygpfHxbXTsKICAgIGlmKCFhbGxvd0VtcHR5ICYmIHByZXZpb3VzLmxlbmd0aD4wICYmIGNsZWFuLmxlbmd0aD09PTApdGhyb3cgbmV3IEVycm9yKCJMZWVyZXIgTW9uYXRzYmVzdGFuZCB3aXJkIGF1cyBTaWNoZXJoZWl0c2dyw7xuZGVuIG5pY2h0IGF1dG9tYXRpc2NoIGdlc3BlaWNoZXJ0LiIpOwogICAgaWYocHJldmlvdXMubGVuZ3RoKXsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0hBRE9XX0tFWSxKU09OLnN0cmluZ2lmeShwcmV2aW91cykpOwogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTSEFET1dfTUVUQV9LRVksSlNPTi5zdHJpbmdpZnkoe3NhdmVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHJlYXNvbixyZWNvcmRzOnByZXZpb3VzLmxlbmd0aH0pKTsKICAgIH0KICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKERBVEFfS0VZLEpTT04uc3RyaW5naWZ5KGNsZWFuKSk7CiAgICByZWNvcmRzPWNsZWFuOwogICAgdXBkYXRlUmVjb3ZlcnlCYW5uZXIoKTsKICAgIGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoKTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVNZXRlclJlYWRpbmcocmF3KXsKICAgIGNvbnN0IGRhdGU9U3RyaW5nKHJhdz8uZGF0ZXx8IiIpOwogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIocmF3Py50b3RhbCksYW5uZXg9bnVsbGFibGVOdW1iZXIocmF3Py5hbm5leCk7CiAgICBpZighL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoZGF0ZSl8fCFOdW1iZXIuaXNGaW5pdGUodG90YWwpfHwhTnVtYmVyLmlzRmluaXRlKGFubmV4KXx8dG90YWw8MHx8YW5uZXg8MClyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7ZGF0ZSx0b3RhbCxhbm5leCxub3RlOlN0cmluZyhyYXc/Lm5vdGV8fCIiKS5zbGljZSgwLDE4MCksdXBkYXRlZEF0OnJhdz8udXBkYXRlZEF0P1N0cmluZyhyYXcudXBkYXRlZEF0KTpudWxsfTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVNZXRlclJlYWRpbmdzKGl0ZW1zKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgcmF3IG9mIEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKXtjb25zdCByPXNhbml0aXplTWV0ZXJSZWFkaW5nKHJhdyk7aWYociltYXAuc2V0KHIuZGF0ZSxyKTt9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5kYXRlLmxvY2FsZUNvbXBhcmUoYi5kYXRlKSk7CiAgfQogIGZ1bmN0aW9uIGxvYWRNZXRlclJlYWRpbmdzKCl7cmV0dXJuIHNhbml0aXplTWV0ZXJSZWFkaW5ncyhzYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE1FVEVSX0tFWSksW10pKTt9CiAgZnVuY3Rpb24gc2F2ZU1ldGVyUmVhZGluZ3MobmV4dCx7dG91Y2g9dHJ1ZSx0aW1lc3RhbXA9bnVsbH09e30pe21ldGVyUmVhZGluZ3M9c2FuaXRpemVNZXRlclJlYWRpbmdzKG5leHQpO2xvY2FsU3RvcmFnZS5zZXRJdGVtKE1FVEVSX0tFWSxKU09OLnN0cmluZ2lmeShtZXRlclJlYWRpbmdzKSk7aWYodG91Y2gpbG9jYWxTdG9yYWdlLnNldEl0ZW0oTUVURVJfTUVUQV9LRVksdGltZXN0YW1wfHxuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO2lmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoKTt9CiAgZnVuY3Rpb24gbGF0ZXN0TWV0ZXJSZWFkaW5nKCl7cmV0dXJuIG1ldGVyUmVhZGluZ3MuYXQoLTEpfHxudWxsO30KICBmdW5jdGlvbiBkYXRlTGFiZWwodmFsdWUpe2NvbnN0IGQ9bmV3IERhdGUoYCR7dmFsdWV9VDEyOjAwOjAwYCk7cmV0dXJuIE51bWJlci5pc05hTihkLnZhbHVlT2YoKSk/dmFsdWU6bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7ZGF5OiIyLWRpZ2l0Iixtb250aDoiMi1kaWdpdCIseWVhcjoibnVtZXJpYyJ9KS5mb3JtYXQoZCk7fQogIGZ1bmN0aW9uIG5leHRNb250aEZpcnN0KGRhdGUpe2NvbnN0IFt5LG1dPVN0cmluZyhkYXRlKS5zcGxpdCgiLSIpLm1hcChOdW1iZXIpO2NvbnN0IGQ9bmV3IERhdGUoeSxtLDEpO3JldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9LTAxYDt9CiAgZnVuY3Rpb24gYXBwbHlIaXN0b3JpY2FsU2VlZCgpewogICAgaWYobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWV9TRUVEX0tFWSkpcmV0dXJuOwogICAgY29uc3QgbWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgY29uc3QgbW9udGhzPVsuLi5uZXcgU2V0KFsuLi5PYmplY3Qua2V5cyhISVNUT1JJQ0FMX1NFRUQudG90YWwpLC4uLk9iamVjdC5rZXlzKEhJU1RPUklDQUxfU0VFRC5hbm5leCksLi4uT2JqZWN0LmtleXMoSElTVE9SSUNBTF9TRUVELmhlYXRQdW1wKV0pXS5zb3J0KCk7CiAgICBmb3IoY29uc3QgbW9udGggb2YgbW9udGhzKXsKICAgICAgY29uc3Qgcj1tYXAuZ2V0KG1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRofSk7CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELnRvdGFsLG1vbnRoKSlyLnRvdGFsPUhJU1RPUklDQUxfU0VFRC50b3RhbFttb250aF07CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELmFubmV4LG1vbnRoKSlyLmFubmV4PUhJU1RPUklDQUxfU0VFRC5hbm5leFttb250aF07CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELmhlYXRQdW1wLG1vbnRoKSl7CiAgICAgICAgY29uc3Qgc2VlZD1ISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXBbbW9udGhdOwogICAgICAgIGNvbnN0IGtlZXBFeGlzdGluZz1OdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCkmJk1hdGguYWJzKHIuaGVhdFB1bXAtc2VlZCk8PTI7CiAgICAgICAgaWYoIWtlZXBFeGlzdGluZylyLmhlYXRQdW1wPXNlZWQ7CiAgICAgICAgaWYoIXIuaGVhdFB1bXBTb3VyY2Upci5oZWF0UHVtcFNvdXJjZT0iaGlzdG9yaWNhbC11c2VyLWRhdGEiOwogICAgICB9CiAgICAgIGlmKG1vbnRoPT09IjIwMjQtMDMiKXsKICAgICAgICBjb25zdCBub3RlPSJaw6RobGVyd2VjaHNlbCBHZXNhbXRzdHJvbSBhbSAwMS4wNC4yMDI0OiBhbHRlciBaw6RobGVyIDYyLjI5NiBrV2gsIG5ldWVyIFrDpGhsZXIgMTk3IGtXaDsgTW9uYXRzdmVyYnJhdWNoIGtvcnJla3QgbWl0IDEuMzIwIGtXaCBiZXLDvGNrc2ljaHRpZ3QuIjsKICAgICAgICBpZighU3RyaW5nKHIubm90ZXx8IiIpLmluY2x1ZGVzKCJaw6RobGVyd2VjaHNlbCBHZXNhbXRzdHJvbSIpKXIubm90ZT1yLm5vdGU/YCR7ci5ub3RlfSDigKIgJHtub3RlfWA6bm90ZTsKICAgICAgfQogICAgICBpZihtb250aD09PSIyMDIzLTEyIiYmIXIubm90ZSlyLm5vdGU9Ikhpc3RvcmlzY2ggaXN0IGbDvHIgRGV6ZW1iZXIgMjAyMyBudXIgZGVyIFfDpHJtZXB1bXBlbnZlcmJyYXVjaCBkb2t1bWVudGllcnQuIjsKICAgICAgbWFwLnNldChtb250aCxyKTsKICAgIH0KICAgIHNhdmVSZWNvcmRzKFsuLi5tYXAudmFsdWVzKCldLHtyZWFzb246Ikhpc3RvcmlzY2hlIFZlcmJyYXVjaHNkYXRlbiAyMDI04oCTMDkvMjAyNiDDvGJlcm5vbW1lbiJ9KTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUllfU0VFRF9LRVksbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTsKICB9CiAgZnVuY3Rpb24gZW5zdXJlTWV0ZXJCYXNlbGluZSgpewogICAgaWYobWV0ZXJSZWFkaW5ncy5zb21lKHI9PnIuZGF0ZT09PUJBU0VMSU5FX01FVEVSX1JFQURJTkcuZGF0ZSkpcmV0dXJuOwogICAgaWYobWV0ZXJSZWFkaW5ncy5sZW5ndGg9PT0wKXNhdmVNZXRlclJlYWRpbmdzKFtCQVNFTElORV9NRVRFUl9SRUFESU5HXSx7dG91Y2g6ZmFsc2V9KTsKICB9CiAgZnVuY3Rpb24gbG9hZFZhaWxsYW50TW9udGhzKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFZBSUxMQU5UX01PTlRIU19LRVkpLFtdKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9yYXc6W107IH0KICBmdW5jdGlvbiBzYXZlVmFpbGxhbnRNb250aHMoKXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oVkFJTExBTlRfTU9OVEhTX0tFWSxKU09OLnN0cmluZ2lmeShBcnJheS5pc0FycmF5KHZhaWxsYW50TW9udGhzKT92YWlsbGFudE1vbnRoczpbXSkpOyBpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKCk7IH0KICBmdW5jdGlvbiBsb2FkT3N0cm9tQ2FjaGUoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oT1NUUk9NX0NBQ0hFX0tFWSksbnVsbCk7IHJldHVybiByYXcmJnJhdy5nZW5lcmF0ZWRBdD9yYXc6bnVsbDsgfQogIGZ1bmN0aW9uIHNhdmVPc3Ryb21DYWNoZShwYXlsb2FkKXsgb3N0cm9tTGl2ZT1wYXlsb2FkfHxudWxsOyBpZihwYXlsb2FkKWxvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9DQUNIRV9LRVksSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpOyBlbHNlIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKE9TVFJPTV9DQUNIRV9LRVkpOyBpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKDE4MDApOyB9CiAgZnVuY3Rpb24gc2FuaXRpemVPc3Ryb21QcmljZVN0YXQocmF3KXsKICAgIGNvbnN0IG1vbnRoPVN0cmluZyhyYXc/Lm1vbnRofHwiIik7CiAgICBpZighL15cZHs0fS1cZHsyfSQvLnRlc3QobW9udGgpKXJldHVybiBudWxsOwogICAgcmV0dXJuIHsKICAgICAgbW9udGgsCiAgICAgIHdlaWdodGVkQXZlcmFnZUN0UGVyS1doOm51bGxhYmxlTnVtYmVyKHJhdy53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCA/PyByYXcucHJpY2VDdCksCiAgICAgIHRvdGFsS1doOm51bGxhYmxlTnVtYmVyKHJhdy50b3RhbEtXaCA/PyByYXcub3N0cm9tQ29uc3VtcHRpb25LV2gpLAogICAgICB2YXJpYWJsZUNvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3LnZhcmlhYmxlQ29zdEV1ciA/PyByYXcub3N0cm9tVmFyaWFibGVDb3N0RXVyKSwKICAgICAgZml4ZWRDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy5maXhlZENvc3RFdXIgPz8gcmF3LmJhc2VGZWUpLAogICAgICB0b3RhbENvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsQ29zdEV1ciA/PyByYXcub3N0cm9tVG90YWxDb3N0RXVyKSwKICAgICAgY29tcGxldGU6Qm9vbGVhbihyYXcuY29tcGxldGUgPz8gcmF3Lm9zdHJvbVByaWNlQ29tcGxldGUpLAogICAgICBwYXJ0aWFsOkJvb2xlYW4ocmF3LnBhcnRpYWwpLAogICAgICB1cGRhdGVkQXQ6U3RyaW5nKHJhdy51cGRhdGVkQXR8fHJhdy5wcmljZVVwZGF0ZWRBdHx8IiIpCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdHMoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pe2NvbnN0IGl0ZW09c2FuaXRpemVPc3Ryb21QcmljZVN0YXQocmF3KTtpZihpdGVtKW1hcC5zZXQoaXRlbS5tb250aCxpdGVtKTt9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gbG9hZE9zdHJvbVByaWNlU3RhdHMoKXsgcmV0dXJuIHNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhzYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE9TVFJPTV9QUklDRV9TVEFUU19LRVkpLFtdKSk7IH0KICBmdW5jdGlvbiBzYXZlT3N0cm9tUHJpY2VTdGF0cyhpdGVtcyl7IG9zdHJvbVByaWNlU3RhdHM9c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKGl0ZW1zKTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShPU1RST01fUFJJQ0VfU1RBVFNfS0VZLEpTT04uc3RyaW5naWZ5KG9zdHJvbVByaWNlU3RhdHMpKTtpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKDEyMDApOyB9CiAgZnVuY3Rpb24gdXBzZXJ0T3N0cm9tUHJpY2VTdGF0KG1vbnRoLGRhdGEse3BhcnRpYWw9ZmFsc2V9PXt9KXsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChTdHJpbmcobW9udGh8fCIiKSkpcmV0dXJuOwogICAgY29uc3QgbWFwPW5ldyBNYXAob3N0cm9tUHJpY2VTdGF0cy5tYXAoaXRlbT0+W2l0ZW0ubW9udGgsaXRlbV0pKTsKICAgIG1hcC5zZXQobW9udGgsc2FuaXRpemVPc3Ryb21QcmljZVN0YXQoewogICAgICBtb250aCx3ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaDpOdW1iZXIoZGF0YT8ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpLHRvdGFsS1doOk51bWJlcihkYXRhPy50b3RhbEtXaCksdmFyaWFibGVDb3N0RXVyOk51bWJlcihkYXRhPy52YXJpYWJsZUNvc3RFdXIpLGZpeGVkQ29zdEV1cjpOdW1iZXIoZGF0YT8uZml4ZWRDb3N0RXVyKSx0b3RhbENvc3RFdXI6TnVtYmVyKGRhdGE/LnRvdGFsQ29zdEV1ciksY29tcGxldGU6Qm9vbGVhbihkYXRhPy5jb21wbGV0ZSkscGFydGlhbCx1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpCiAgICB9KSk7CiAgICBzYXZlT3N0cm9tUHJpY2VTdGF0cyhbLi4ubWFwLnZhbHVlcygpXSk7CiAgfQoKICBmdW5jdGlvbiB1cGRhdGVSZWNvdmVyeUJhbm5lcigpewogICAgY29uc3QgcHJpbWFyeT1yZWFkUHJpbWFyeVJlY29yZHMoKTsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgY29uc3Qgc2hvdz0oIXByaW1hcnl8fHByaW1hcnkubGVuZ3RoPT09MCkmJnNoYWRvdy5sZW5ndGg+MDsKICAgICQoInJlY292ZXJ5QmFubmVyIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIHJlc3RvcmVTaGFkb3coKXsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgaWYoIXNoYWRvdy5sZW5ndGgpcmV0dXJuOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkoc2hhZG93KSk7CiAgICByZWNvcmRzPXNoYWRvdzsKICAgIHRvYXN0KGAke3NoYWRvdy5sZW5ndGh9IE1vbmF0c3dlcnRlIHdpZWRlcmhlcmdlc3RlbGx0YCk7CiAgICByZW5kZXJBbGwoKTsKICB9CgogIGZ1bmN0aW9uIHRvYXN0KG1lc3NhZ2UpeyBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7ICQoInRvYXN0IikudGV4dENvbnRlbnQ9bWVzc2FnZTsgJCgidG9hc3QiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsgdG9hc3RUaW1lcj1zZXRUaW1lb3V0KCgpPT4kKCJ0b2FzdCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpLDI2MDApOyB9CiAgZnVuY3Rpb24gc2V0U3RhdHVzKGlkLHRleHQsa2luZD0iIil7IGNvbnN0IGVsPSQoaWQpOyBlbC50ZXh0Q29udGVudD10ZXh0fHwiIjsgZWwuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke2tpbmR9YC50cmltKCk7IH0KCiAgZnVuY3Rpb24gc3dpdGNoVmlldyhpZCl7CiAgICBjdXJyZW50Vmlldz1pZDsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi52aWV3IikuZm9yRWFjaCh2PT52LmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsdi5pZD09PWlkKSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIuYm90dG9tLW5hdiBbZGF0YS1uYXZdIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsYi5kYXRhc2V0Lm5hdj09PWlkKSk7CiAgICB3aW5kb3cuc2Nyb2xsVG8oe3RvcDowLGJlaGF2aW9yOiJpbnN0YW50In0pOwogICAgaWYoaWQ9PT0iYW5hbHlzaXNWaWV3IilyZW5kZXJBbmFseXNpcygpOwogICAgaWYoaWQ9PT0iY29uc3VtcHRpb25WaWV3IilyZW5kZXJSZWNvcmRzKCk7CiAgICBpZihpZD09PSJkYXRhVmlldyIpcmVuZGVyRGF0YSgpOwogICAgaWYoaWQ9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7CiAgfQoKICBmdW5jdGlvbiB5ZWFycygpeyByZXR1cm4gWy4uLm5ldyBTZXQocmVjb3Jkcy5tYXAocj0+TnVtYmVyKHIubW9udGguc2xpY2UoMCw0KSkpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKV0uc29ydCgoYSxiKT0+Yi1hKTsgfQogIGZ1bmN0aW9uIGxhdGVzdFJlY29yZCgpeyByZXR1cm4gc29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkuYXQoLTEpfHxzb3J0ZWQoKS5hdCgtMSl8fG51bGw7IH0KICBmdW5jdGlvbiByZWNvcmRGb3JNb250aChtb250aCl7IHJldHVybiByZWNvcmRzLmZpbmQocj0+ci5tb250aD09PW1vbnRoKXx8bnVsbDsgfQoKCgogIC8qIDYuMy40OiBhbGlnbmVkIHdlYXRoZXIgLyBoZWF0aW5nLW9ubHkgZWxlY3RyaWNhbCBjb25zdW1wdGlvbiBtdWx0aS15ZWFyIGNvbXBhcmlzb25zLiAqLwogIGxldCBkYXNoYm9hcmRDbGltYXRlUGVyaW9kPSJoZWF0aW5nIjsKICBsZXQgZGFzaGJvYXJkQ2xpbWF0ZVNlbGVjdGVkTW9udGg9bnVsbDsKICBsZXQgY2xpbWF0ZVdlYXRoZXJFcnJvcj0iIjsKICBjb25zdCBDTElNQVRFX0NPTVBBUklTT05fQ09MT1JTPXsyMDI0OiIjNGQ5Y2ZmIiwyMDI1OiIjZmY5ZjQzIiwyMDI2OiIjNzJkYzU3In07CiAgZnVuY3Rpb24gZGFzaGJvYXJkQ29tcGFyaXNvblllYXJzKCl7CiAgICBjb25zdCB5ZWFycz1uZXcgU2V0KHJlY29yZHMuZmlsdGVyKHg9Pk51bWJlci5pc0Zpbml0ZSh4LmhlYXRpbmdFbGVjdHJpY2l0eSl8fE51bWJlci5pc0Zpbml0ZSh4LmhlYXRpbmdIZWF0KSkKICAgICAgLm1hcCh4PT5OdW1iZXIoeC5tb250aC5zbGljZSgwLDQpKSkpOwogICAgZm9yKGNvbnN0IHYgb2YgY2xpbWF0ZU1vbnRocyl5ZWFycy5hZGQoTnVtYmVyKHYubW9udGguc2xpY2UoMCw0KSkpOwogICAgcmV0dXJuIFsuLi55ZWFyc10uZmlsdGVyKHg9Pk51bWJlci5pc0ludGVnZXIoeCkmJng+PTIwMjQmJng8PW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSkKICAgICAgLnNvcnQoKGEsYik9PmEtYikuc2xpY2UoLTMpOwogIH0KICBmdW5jdGlvbiBkYXNoYm9hcmRDb21wYXJpc29uTW9udGhzKCl7CiAgICByZXR1cm4gZGFzaGJvYXJkQ2xpbWF0ZVBlcmlvZD09PSJoZWF0aW5nIj9bMSwyLDMsNCwxMCwxMSwxMl06WzEsMiwzLDQsNSw2LDcsOCw5LDEwLDExLDEyXTsKICB9CiAgZnVuY3Rpb24gZGFzaGJvYXJkQ29tcGFyaXNvblJvd3MoeWVhcil7CiAgICBjb25zdCBjdXJyZW50PWN1cnJlbnRNb250aEtleSgpOwogICAgcmV0dXJuIEFycmF5LmZyb20oe2xlbmd0aDoxMn0sKF8saSk9PnsKICAgICAgY29uc3QgbW9udGg9eWVhcisiLSIrU3RyaW5nKGkrMSkucGFkU3RhcnQoMiwiMCIpOwogICAgICBjb25zdCByPXJlY29yZEZvck1vbnRoKG1vbnRoKSx3PWNsaW1hdGVXZWF0aGVyRm9yKG1vbnRoKTsKICAgICAgY29uc3QgaW5jb21wbGV0ZT1tb250aD49Y3VycmVudHx8U3RyaW5nKHI/LmhlYXRQdW1wU291cmNlfHwiIikuaW5jbHVkZXMoInBhcnRpYWwiKTsKICAgICAgY29uc3Qgd2VhdGhlclZhbGlkPW1vbnRoPGN1cnJlbnQmJnc/LmNvbXBsZXRlPT09dHJ1ZSYmTnVtYmVyLmlzRmluaXRlKHcubWVhblRlbXApOwogICAgICBjb25zdCBlbmVyZ3lWYWxpZD0haW5jb21wbGV0ZSYmciYmCiAgICAgICAgKHIuaGVhdFB1bXBTb3VyY2UhPT0ibXl2YWlsbGFudC1jc3YtaW1wb3J0LXBhcnRpYWwiKTsKICAgICAgY29uc3QgZWxlY3RyaWM9ZW5lcmd5VmFsaWQmJk51bWJlci5pc0Zpbml0ZShyLmhlYXRpbmdFbGVjdHJpY2l0eSkmJnIuaGVhdGluZ0VsZWN0cmljaXR5Pj0wP3IuaGVhdGluZ0VsZWN0cmljaXR5Om51bGw7CiAgICAgIGNvbnN0IGhlYXQ9ZW5lcmd5VmFsaWQmJk51bWJlci5pc0Zpbml0ZShyLmhlYXRpbmdIZWF0KSYmci5oZWF0aW5nSGVhdD49MD9yLmhlYXRpbmdIZWF0Om51bGw7CiAgICAgIGNvbnN0IGhkZD13ZWF0aGVyVmFsaWQmJk51bWJlci5pc0Zpbml0ZSh3LmhkZDE1KT93LmhkZDE1Om51bGw7CiAgICAgIGNvbnN0IGNvcD1OdW1iZXIuaXNGaW5pdGUoaGVhdCkmJk51bWJlci5pc0Zpbml0ZShlbGVjdHJpYykmJmVsZWN0cmljPjA/aGVhdC9lbGVjdHJpYzpudWxsOwogICAgICByZXR1cm4ge3llYXIsbW9udGgsbW9udGhOdW1iZXI6aSsxLGVsZWN0cmljLGhlYXQsdGVtcDp3ZWF0aGVyVmFsaWQ/dy5tZWFuVGVtcDpudWxsLAogICAgICAgIGhkZCxjb3AscGFydGlhbDppbmNvbXBsZXRlJiZCb29sZWFuKHIpLGhhc1NlbnNvcjpjbGltYXRlTW9udGhzLnNvbWUoeD0+eC5tb250aD09PW1vbnRoKX07CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZGFzaGJvYXJkQ29tcGFyaXNvbk1hdHJpeCgpewogICAgcmV0dXJuIG5ldyBNYXAoZGFzaGJvYXJkQ29tcGFyaXNvblllYXJzKCkubWFwKHk9Plt5LGRhc2hib2FyZENvbXBhcmlzb25Sb3dzKHkpXSkpOwogIH0KICBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmRDbGltYXRlKCl7CiAgICBpZighJCgiZGFzaGJvYXJkQ2xpbWF0ZVBhbmVsIikpcmV0dXJuOwogICAgY29uc3QgeWVhcnM9ZGFzaGJvYXJkQ29tcGFyaXNvblllYXJzKCksbW9udGhzPWRhc2hib2FyZENvbXBhcmlzb25Nb250aHMoKSxtYXRyaXg9ZGFzaGJvYXJkQ29tcGFyaXNvbk1hdHJpeCgpOwogICAgLy8gVGhlIHBhbGV0dGUgY29udGFpbnMgc3RhYmxlIGNvbG9ycyBmb3IgMjAyNOKAkzIwMjY7IGxhdGVyIHllYXJzIHJlY2VpdmUgYSBkZXRlcm1pbmlzdGljIGZhbGxiYWNrLgogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZUxlZ2VuZCIpLmlubmVySFRNTD15ZWFycy5tYXAoKHksaSk9PnsKICAgICAgY29uc3QgY29sb3I9ZGFzaGJvYXJkQ29tcGFyaXNvbkNvbG9yKHksaSk7CiAgICAgIHJldHVybiAnPHNwYW4+PGkgc3R5bGU9ImJhY2tncm91bmQ6Jytjb2xvcisnIj48L2k+Jyt5Kyc8L3NwYW4+JzsKICAgIH0pLmpvaW4oIiIpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtY2xpbWF0ZS1wZXJpb2RdIikuZm9yRWFjaChidG49PnsKICAgICAgY29uc3QgYWN0aXZlPWJ0bi5kYXRhc2V0LmNsaW1hdGVQZXJpb2Q9PT1kYXNoYm9hcmRDbGltYXRlUGVyaW9kOwogICAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIixhY3RpdmUpO2J0bi5zZXRBdHRyaWJ1dGUoImFyaWEtcHJlc3NlZCIsU3RyaW5nKGFjdGl2ZSkpOwogICAgfSk7CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlWWVhciIpLnRleHRDb250ZW50PWRhc2hib2FyZENsaW1hdGVQZXJpb2Q9PT0iaGVhdGluZyI/CiAgICAgICJIZWl6bW9uYXRlIEphbnVhcuKAk0FwcmlsIHVuZCBPa3RvYmVy4oCTRGV6ZW1iZXIgwrcgamUgS2FsZW5kZXJqYWhyIjoKICAgICAgIkFsbGUgenfDtmxmIEthbGVuZGVybW9uYXRlIMK3IGplIEthbGVuZGVyamFociI7CiAgICBpZighbW9udGhzLmluY2x1ZGVzKE51bWJlcihTdHJpbmcoZGFzaGJvYXJkQ2xpbWF0ZVNlbGVjdGVkTW9udGh8fCIiKS5zbGljZSg1LDcpKSkpewogICAgICBjb25zdCBjYW5kaWRhdGU9bW9udGhzLmZpbmQobT0+eWVhcnMuZmlsdGVyKHk9Pk51bWJlci5pc0Zpbml0ZShtYXRyaXguZ2V0KHkpPy5bbS0xXT8uZWxlY3RyaWMpKS5sZW5ndGg+PTIpCiAgICAgICAgfHxtb250aHMuZmluZChtPT55ZWFycy5zb21lKHk9Pk51bWJlci5pc0Zpbml0ZShtYXRyaXguZ2V0KHkpPy5bbS0xXT8uZWxlY3RyaWMpKSl8fG1vbnRoc1swXTsKICAgICAgZGFzaGJvYXJkQ2xpbWF0ZVNlbGVjdGVkTW9udGg9Im1vbnRoLSIrU3RyaW5nKGNhbmRpZGF0ZSkucGFkU3RhcnQoMiwiMCIpOwogICAgfQogICAgY29uc3Qgc2VsZWN0ZWROdW1iZXI9TnVtYmVyKFN0cmluZyhkYXNoYm9hcmRDbGltYXRlU2VsZWN0ZWRNb250aCkuc2xpY2UoLTIpKTsKICAgICQoImRhc2hib2FyZENsaW1hdGVNb250aEJ1dHRvbnMiKS5pbm5lckhUTUw9bW9udGhzLm1hcChtPT4KICAgICAgJzxidXR0b24gdHlwZT0iYnV0dG9uIiBkYXRhLWNsaW1hdGUtbW9udGg9IicrbSsnIiBjbGFzcz0iJysoc2VsZWN0ZWROdW1iZXI9PT1tPyJhY3RpdmUiOiIiKSsnIiBhcmlhLXByZXNzZWQ9IicrKHNlbGVjdGVkTnVtYmVyPT09bSkrJyI+JytNT05USFNbbS0xXSsnPC9idXR0b24+JwogICAgKS5qb2luKCIiKTsKICAgIHJlbmRlckNsaW1hdGVDb3VwbGVkTW9udGhEZXRhaWwobWF0cml4LHllYXJzLHNlbGVjdGVkTnVtYmVyKTsKICAgIHJlbmRlckNsaW1hdGVDb3VwbGVkU3VtbWFyeShtYXRyaXgseWVhcnMsbW9udGhzKTsKICAgIGRyYXdDbGltYXRlQ291cGxlZENoYXJ0KCJkYXNoYm9hcmRDbGltYXRlVGVtcGVyYXR1cmVDaGFydCIsbWF0cml4LHllYXJzLG1vbnRocywidGVtcCIpOwogICAgZHJhd0NsaW1hdGVDb3VwbGVkQ2hhcnQoImRhc2hib2FyZENsaW1hdGVFbGVjdHJpY0NoYXJ0IixtYXRyaXgseWVhcnMsbW9udGhzLCJlbGVjdHJpYyIpOwogICAgY29uc3Qgd2VhdGhlclJlYWR5PXllYXJzLmV2ZXJ5KHk9Pntjb25zdCBkPWNsaW1hdGVXZWF0aGVyPy5beV07cmV0dXJuIHk9PT1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk/CiAgICAgIEFycmF5LmlzQXJyYXkoZD8ubW9udGhzKSYmZC5tb250aHMubGVuZ3RoPjA6ZD8uY29tcGxldGU9PT10cnVlO30pOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVdlYXRoZXJCdG4iKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHdlYXRoZXJSZWFkeSYmIWNsaW1hdGVXZWF0aGVyRXJyb3IpOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVdlYXRoZXJCdG4iKS5kaXNhYmxlZD1jbGltYXRlQnVzeTsKICAgICQoImRhc2hib2FyZENsaW1hdGVXZWF0aGVyQnRuIikudGV4dENvbnRlbnQ9Y2xpbWF0ZUJ1c3k/IldldHRlciB3aXJkIGdlbGFkZW4g4oCmIjoiV2V0dGVyaGlzdG9yaWUgbGFkZW4iOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVN0YXR1cyIpLnRleHRDb250ZW50PWNsaW1hdGVXZWF0aGVyRXJyb3I/IldldHRlcjogIitjbGltYXRlV2VhdGhlckVycm9yOgogICAgICAhd2VhdGhlclJlYWR5PyJGw7xyIGRlbiBUZW1wZXJhdHVydmVyZ2xlaWNoIGZlaGxlbiBub2NoIGhpc3RvcmlzY2hlIFdldHRlcmRhdGVuLiI6IldldHRlcnZlcmdsZWljaCB2ZXJmw7xnYmFyIMK3IGVpbmhlaXRsaWNoZSBPcGVuLU1ldGVvLUFyY2hpdmRhdGVuLiI7CiAgfQogIGZ1bmN0aW9uIGRhc2hib2FyZENvbXBhcmlzb25Db2xvcih5ZWFyLGluZGV4KXsKICAgIHJldHVybiBDTElNQVRFX0NPTVBBUklTT05fQ09MT1JTW3llYXJdfHxZRUFSX0NPTE9SU1soaW5kZXgrMSklWUVBUl9DT0xPUlMubGVuZ3RoXTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyQ2xpbWF0ZUNvdXBsZWRTdW1tYXJ5KG1hdHJpeCx5ZWFycyxtb250aHMpewogICAgY29uc3QgZWw9JCgiZGFzaGJvYXJkQ2xpbWF0ZVRyZW5kIik7CiAgICBpZih5ZWFycy5sZW5ndGg8Mil7ZWwudGV4dENvbnRlbnQ9IldlaXRlcmUgVmFpbGxhbnQtSmFocmVzZGF0ZW4gZXJnw6RuemVuLCB1bSBkaWUgSmFocmUgbWl0ZWluYW5kZXIgenUgdmVyZ2xlaWNoZW4uIjtyZXR1cm47fQogICAgY29uc3Qgb2xkZXI9eWVhcnNbeWVhcnMubGVuZ3RoLTJdLG5ld2VyPXllYXJzW3llYXJzLmxlbmd0aC0xXTsKICAgIGNvbnN0IGFsaWduZWQ9bW9udGhzLm1hcChtPT5bbWF0cml4LmdldChvbGRlcik/LlttLTFdLG1hdHJpeC5nZXQobmV3ZXIpPy5bbS0xXV0pCiAgICAgIC5maWx0ZXIoKFthLGJdKT0+YSYmYiYmW2EuZWxlY3RyaWMsYi5lbGVjdHJpYyxhLmhkZCxiLmhkZF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSYmYS5oZGQ+PTE1JiZiLmhkZD49MTUpOwogICAgaWYoYWxpZ25lZC5sZW5ndGg8Mil7CiAgICAgIGVsLmlubmVySFRNTD0nPHN0cm9uZz5XaXR0ZXJ1bmdzLSB1bmQgSGVpenN0cm9tdmVyZ2xlaWNoPC9zdHJvbmc+PHA+RsO8ciAnK29sZGVyKycgdW5kICcrbmV3ZXIrCiAgICAgICAgJyBmZWhsZW4gbm9jaCBtaW5kZXN0ZW5zIHp3ZWkgdm9sbHN0w6RuZGlnIHZlcmdsZWljaGJhcmUgSGVpem1vbmF0ZSBtaXQgV2V0dGVyZGF0ZW4uIEZlaGxlbmRlIFdlcnRlIHdlcmRlbiBuaWNodCBnZXNjaMOkdHp0LjwvcD4nOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBzdW09KGl4LGtleSk9PmFsaWduZWQucmVkdWNlKChzLHApPT5zK3BbaXhdW2tleV0sMCk7CiAgICBjb25zdCBlYT1zdW0oMCwiZWxlY3RyaWMiKSxlYj1zdW0oMSwiZWxlY3RyaWMiKSxoYT1zdW0oMCwiaGRkIiksaGI9c3VtKDEsImhkZCIpOwogICAgY29uc3QgZGVsdGE9KHgseSk9Png+MD8oeS94LTEpKjEwMDpudWxsOwogICAgY29uc3QgZj14PT5OdW1iZXIuaXNGaW5pdGUoeCk/KHg+MD8iKyIrbnVtKHgsMSkrIiAlIjpudW0oeCwxKSsiICUiKToi4oCTIjsKICAgIGNvbnN0IGVsZWN0cmljUGN0PWRlbHRhKGVhLGViKSx3ZWF0aGVyUGN0PWRlbHRhKGhhLGhiKTsKICAgIGNvbnN0IGVmZmljaWVuY3lBPWhhPjA/ZWEvaGE6bnVsbCxlZmZpY2llbmN5Qj1oYj4wP2ViL2hiOm51bGw7CiAgICBjb25zdCByYXRpb1BjdD1OdW1iZXIuaXNGaW5pdGUoZWZmaWNpZW5jeUEpJiZlZmZpY2llbmN5QT4wP2RlbHRhKGVmZmljaWVuY3lBLGVmZmljaWVuY3lCKTpudWxsOwogICAgZWwuaW5uZXJIVE1MPSc8c3Ryb25nPkRpcmVrdHZlcmdsZWljaCAnK25ld2VyKycgenUgJytvbGRlcisnIMK3ICcrYWxpZ25lZC5sZW5ndGgrJyBnbGVpY2hlIEhlaXptb25hdGU8L3N0cm9uZz4nKwogICAgICAnPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnktbWV0cmljcyI+JysKICAgICAgJzxkaXY+PHNwYW4+SGVpenN0cm9tPC9zcGFuPjxzdHJvbmc+JytmKGVsZWN0cmljUGN0KSsnPC9zdHJvbmc+PHNtYWxsPicrbnVtKGVhKSsnIOKGkiAnK251bShlYikrJyBrV2g8L3NtYWxsPjwvZGl2PicrCiAgICAgICc8ZGl2PjxzcGFuPldpdHRlcnVuZyAoSGVpemdyYWR0YWdlKTwvc3Bhbj48c3Ryb25nPicrZih3ZWF0aGVyUGN0KSsnPC9zdHJvbmc+PHNtYWxsPicrbnVtKGhhKSsnIOKGkiAnK251bShoYikrJyBLwrdkPC9zbWFsbD48L2Rpdj4nKwogICAgICAnPGRpdj48c3Bhbj5IZWl6c3Ryb20gamUgSGVpemdyYWR0YWc8L3NwYW4+PHN0cm9uZz4nKyhOdW1iZXIuaXNGaW5pdGUocmF0aW9QY3QpP2YocmF0aW9QY3QpOiLigJMiKSsnPC9zdHJvbmc+PHNtYWxsPk9yaWVudGllcnVuZ3N3ZXJ0LCBrZWluZSBFZmZpemllbnptZXNzdW5nPC9zbWFsbD48L2Rpdj48L2Rpdj4nKwogICAgICAnPHA+R2xlaWNoZSBNb25hdGUsIG9obmUgV2FybXdhc3NlcnN0cm9tLiBIZWl6Z3JhZHRhZ2UgYmVzY2hyZWliZW4gZGVuIHdpdHRlcnVuZ3NiZWRpbmd0ZW4gSGVpemJlZGFyZi4gRGllIFdlcnRlIHplaWdlbiBlaW5lbiBadXNhbW1lbmhhbmcsIGJld2Vpc2VuIGFiZXIga2VpbmUgVXJzYWNoZS48L3A+JzsKICB9CiAgZnVuY3Rpb24gcmVuZGVyQ2xpbWF0ZUNvdXBsZWRNb250aERldGFpbChtYXRyaXgseWVhcnMsbW9udGhOdW1iZXIpewogICAgY29uc3QgZWw9JCgiZGFzaGJvYXJkQ2xpbWF0ZU1vbnRoRGV0YWlsIik7CiAgICBjb25zdCBudW1iZXI9TnVtYmVyKG1vbnRoTnVtYmVyKTsKICAgIGlmKCFOdW1iZXIuaXNJbnRlZ2VyKG51bWJlcil8fG51bWJlcjwxfHxudW1iZXI+MTIpe2VsLnRleHRDb250ZW50PSJCaXR0ZSBlaW5lbiBNb25hdCBhdXN3w6RobGVuLiI7cmV0dXJuO30KICAgIGNvbnN0IG51bU9yRGFzaD0odix1bml0LGQ9MCk9Pk51bWJlci5pc0Zpbml0ZSh2KT9udW0odixkKSsodW5pdD8iICIrdW5pdDoiIik6IuKAkyI7CiAgICBjb25zdCBoZWFkPSc8ZGl2IGNsYXNzPSJjbGltYXRlLWNvdXBsZWQtbW9udGgtaGVhZGVyIj48c3Ryb25nPicrTU9OVEhTW251bWJlci0xXSsnIOKAkyBkcmVpIEphaHJlIGRpcmVrdCB2ZXJnbGljaGVuPC9zdHJvbmc+JysKICAgICAgJzxzcGFuPkhlaXpzdHJvbSBhdXNzY2hsaWXDn2xpY2ggZsO8cnMgSGVpemVuPC9zcGFuPjwvZGl2Pic7CiAgICBjb25zdCBib2R5PXllYXJzLm1hcCh5PT57CiAgICAgIGNvbnN0IHI9bWF0cml4LmdldCh5KT8uW251bWJlci0xXTsKICAgICAgY29uc3QgYz1kYXNoYm9hcmRDb21wYXJpc29uQ29sb3IoeSx5ZWFycy5pbmRleE9mKHkpKTsKICAgICAgY29uc3QgcmF0aW89TnVtYmVyLmlzRmluaXRlKHI/LmVsZWN0cmljKSYmTnVtYmVyLmlzRmluaXRlKHI/LmhkZCkmJnIuaGRkPj0xNT9yLmVsZWN0cmljL3IuaGRkOm51bGw7CiAgICAgIHJldHVybiAnPHRyPjx0aD48aSBzdHlsZT0iYmFja2dyb3VuZDonK2MrJyI+PC9pPicreSsnPC90aD4nKwogICAgICAgICc8dGQ+JytudW1PckRhc2gocj8udGVtcCwnwrBDJywxKSsnPC90ZD4nKwogICAgICAgICc8dGQ+JytudW1PckRhc2gocj8uZWxlY3RyaWMsJ2tXaCcpKyc8L3RkPicrCiAgICAgICAgJzx0ZD4nK251bU9yRGFzaChyPy5oZWF0LCdrV2gnKSsnPC90ZD4nKwogICAgICAgICc8dGQ+JytudW1PckRhc2gocj8uY29wLCcnLDIpKyc8L3RkPicrCiAgICAgICAgJzx0ZD4nK251bU9yRGFzaChyPy5oZGQsJ0vCt2QnKSsnPC90ZD4nKwogICAgICAgICc8dGQ+JytudW1PckRhc2gocmF0aW8sJ2tXaC9LwrdkJywyKSsnPC90ZD48L3RyPic7CiAgICB9KS5qb2luKCIiKTsKICAgIGNvbnN0IHRhYmxlPSc8ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwgY2xpbWF0ZS1jb3VwbGVkLWRldGFpbC1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPicrCiAgICAgICc8dGg+SmFocjwvdGg+PHRoPkF1w59lbiDDmDwvdGg+PHRoPkhlaXpzdHJvbTwvdGg+PHRoPkhlaXp3w6RybWU8L3RoPjx0aD5IZWl6LUNPUDwvdGg+PHRoPkhHVDwvdGg+PHRoPlN0cm9tL0hHVDwvdGg+JysKICAgICAgJzwvdHI+PC90aGVhZD48dGJvZHk+Jytib2R5Kyc8L3Rib2R5PjwvdGFibGU+PC9kaXY+JzsKICAgIGxldCBpbmZvPSJGZWhsZW5kZSBXZXJ0ZSBiZWRldXRlbjoga2VpbiB2b2xsc3TDpG5kaWcgdmVyZ2xlaWNoYmFyZXIgTW9uYXRzd2VydC4gSEdUID0gSGVpemdyYWR0YWdlICgxNSDCsEMpOyBIZWl6LUNPUCA9IGVyemV1Z3RlIEhlaXp3w6RybWUgLyBIZWl6c3Ryb20uIjsKICAgIGNvbnN0IHByZXNlbnQ9eWVhcnMubWFwKHk9Pm1hdHJpeC5nZXQoeSk/LltudW1iZXItMV0pLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUocj8udGVtcCkmJk51bWJlci5pc0Zpbml0ZShyPy5lbGVjdHJpYykpOwogICAgaWYocHJlc2VudC5sZW5ndGg+PTIpewogICAgICBjb25zdCBhPXByZXNlbnQuYXQoLTIpLGI9cHJlc2VudC5hdCgtMSk7CiAgICAgIGNvbnN0IHQ9Yi50ZW1wLWEudGVtcCxlPWIuZWxlY3RyaWMtYS5lbGVjdHJpYzsKICAgICAgY29uc3QgdGVtcFdvcmRzPXQ+MC4wNT9udW0odCwxKSsiIMKwQyB3w6RybWVyIjp0PC0uMDU/bnVtKC10LDEpKyIgwrBDIGvDpGx0ZXIiOiJuYWhlenUgZ2xlaWNoIHdhcm0iOwogICAgICBjb25zdCBlbmVyZ3lXb3Jkcz1lPjA/InVtICIrbnVtKGUpKyIga1doIG1laHIiOmU8MD8idW0gIitudW0oLWUpKyIga1doIHdlbmlnZXIiOiJnbGVpY2ggdmllbCI7CiAgICAgIGluZm89Yi55ZWFyKyIgd2FyIGdlZ2Vuw7xiZXIgIithLnllYXIrIiAiK3RlbXBXb3JkcysiOyBkaWUgV8Okcm1lcHVtcGUgYnJhdWNodGUgIitlbmVyZ3lXb3JkcysKICAgICAgICAiIEhlaXpzdHJvbS4gRWluIGdlcmluZ2VyZXIgU3Ryb21iZWRhcmYga2FubiBuZWJlbiBkZW0gV2V0dGVyIHdlaXRlcmUgVXJzYWNoZW4gaGFiZW4uIjsKICAgIH0KICAgIGVsLmlubmVySFRNTD1oZWFkK3RhYmxlKyc8cD4nK2VzY2FwZUh0bWwoaW5mbykrJzwvcD4nOwogIH0KICBmdW5jdGlvbiBkcmF3Q2xpbWF0ZUNvdXBsZWRDaGFydChjYW52YXNJZCxtYXRyaXgseWVhcnMsbW9udGhzLG1ldHJpYyl7CiAgICBjb25zdCBjYW52YXM9JChjYW52YXNJZCksYz1jYW52YXNTZXR1cChjYW52YXMpO2lmKCFjKXJldHVybjsKICAgIGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jLGxlZnQ9NDcscmlnaHQ9MTAsdG9wPTE1LGJvdHRvbT0zNSxwbG90Vz13aWR0aC1sZWZ0LXJpZ2h0LHBsb3RIPWhlaWdodC10b3AtYm90dG9tOwogICAgY29uc3QgcG9zPWk9PmxlZnQrcGxvdFcqKGkrLjUpL21vbnRocy5sZW5ndGg7CiAgICBjb25zdCB2YWxzPXllYXJzLmZsYXRNYXAoeT0+bW9udGhzLm1hcChtPT5tYXRyaXguZ2V0KHkpPy5bbS0xXT8uW21ldHJpY10pKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTsKICAgIGNhbnZhcy5zZXRBdHRyaWJ1dGUoImFyaWEtbGFiZWwiLChtZXRyaWM9PT0idGVtcCI/IkF1w59lbnRlbXBlcmF0dXIgaW4gR3JhZCBDZWxzaXVzIjoiSGVpenN0cm9tIGRlciBXw6RybWVwdW1wZSBpbiBLaWxvd2F0dHN0dW5kZW4iKSsKICAgICAgIiBmw7xyICIreWVhcnMuam9pbigiLCAiKSsiIGltIGdsZWljaGVuIEphaHJlc21vbmF0c3Jhc3RlciIpOwogICAgaWYoIXZhbHMubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCxtZXRyaWM9PT0idGVtcCI/IldldHRlcmhpc3RvcmllIG5vY2ggbmljaHQgZ2VsYWRlbiI6IktlaW5lIEhlaXpzdHJvbS1Nb25hdHN3ZXJ0ZSIpO3JldHVybjt9CiAgICBjb25zdCBsb3c9bWV0cmljPT09InRlbXAiP01hdGguZmxvb3IoTWF0aC5taW4oLi4udmFscyktMyk6MDsKICAgIGNvbnN0IGhpPW1ldHJpYz09PSJ0ZW1wIj9NYXRoLmNlaWwoTWF0aC5tYXgoLi4udmFscykrMyk6TWF0aC5tYXgoMSxNYXRoLmNlaWwoTWF0aC5tYXgoLi4udmFscykqMS4xMikpOwogICAgY29uc3QgcmFuZ2U9TWF0aC5tYXgoMSxoaS1sb3cpLHk9dmFsdWU9PnRvcCtwbG90SCooMS0odmFsdWUtbG93KS9yYW5nZSk7CiAgICBjdHguZm9udD0nMTFweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmJztjdHgudGV4dEFsaWduPSJsZWZ0IjtjdHgubGluZVdpZHRoPTE7CiAgICBmb3IobGV0IGk9MDtpPD00O2krKyl7CiAgICAgIGNvbnN0IHl5PXRvcCtwbG90SCppLzQsdj1sb3crcmFuZ2UqKDEtaS80KTsKICAgICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkO2N0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKGxlZnQseXkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseXkpO2N0eC5zdHJva2UoKTsKICAgICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZmlsbFRleHQobWV0cmljPT09ImVsZWN0cmljIiYmdj49MTAwMD9udW0odi8xMDAwLDEpKyJrIjpudW0odiwwKSwzLHl5KzMpOwogICAgfQogICAgY3R4LnRleHRBbGlnbj0iY2VudGVyIjtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5mb250PScxMXB4IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LFNlZ29lIFVJLHNhbnMtc2VyaWYnOwogICAgbW9udGhzLmZvckVhY2goKG0saSk9PmN0eC5maWxsVGV4dChNT05USFNbbS0xXSxwb3MoaSksaGVpZ2h0LTEwKSk7CiAgICB5ZWFycy5mb3JFYWNoKCh5ZWFyLGopPT57CiAgICAgIGNvbnN0IGNvbG9yPWRhc2hib2FyZENvbXBhcmlzb25Db2xvcih5ZWFyLGopLGRhdGE9bWF0cml4LmdldCh5ZWFyKTsKICAgICAgY3R4LnN0cm9rZVN0eWxlPWNvbG9yO2N0eC5maWxsU3R5bGU9Y29sb3I7Y3R4LmxpbmVXaWR0aD0yLjg7Y3R4LmJlZ2luUGF0aCgpOwogICAgICBsZXQgc3RhcnRlZD1mYWxzZSxwcmV2aW91c01vbnRoPW51bGw7CiAgICAgIG1vbnRocy5mb3JFYWNoKChtb250aCxpKT0+ewogICAgICAgIGNvbnN0IHY9ZGF0YT8uW21vbnRoLTFdPy5bbWV0cmljXTsKICAgICAgICBpZighTnVtYmVyLmlzRmluaXRlKHYpKXtzdGFydGVkPWZhbHNlO3ByZXZpb3VzTW9udGg9bnVsbDtyZXR1cm47fQogICAgICAgIGlmKHByZXZpb3VzTW9udGghPT1udWxsJiZtb250aC1wcmV2aW91c01vbnRoPjEpc3RhcnRlZD1mYWxzZTsKICAgICAgICBpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyhwb3MoaSkseSh2KSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8ocG9zKGkpLHkodikpOwogICAgICAgIHByZXZpb3VzTW9udGg9bW9udGg7CiAgICAgIH0pOwogICAgICBjdHguc3Ryb2tlKCk7CiAgICAgIG1vbnRocy5mb3JFYWNoKChtb250aCxpKT0+ewogICAgICAgIGNvbnN0IHY9ZGF0YT8uW21vbnRoLTFdPy5bbWV0cmljXTtpZighTnVtYmVyLmlzRmluaXRlKHYpKXJldHVybjsKICAgICAgICBjdHguYmVnaW5QYXRoKCk7Y3R4LmFyYyhwb3MoaSkseSh2KSwzLjIsMCwyKk1hdGguUEkpO2N0eC5maWxsKCk7CiAgICAgIH0pOwogICAgfSk7CiAgICBjb25zdCBzZWxlY3RlZD1OdW1iZXIoU3RyaW5nKGRhc2hib2FyZENsaW1hdGVTZWxlY3RlZE1vbnRofHwiIikuc2xpY2UoLTIpKSxpeD1tb250aHMuaW5kZXhPZihzZWxlY3RlZCk7CiAgICBpZihpeD49MCl7Y3R4LnNldExpbmVEYXNoKFszLDRdKTtjdHguc3Ryb2tlU3R5bGU9InJnYmEoMjEyLDIzNiwyNTEsLjcpIjtjdHgubGluZVdpZHRoPTE7CiAgICAgIGN0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKHBvcyhpeCksdG9wKTtjdHgubGluZVRvKHBvcyhpeCksdG9wK3Bsb3RIKTtjdHguc3Ryb2tlKCk7Y3R4LnNldExpbmVEYXNoKFtdKTt9CiAgICBjdHgudGV4dEFsaWduPSJsZWZ0IjsKICB9CiAgZnVuY3Rpb24gcmVuZGVyRGFzaGJvYXJkKCl7CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0UmVjb3JkKCk7CiAgICAkKCJsYXRlc3RNb250aFRpdGxlIikudGV4dENvbnRlbnQ9bGF0ZXN0P21vbnRoTGFiZWwobGF0ZXN0Lm1vbnRoKToiTm9jaCBrZWluZSBNb25hdHN3ZXJ0ZSI7CiAgICAkKCJlZGl0TGF0ZXN0QnRuIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhbGF0ZXN0KTsKICAgIGlmKGxhdGVzdCkkKCJlZGl0TGF0ZXN0QnRuIikuZGF0YXNldC5tb250aD1sYXRlc3QubW9udGg7CiAgICBjb25zdCByZXN0PWxhdGVzdD9kZXJpdmVkKGxhdGVzdCk6bnVsbDsKICAgIGNvbnN0IG1ldHJpY3M9bGF0ZXN0P1sKICAgICAgWyJHZXNhbXQiLGAke251bShsYXRlc3QudG90YWwsMSl9IGtXaGAsbGF0ZXN0Lm1ldGVyUmVhZGluZ0RhdGU/YGF1cyBaw6RobGVyc3RhbmQgJHtkYXRlTGFiZWwobGF0ZXN0Lm1ldGVyUmVhZGluZ0RhdGUpfWA6ImRva3VtZW50aWVydCJdLAogICAgICBbIlfDpHJtZXB1bXBlIixgJHtudW0obGF0ZXN0LmhlYXRQdW1wLDEpfSBrV2hgLE51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZsYXRlc3QudG90YWw+MCYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC5oZWF0UHVtcCk/YCR7bnVtKGxhdGVzdC5oZWF0UHVtcC9sYXRlc3QudG90YWwqMTAwLDEpfSAlIEFudGVpbGA6IuKAkyJdLAogICAgICBbIkFsdGVudGVpbCIsYCR7bnVtKGxhdGVzdC5hbm5leCwxKX0ga1doYCxsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZT9gWsOkaGxlciAke251bShsYXRlc3QuYW5uZXhNZXRlclJlYWRpbmcsMCl9IGtXaGA6TnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LmFubmV4KT9gJHtudW0obGF0ZXN0LmFubmV4L2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoi4oCTIl0sCiAgICAgIFsiU2NobGVlL0tsdXMiLGAke251bShyZXN0LDEpfSBrV2hgLE51bWJlci5pc0Zpbml0ZShyZXN0KSYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wP2Ake251bShyZXN0L2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoiYXV0b21hdGlzY2giXSwKICAgICAgWyJLb3N0ZW4iLGV1cm8ocmVjb3JkQ29zdChsYXRlc3QpKSxsYXRlc3Qub3N0cm9tUHJpY2VDb21wbGV0ZT9gT3N0cm9tIGV4YWt0IMK3ICR7bnVtKGxhdGVzdC5wcmljZUN0LDIpfSBjdC9rV2hgOk51bWJlci5pc0Zpbml0ZShsYXRlc3QucHJpY2VDdCk/YCR7bnVtKGxhdGVzdC5wcmljZUN0LDIpfSBjdC9rV2hgOiJGYWxsYmFjay1QcmVpcyJdCiAgICBdOltbIkdlc2FtdCIsIuKAkyIsIk1vbmF0IGVpbnRyYWdlbiJdLFsiV8Okcm1lcHVtcGUiLCLigJMiLCIiXSxbIkFsdGVudGVpbCIsIuKAkyIsIiJdLFsiU2NobGVlL0tsdXMiLCLigJMiLCIiXSxbIktvc3RlbiIsIuKAkyIsIiJdXTsKICAgICQoImxhdGVzdE1ldHJpY3MiKS5pbm5lckhUTUw9bWV0cmljcy5tYXAoKFtsYWJlbCx2YWx1ZSxzbWFsbF0pPT5gPGFydGljbGU+PHNwYW4+JHtsYWJlbH08L3NwYW4+PHN0cm9uZz4ke3ZhbHVlfTwvc3Ryb25nPjxzbWFsbD4ke3NtYWxsfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgY29uc3QgY29tcGFyZT1sYXRlc3Q/cmVjb3JkRm9yTW9udGgoYCR7TnVtYmVyKGxhdGVzdC5tb250aC5zbGljZSgwLDQpKS0xfS0ke2xhdGVzdC5tb250aC5zbGljZSg1LDcpfWApOm51bGw7CiAgICBjb25zdCBkZWx0YT1sYXRlc3QmJmNvbXBhcmUmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoY29tcGFyZS50b3RhbCkmJmNvbXBhcmUudG90YWwhPT0wPyhsYXRlc3QudG90YWwtY29tcGFyZS50b3RhbCkvY29tcGFyZS50b3RhbCoxMDA6bnVsbDsKICAgIGNvbnN0IGNvbXA9JCgibGF0ZXN0Q29tcGFyaXNvbiIpOwogICAgY29tcC5jbGFzc05hbWU9ImNvbXBhcmlzb24tbGluZSBuZXV0cmFsIjsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShkZWx0YSkpewogICAgICBjb21wLnRleHRDb250ZW50PWBadW0gZ2xlaWNoZW4gTW9uYXQgZGVzIFZvcmphaHJlczogJHtwY3QoZGVsdGEpfSAoJHtudW0obGF0ZXN0LnRvdGFsLWNvbXBhcmUudG90YWwsMSl9IGtXaCkuYDsKICAgICAgY29tcC5jbGFzc05hbWU9YGNvbXBhcmlzb24tbGluZSAke2RlbHRhPjA/InBvc2l0aXZlIjpkZWx0YTwwPyJuZWdhdGl2ZSI6Im5ldXRyYWwifWA7CiAgICB9ZWxzZSBjb21wLnRleHRDb250ZW50PWxhdGVzdD8iRsO8ciBkaWVzZW4gTW9uYXQgaXN0IG5vY2gga2VpbiB2b2xsc3TDpG5kaWdlciBWb3JqYWhyZXN2ZXJnbGVpY2ggdm9yaGFuZGVuLiI6IlRyYWdlIGRlbiBlcnN0ZW4gTW9uYXRzd2VydCBlaW4uIjsKICAgIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpOwogICAgcmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7CiAgICByZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJSZWNvcmRzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3Qgc2VsZWN0PSQoInJlY29yZFllYXJGaWx0ZXIiKTsKICAgIGNvbnN0IGN1cnJlbnQ9c2VsZWN0LnZhbHVlfHwiYWxsIjsKICAgIHNlbGVjdC5pbm5lckhUTUw9JzxvcHRpb24gdmFsdWU9ImFsbCI+QWxsZSBKYWhyZTwvb3B0aW9uPicreXMubWFwKHk9PmA8b3B0aW9uIHZhbHVlPSIke3l9Ij4ke3l9PC9vcHRpb24+YCkuam9pbigiIik7CiAgICBzZWxlY3QudmFsdWU9eXMuaW5jbHVkZXMoTnVtYmVyKGN1cnJlbnQpKT9jdXJyZW50OiJhbGwiOwogICAgY29uc3QgZmlsdGVyZWQ9c29ydGVkKCkucmV2ZXJzZSgpLmZpbHRlcihyPT5zZWxlY3QudmFsdWU9PT0iYWxsInx8ci5tb250aC5zdGFydHNXaXRoKGAke3NlbGVjdC52YWx1ZX0tYCkpOwogICAgJCgicmVjb3JkQ291bnQiKS50ZXh0Q29udGVudD1gJHtmaWx0ZXJlZC5sZW5ndGh9ICR7ZmlsdGVyZWQubGVuZ3RoPT09MT8iTW9uYXQiOiJNb25hdGUifWA7CiAgICBpZighZmlsdGVyZWQubGVuZ3RoKXsgJCgicmVjb3JkTGlzdCIpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPjxzdHJvbmc+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZSBpbiBkaWVzZXIgQXVzd2FobC48L3N0cm9uZz48c3Bhbj5aw6RobGVyc3TDpG5kZSB1bmQgbXlWQUlMTEFOVC1DU1YgZXJ6ZXVnZW4gZGllIE1vbmF0c3dlcnRlIGF1dG9tYXRpc2NoLjwvc3Bhbj48L2Rpdj4nOyByZXR1cm47IH0KICAgICQoInJlY29yZExpc3QiKS5pbm5lckhUTUw9ZmlsdGVyZWQubWFwKHI9PnsKICAgICAgY29uc3QgcmVzdD1kZXJpdmVkKHIpLCBpbnZhbGlkPU51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwOwogICAgICBjb25zdCBzdGF0dXM9aW52YWxpZD8iVW5wbGF1c2liZWwiOmNvbXBsZXRlKHIpPyJ2b2xsc3TDpG5kaWciOiJ1bnZvbGxzdMOkbmRpZyI7CiAgICAgIGNvbnN0IHNvdXJjZT0oci5tZXRlclJlYWRpbmdEYXRlP2Ag4oCiIFrDpGhsZXIgYmlzICR7ZGF0ZUxhYmVsKHIubWV0ZXJSZWFkaW5nRGF0ZSl9YDpyLmhlYXRQdW1wU291cmNlPy5zdGFydHNXaXRoKCJteXZhaWxsYW50Iik/IiDigKIgV8Okcm1lcHVtcGUgYXVzIENTViI6IiIpKyhyLm9zdHJvbVByaWNlQ29tcGxldGU/IiDigKIgT3N0cm9tLVByZWlzIGV4YWt0IjoiIik7CiAgICAgIHJldHVybiBgPGFydGljbGUgY2xhc3M9InJlY29yZC1yb3cgJHtpbnZhbGlkPyJpbnZhbGlkIjoiIn0iPgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC1tb250aCI+PHN0cm9uZz4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChyLm1vbnRoKSl9PC9zdHJvbmc+PHNtYWxsPiR7c3RhdHVzfSR7c291cmNlfSR7ci5ub3RlP2Ag4oCiICR7ZXNjYXBlSHRtbChyLm5vdGUuc2xpY2UoMCw3MCkpfWA6IiJ9PC9zbWFsbD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPkdlc2FtdDwvc3Bhbj48c3Ryb25nPiR7bnVtKHIudG90YWwsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+V8Okcm1lcHVtcGU8L3NwYW4+PHN0cm9uZz4ke251bShyLmhlYXRQdW1wLDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPkFsdGVudGVpbDwvc3Bhbj48c3Ryb25nPiR7bnVtKHIuYW5uZXgsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+U2NobGVlL0tsdXM8L3NwYW4+PHN0cm9uZz4ke251bShyZXN0LDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCBlZGl0LXJlY29yZCIgdHlwZT0iYnV0dG9uIiBkYXRhLWVkaXQtbW9udGg9IiR7ci5tb250aH0iPkJlYXJiZWl0ZW48L2J1dHRvbj4KICAgICAgPC9hcnRpY2xlPmA7CiAgICB9KS5qb2luKCIiKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5SZWNvcmRNb2RhbChtb250aCl7CiAgICBjb25zdCByPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgIGlmKCFyKXt0b2FzdCgiTW9uYXQgbmljaHQgZ2VmdW5kZW4iKTtyZXR1cm47fQogICAgJCgicmVjb3JkTW9kYWxUaXRsZSIpLnRleHRDb250ZW50PW1vbnRoTGFiZWwoci5tb250aCk7CiAgICAkKCJlZGl0aW5nTW9udGhPcmlnaW5hbCIpLnZhbHVlPXIubW9udGg7CiAgICAkKCJyZWNvcmRNb250aCIpLnZhbHVlPXIubW9udGg7CiAgICAkKCJyZWNvcmRUb3RhbCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLnRvdGFsKT9yLnRvdGFsOiIiOwogICAgJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCk/ci5oZWF0UHVtcDoiIjsKICAgICQoInJlY29yZEFubmV4IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuYW5uZXgpP3IuYW5uZXg6IiI7CiAgICAkKCJyZWNvcmRQcmljZUN0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIucHJpY2VDdCk/ci5wcmljZUN0OiIiOwogICAgJCgicmVjb3JkQmFzZUZlZSIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmJhc2VGZWUpP3IuYmFzZUZlZToiIjsKICAgICQoInJlY29yZEhlYXRHZW5lcmF0ZWQiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0R2VuZXJhdGVkKT9yLmhlYXRHZW5lcmF0ZWQ6IiI7CiAgICAkKCJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0aW5nRWxlY3RyaWNpdHkpP3IuaGVhdGluZ0VsZWN0cmljaXR5OiIiOwogICAgJCgicmVjb3JkRGh3RWxlY3RyaWNpdHkiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5kaHdFbGVjdHJpY2l0eSk/ci5kaHdFbGVjdHJpY2l0eToiIjsKICAgICQoInJlY29yZEhlYXRpbmdIZWF0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdGluZ0hlYXQpP3IuaGVhdGluZ0hlYXQ6IiI7CiAgICAkKCJyZWNvcmREaHdIZWF0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuZGh3SGVhdCk/ci5kaHdIZWF0OiIiOwogICAgJCgicmVjb3JkTm90ZSIpLnZhbHVlPXIubm90ZXx8IiI7CiAgICAkKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IiI7CiAgICAkKCJyZWNvcmRTb3VyY2VIaW50IikudGV4dENvbnRlbnQ9ci5tZXRlclJlYWRpbmdEYXRlCiAgICAgID8gYERpZXNlciBNb25hdCB3dXJkZSBhdXMgWsOkaGxlcnN0w6RuZGVuIGJlcmVjaG5ldC4gRWluZSBLb3JyZWt0dXIgaGllciDDpG5kZXJ0IG51ciBkZW4gTW9uYXRzd2VydDsgZGllIGdlc3BlaWNoZXJ0ZW4gWsOkaGxlcnN0w6RuZGUgYmlzICR7ZGF0ZUxhYmVsKHIubWV0ZXJSZWFkaW5nRGF0ZSl9IGJsZWliZW4gZXJoYWx0ZW4uYAogICAgICA6IHIuaGVhdFB1bXBTb3VyY2U/LnN0YXJ0c1dpdGgoIm15dmFpbGxhbnQiKQogICAgICAgID8gIkRpZSBXw6RybWVwdW1wZW53ZXJ0ZSBzdGFtbWVuIGF1cyBlaW5lciBteVZBSUxMQU5ULUNTVi4gTWFudWVsbGUgw4RuZGVydW5nZW4ga8O2bm5lbiBiZWkgZWluZW0gc3DDpHRlcmVuIGVybmV1dGVuIENTVi1JbXBvcnQgd2llZGVyIGVyc2V0enQgd2VyZGVuLiIKICAgICAgICA6ICJNYW51ZWxsZSBLb3JyZWt0dXIgZWluZXMgZ2VzcGVpY2hlcnRlbiBNb25hdHN3ZXJ0ZXMuIjsKICAgIHVwZGF0ZURlcml2ZWRQcmV2aWV3KCk7CiAgICAkKCJyZWNvcmRNb2RhbCIpLmNsYXNzTGlzdC5yZW1vdmUoImhpZGRlbiIpOwogICAgZG9jdW1lbnQuYm9keS5zdHlsZS5vdmVyZmxvdz0iaGlkZGVuIjsKICB9CiAgZnVuY3Rpb24gY2xvc2VSZWNvcmRNb2RhbCgpeyAkKCJyZWNvcmRNb2RhbCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOyBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSIiOyB9CiAgZnVuY3Rpb24gdXBkYXRlRGVyaXZlZFByZXZpZXcoKXsKICAgIGNvbnN0IHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoInJlY29yZFRvdGFsIikudmFsdWUpLGhlYXQ9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkQW5uZXgiKS52YWx1ZSk7CiAgICBjb25zdCBlbD0kKCJkZXJpdmVkUHJldmlldyIpOwogICAgaWYoW3RvdGFsLGhlYXQsYW5uZXhdLmV2ZXJ5KE51bWJlci5pc0Zpbml0ZSkpewogICAgICBjb25zdCByZXN0PXRvdGFsLWhlYXQtYW5uZXg7CiAgICAgIGVsLnRleHRDb250ZW50PWBTY2hsZWUvS2x1czogJHtudW0ocmVzdCwzKX0ga1doYDsKICAgICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgiZXJyb3IiLHJlc3Q8MCk7CiAgICB9ZWxzZXsKICAgICAgZWwudGV4dENvbnRlbnQ9IlNjaGxlZS9LbHVzOiDigJMgKHdpcmQgYXVzIEdlc2FtdCDiiJIgV8Okcm1lcHVtcGUg4oiSIEFsdGVudGVpbCBiZXJlY2huZXQpIjsKICAgICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgiZXJyb3IiKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2F2ZUVkaXRlZFJlY29yZChldmVudCl7CiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgY29uc3QgbW9udGg9JCgiZWRpdGluZ01vbnRoT3JpZ2luYWwiKS52YWx1ZTsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgIGlmKCFleGlzdGluZyl7JCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgTW9uYXQgd3VyZGUgbmljaHQgZ2VmdW5kZW4uIjtyZXR1cm47fQogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkVG90YWwiKS52YWx1ZSksaGVhdFB1bXA9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkQW5uZXgiKS52YWx1ZSk7CiAgICBpZihbdG90YWwsaGVhdFB1bXAsYW5uZXhdLmV2ZXJ5KE51bWJlci5pc0Zpbml0ZSkmJnRvdGFsLWhlYXRQdW1wLWFubmV4PC0uMDEpewogICAgICAkKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IlVucGxhdXNpYmVsOiBXw6RybWVwdW1wZSArIEFsdGVudGVpbCBzaW5kIGdyw7bDn2VyIGFscyBkZXIgR2VzYW10dmVyYnJhdWNoLiI7cmV0dXJuOwogICAgfQogICAgY29uc3QgaGVhdENoYW5nZWQ9aGVhdFB1bXAhPT1leGlzdGluZy5oZWF0UHVtcDsKICAgIGNvbnN0IG1ldGVyQ2hhbmdlZD10b3RhbCE9PWV4aXN0aW5nLnRvdGFsfHxhbm5leCE9PWV4aXN0aW5nLmFubmV4OwogICAgY29uc3QgbmV4dFByaWNlQ3Q9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkUHJpY2VDdCIpLnZhbHVlKSxuZXh0QmFzZUZlZT1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRCYXNlRmVlIikudmFsdWUpOwogICAgY29uc3QgcHJpY2VDaGFuZ2VkPW5leHRQcmljZUN0IT09ZXhpc3RpbmcucHJpY2VDdHx8bmV4dEJhc2VGZWUhPT1leGlzdGluZy5iYXNlRmVlOwogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgY29uc3QgcmVjb3JkPXsuLi5leGlzdGluZywKICAgICAgdG90YWwsaGVhdFB1bXAsYW5uZXgsCiAgICAgIHByaWNlQ3Q6bmV4dFByaWNlQ3QsCiAgICAgIGJhc2VGZWU6bmV4dEJhc2VGZWUsCiAgICAgIGhlYXRHZW5lcmF0ZWQ6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdEdlbmVyYXRlZCIpLnZhbHVlKSwKICAgICAgaGVhdGluZ0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIpLnZhbHVlKSwKICAgICAgZGh3RWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkRGh3RWxlY3RyaWNpdHkiKS52YWx1ZSksCiAgICAgIGhlYXRpbmdIZWF0Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRpbmdIZWF0IikudmFsdWUpLAogICAgICBkaHdIZWF0Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZERod0hlYXQiKS52YWx1ZSksCiAgICAgIG5vdGU6JCgicmVjb3JkTm90ZSIpLnZhbHVlLnRyaW0oKSwKICAgICAgaGVhdFB1bXBTb3VyY2U6aGVhdENoYW5nZWQ/Im1hbnVhbC1jb3JyZWN0aW9uIjpleGlzdGluZy5oZWF0UHVtcFNvdXJjZSwKICAgICAgaGVhdFB1bXBVcGRhdGVkQXQ6aGVhdENoYW5nZWQ/c3RhbXA6ZXhpc3RpbmcuaGVhdFB1bXBVcGRhdGVkQXQsCiAgICAgIG1ldGVyU291cmNlOm1ldGVyQ2hhbmdlZCYmZXhpc3RpbmcubWV0ZXJTb3VyY2U/YCR7ZXhpc3RpbmcubWV0ZXJTb3VyY2V9K21hbnVhbC1tb250aC1jb3JyZWN0aW9uYDpleGlzdGluZy5tZXRlclNvdXJjZSwKICAgICAgcHJpY2VTb3VyY2U6cHJpY2VDaGFuZ2VkPyJtYW51YWwtY29ycmVjdGlvbiI6ZXhpc3RpbmcucHJpY2VTb3VyY2UsCiAgICAgIHByaWNlVXBkYXRlZEF0OnByaWNlQ2hhbmdlZD9zdGFtcDpleGlzdGluZy5wcmljZVVwZGF0ZWRBdCwKICAgICAgb3N0cm9tVmFyaWFibGVDb3N0RXVyOnByaWNlQ2hhbmdlZD9udWxsOmV4aXN0aW5nLm9zdHJvbVZhcmlhYmxlQ29zdEV1ciwKICAgICAgb3N0cm9tVG90YWxDb3N0RXVyOnByaWNlQ2hhbmdlZD9udWxsOmV4aXN0aW5nLm9zdHJvbVRvdGFsQ29zdEV1ciwKICAgICAgb3N0cm9tQ29uc3VtcHRpb25LV2g6cHJpY2VDaGFuZ2VkP251bGw6ZXhpc3Rpbmcub3N0cm9tQ29uc3VtcHRpb25LV2gsCiAgICAgIG9zdHJvbVByaWNlQ29tcGxldGU6cHJpY2VDaGFuZ2VkP2ZhbHNlOmV4aXN0aW5nLm9zdHJvbVByaWNlQ29tcGxldGUsCiAgICAgIHVwZGF0ZWRBdDpzdGFtcAogICAgfTsKICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PW1vbnRoKTtuZXh0LnB1c2gocmVjb3JkKTsKICAgIHRyeXtzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YE1vbmF0ICR7bW9udGh9IG1hbnVlbGwga29ycmlnaWVydGB9KTt9CiAgICBjYXRjaChlcnJvcil7JCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWVycm9yLm1lc3NhZ2U7cmV0dXJuO30KICAgIGNsb3NlUmVjb3JkTW9kYWwoKTtyZW5kZXJBbGwoKTt0b2FzdChgJHttb250aExhYmVsKG1vbnRoKX0gZ2XDpG5kZXJ0YCk7CiAgfQoKICBmdW5jdGlvbiBvcGVuTWV0ZXJNb2RhbCgpewogICAgY29uc3QgcHJldmlvdXM9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighcHJldmlvdXMpe2FsZXJ0KCJFcyBmZWhsdCBlaW4gQXVzZ2FuZ3N6w6RobGVyc3RhbmQuIik7cmV0dXJuO30KICAgICQoIm1ldGVyRGF0ZSIpLnZhbHVlPW5leHRNb250aEZpcnN0KHByZXZpb3VzLmRhdGUpOwogICAgJCgibWV0ZXJUb3RhbCIpLnZhbHVlPSIiOwogICAgJCgibWV0ZXJBbm5leCIpLnZhbHVlPSIiOwogICAgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IiI7CiAgICB1cGRhdGVNZXRlclByZXZpZXcoKTsKICAgICQoIm1ldGVyTW9kYWwiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsKICAgIGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9ImhpZGRlbiI7CiAgICBzZXRUaW1lb3V0KCgpPT4kKCJtZXRlclRvdGFsIikuZm9jdXMoKSw1MCk7CiAgfQogIGZ1bmN0aW9uIGNsb3NlTWV0ZXJNb2RhbCgpeyAkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7IGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9IiI7IH0KICBmdW5jdGlvbiB1cGRhdGVNZXRlclByZXZpZXcoKXsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXJldHVybjsKICAgIGNvbnN0IGRhdGU9JCgibWV0ZXJEYXRlIikudmFsdWV8fG5leHRNb250aEZpcnN0KHByZXZpb3VzLmRhdGUpOwogICAgY29uc3QgdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpOwogICAgJCgibWV0ZXJQcmV2aW91cyIpLmlubmVySFRNTD1gVm9yaGVyaWdlciBTdGFuZDogPHN0cm9uZz4ke2RhdGVMYWJlbChwcmV2aW91cy5kYXRlKX08L3N0cm9uZz4gwrcgR2VzYW10IDxzdHJvbmc+JHtudW0ocHJldmlvdXMudG90YWwsMCl9IGtXaDwvc3Ryb25nPiDCtyBBbHRlbnRlaWwgPHN0cm9uZz4ke251bShwcmV2aW91cy5hbm5leCwwKX0ga1doPC9zdHJvbmc+YDsKICAgICQoIm1ldGVyVGFyZ2V0TW9udGgiKS50ZXh0Q29udGVudD1gQmVyZWNobmV0IHdpcmQgZGVyIFZlcmJyYXVjaCBmw7xyICR7bW9udGhMYWJlbCh0YXJnZXRNb250aCl9LmA7CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcigkKCJtZXRlclRvdGFsIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyQW5uZXgiKS52YWx1ZSk7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUodG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoYW5uZXgpKXsKICAgICAgY29uc3QgdG90YWxVc2U9dG90YWwtcHJldmlvdXMudG90YWwsYW5uZXhVc2U9YW5uZXgtcHJldmlvdXMuYW5uZXg7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKSxoZWF0PWV4aXN0aW5nPy5oZWF0UHVtcDsKICAgICAgY29uc3QgcmVzdD1OdW1iZXIuaXNGaW5pdGUoaGVhdCk/dG90YWxVc2UtYW5uZXhVc2UtaGVhdDpudWxsOwogICAgICAkKCJtZXRlclByZXZpZXciKS5pbm5lckhUTUw9YEdlc2FtdDogPHN0cm9uZz4ke251bSh0b3RhbFVzZSwxKX0ga1doPC9zdHJvbmc+IMK3IEFsdGVudGVpbDogPHN0cm9uZz4ke251bShhbm5leFVzZSwxKX0ga1doPC9zdHJvbmc+JHtOdW1iZXIuaXNGaW5pdGUoaGVhdCk/YCDCtyBXw6RybWVwdW1wZTogPHN0cm9uZz4ke251bShoZWF0LDEpfSBrV2g8L3N0cm9uZz4gwrcgU2NobGVlL0tsdXM6IDxzdHJvbmc+JHtudW0ocmVzdCwxKX0ga1doPC9zdHJvbmc+YDpgIMK3IFfDpHJtZXB1bXBlOiA8c3Ryb25nPkNTViBmZWhsdDwvc3Ryb25nPmB9YDsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuY2xhc3NMaXN0LnRvZ2dsZSgiZXJyb3IiLHRvdGFsVXNlPDB8fGFubmV4VXNlPDB8fChOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8MCkpOwogICAgfWVsc2V7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLnRleHRDb250ZW50PSJNb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXVzIGRlciBEaWZmZXJlbnogenVtIHZvcmhlcmlnZW4gWsOkaGxlcnN0YW5kIGJlcmVjaG5ldC4iOwogICAgICAkKCJtZXRlclByZXZpZXciKS5jbGFzc0xpc3QucmVtb3ZlKCJlcnJvciIpOwogICAgfQogIH0KICBmdW5jdGlvbiBzYXZlTWV0ZXJSZWFkaW5nRnJvbUZvcm0oZXZlbnQpewogICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXJldHVybjsKICAgIGNvbnN0IGRhdGU9JCgibWV0ZXJEYXRlIikudmFsdWUsdG90YWw9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJUb3RhbCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJtZXRlckFubmV4IikudmFsdWUpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0tXGR7Mn0kLy50ZXN0KGRhdGUpKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkJpdHRlIGVpbiBnw7xsdGlnZXMgQWJsZXNlZGF0dW0gd8OkaGxlbi4iOyByZXR1cm47IH0KICAgIGlmKGRhdGU8PXByZXZpb3VzLmRhdGUpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1gRGFzIERhdHVtIG11c3MgbmFjaCBkZW0gbGV0enRlbiBTdGFuZCB2b20gJHtkYXRlTGFiZWwocHJldmlvdXMuZGF0ZSl9IGxpZWdlbi5gOyByZXR1cm47IH0KICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUodG90YWwpfHwhTnVtYmVyLmlzRmluaXRlKGFubmV4KSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJCaXR0ZSBiZWlkZSBaw6RobGVyc3TDpG5kZSBlaW50cmFnZW4uIjsgcmV0dXJuOyB9CiAgICBpZih0b3RhbDxwcmV2aW91cy50b3RhbCl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgR2VzYW10esOkaGxlcnN0YW5kIGlzdCBrbGVpbmVyIGFscyBkZXIgdm9yaGVyaWdlIFN0YW5kLiBFaW4gbmV1ZXIgWsOkaGxlciBtw7xzc3RlIHNlcGFyYXQgYmVyw7xja3NpY2h0aWd0IHdlcmRlbi4iOyByZXR1cm47IH0KICAgIGlmKGFubmV4PHByZXZpb3VzLmFubmV4KXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkRlciBBbHRlbnRlaWwtWsOkaGxlcnN0YW5kIGlzdCBrbGVpbmVyIGFscyBkZXIgdm9yaGVyaWdlIFN0YW5kLiI7IHJldHVybjsgfQogICAgY29uc3QgdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpLHRvdGFsVXNlPXRvdGFsLXByZXZpb3VzLnRvdGFsLGFubmV4VXNlPWFubmV4LXByZXZpb3VzLmFubmV4OwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgodGFyZ2V0TW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6dGFyZ2V0TW9udGh9KTsKICAgIGNvbnN0IHJlc3Q9TnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmhlYXRQdW1wKT90b3RhbFVzZS1hbm5leFVzZS1leGlzdGluZy5oZWF0UHVtcDpudWxsOwogICAgaWYoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PC0uMDEpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1gVW5wbGF1c2liZWw6IE5hY2ggQWJ6dWcgdm9uIFfDpHJtZXB1bXBlIHVuZCBBbHRlbnRlaWwgZXJnaWJ0IFNjaGxlZS9LbHVzICR7bnVtKHJlc3QsMSl9IGtXaC5gOyByZXR1cm47IH0KICAgIGNvbnN0IHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIGNvbnN0IG5leHRSZWNvcmQ9ey4uLmV4aXN0aW5nLHRvdGFsOnRvdGFsVXNlLGFubmV4OmFubmV4VXNlLG1ldGVyUmVhZGluZ0RhdGU6ZGF0ZSxwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6cHJldmlvdXMuZGF0ZSx0b3RhbE1ldGVyUmVhZGluZzp0b3RhbCxhbm5leE1ldGVyUmVhZGluZzphbm5leCxtZXRlclNvdXJjZToiY3VtdWxhdGl2ZS1yZWFkaW5ncyIsdXBkYXRlZEF0OnN0YW1wfTsKICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PXRhcmdldE1vbnRoKTtuZXh0LnB1c2gobmV4dFJlY29yZCk7CiAgICB0cnl7CiAgICAgIHNhdmVSZWNvcmRzKG5leHQse3JlYXNvbjpgWsOkaGxlcnN0w6RuZGUgJHtkYXRlTGFiZWwoZGF0ZSl9IGdlc3BlaWNoZXJ0YH0pOwogICAgICBzYXZlTWV0ZXJSZWFkaW5ncyhbLi4ubWV0ZXJSZWFkaW5ncyx7ZGF0ZSx0b3RhbCxhbm5leCxub3RlOmBWZXJicmF1Y2ggJHt0YXJnZXRNb250aH1gLHVwZGF0ZWRBdDpzdGFtcH1dKTsKICAgIH1jYXRjaChlcnJvcil7JCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9ZXJyb3IubWVzc2FnZTtyZXR1cm47fQogICAgY2xvc2VNZXRlck1vZGFsKCk7cmVuZGVyQWxsKCk7CiAgICB0b2FzdChOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcuaGVhdFB1bXApP2Ake21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfSB2b2xsc3TDpG5kaWcgYmVyZWNobmV0YDpgWsOkaGxlcnN0w6RuZGUgZ2VzcGVpY2hlcnQgwrcgV8Okcm1lcHVtcGVuLUNTViBmZWhsdCBub2NoYCk7CiAgfQogIGZ1bmN0aW9uIHVuZG9MYXRlc3RNZXRlclJlYWRpbmcoKXsKICAgIGlmKG1ldGVyUmVhZGluZ3MubGVuZ3RoPD0xKXJldHVybjsKICAgIGNvbnN0IGxhdGVzdD1tZXRlclJlYWRpbmdzLmF0KC0xKSxwcmV2aW91cz1tZXRlclJlYWRpbmdzLmF0KC0yKSx0YXJnZXRNb250aD1wcmV2aW91cy5kYXRlLnNsaWNlKDAsNyk7CiAgICBpZighY29uZmlybShgWsOkaGxlcnN0YW5kIHZvbSAke2RhdGVMYWJlbChsYXRlc3QuZGF0ZSl9IHp1csO8Y2tuZWhtZW4/IERpZSBkYXJhdXMgYmVyZWNobmV0ZW4gV2VydGUgZsO8ciAke21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfSB3ZXJkZW4gZW50ZmVybnQuYCkpcmV0dXJuOwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgodGFyZ2V0TW9udGgpOwogICAgaWYoZXhpc3RpbmcpewogICAgICBjb25zdCBjbGVhcmVkPXsuLi5leGlzdGluZyx0b3RhbDpudWxsLGFubmV4Om51bGwsbWV0ZXJSZWFkaW5nRGF0ZTpudWxsLHByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZTpudWxsLHRvdGFsTWV0ZXJSZWFkaW5nOm51bGwsYW5uZXhNZXRlclJlYWRpbmc6bnVsbCxtZXRlclNvdXJjZToiIix1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpfTsKICAgICAgY29uc3QgbmV4dD1yZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoIT09dGFyZ2V0TW9udGgpO25leHQucHVzaChjbGVhcmVkKTtzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YExldHp0ZW4gWsOkaGxlcnN0YW5kICR7bGF0ZXN0LmRhdGV9IHp1csO8Y2tnZW5vbW1lbmB9KTsKICAgIH0KICAgIHNhdmVNZXRlclJlYWRpbmdzKG1ldGVyUmVhZGluZ3Muc2xpY2UoMCwtMSkpO3JlbmRlckFsbCgpO3RvYXN0KCJMZXR6dGVuIFrDpGhsZXJzdGFuZCB6dXLDvGNrZ2Vub21tZW4iKTsKICB9CgogIGZ1bmN0aW9uIGFuYWx5c2lzWWVhclJvd3MoeWVhcil7IHJldHVybiByZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoLnN0YXJ0c1dpdGgoYCR7eWVhcn0tYCkpLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7IH0KICBmdW5jdGlvbiBvc3Ryb21TdGF0c0ZvclllYXIoeWVhcil7CiAgICBjb25zdCBjYWNoZT1uZXcgTWFwKG9zdHJvbVByaWNlU3RhdHMuZmlsdGVyKGl0ZW09Pml0ZW0ubW9udGguc3RhcnRzV2l0aChgJHt5ZWFyfS1gKSkubWFwKGl0ZW09PltpdGVtLm1vbnRoLGl0ZW1dKSk7CiAgICBmb3IoY29uc3QgciBvZiBhbmFseXNpc1llYXJSb3dzKHllYXIpKXsKICAgICAgaWYoIXIub3N0cm9tUHJpY2VDb21wbGV0ZXx8IU51bWJlci5pc0Zpbml0ZShyLnByaWNlQ3QpfHwhTnVtYmVyLmlzRmluaXRlKHIub3N0cm9tQ29uc3VtcHRpb25LV2gpfHxyLm9zdHJvbUNvbnN1bXB0aW9uS1doPD0wKWNvbnRpbnVlOwogICAgICBjb25zdCBmcm9tUmVjb3JkPXNhbml0aXplT3N0cm9tUHJpY2VTdGF0KHttb250aDpyLm1vbnRoLHdlaWdodGVkQXZlcmFnZUN0UGVyS1doOnIucHJpY2VDdCx0b3RhbEtXaDpyLm9zdHJvbUNvbnN1bXB0aW9uS1doLHZhcmlhYmxlQ29zdEV1cjpyLm9zdHJvbVZhcmlhYmxlQ29zdEV1cixmaXhlZENvc3RFdXI6ci5iYXNlRmVlLHRvdGFsQ29zdEV1cjpyLm9zdHJvbVRvdGFsQ29zdEV1cixjb21wbGV0ZTp0cnVlLHBhcnRpYWw6ZmFsc2UsdXBkYXRlZEF0OnIucHJpY2VVcGRhdGVkQXR8fHIudXBkYXRlZEF0fHwiIn0pOwogICAgICBjb25zdCBleGlzdGluZz1jYWNoZS5nZXQoci5tb250aCk7CiAgICAgIGlmKCFleGlzdGluZ3x8RGF0ZS5wYXJzZShmcm9tUmVjb3JkLnVwZGF0ZWRBdHx8IiIpPj1EYXRlLnBhcnNlKGV4aXN0aW5nLnVwZGF0ZWRBdHx8IiIpKWNhY2hlLnNldChyLm1vbnRoLGZyb21SZWNvcmQpOwogICAgfQogICAgcmV0dXJuIFsuLi5jYWNoZS52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gb3N0cm9tUGVyaW9kQXZlcmFnZShpdGVtcyl7CiAgICBjb25zdCB2YWxpZD0oQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pLmZpbHRlcihpdGVtPT5OdW1iZXIuaXNGaW5pdGUoaXRlbS50b3RhbEtXaCkmJml0ZW0udG90YWxLV2g+MCYmTnVtYmVyLmlzRmluaXRlKGl0ZW0udmFyaWFibGVDb3N0RXVyKSk7CiAgICBpZighdmFsaWQubGVuZ3RoKXJldHVybiB7YXZlcmFnZUN0Om51bGwsZWZmZWN0aXZlQ3Q6bnVsbCxrV2g6MCx2YXJpYWJsZUNvc3RFdXI6MCxmaXhlZENvc3RFdXI6MCx0b3RhbENvc3RFdXI6MCxtb250aHM6MCxwYXJ0aWFsOmZhbHNlfTsKICAgIGNvbnN0IGtXaD12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtK051bWJlcihpdGVtLnRvdGFsS1dofHwwKSwwKTsKICAgIGNvbnN0IHZhcmlhYmxlQ29zdEV1cj12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtK051bWJlcihpdGVtLnZhcmlhYmxlQ29zdEV1cnx8MCksMCk7CiAgICBjb25zdCBmaXhlZENvc3RFdXI9dmFsaWQucmVkdWNlKChzdW0saXRlbSk9PnN1bStOdW1iZXIoaXRlbS5maXhlZENvc3RFdXJ8fDApLDApOwogICAgY29uc3QgdG90YWxDb3N0RXVyPXZhbGlkLnJlZHVjZSgoc3VtLGl0ZW0pPT5zdW0rKE51bWJlci5pc0Zpbml0ZShpdGVtLnRvdGFsQ29zdEV1cik/TnVtYmVyKGl0ZW0udG90YWxDb3N0RXVyKTpOdW1iZXIoaXRlbS52YXJpYWJsZUNvc3RFdXJ8fDApK051bWJlcihpdGVtLmZpeGVkQ29zdEV1cnx8MCkpLDApOwogICAgcmV0dXJuIHthdmVyYWdlQ3Q6a1doPjA/dmFyaWFibGVDb3N0RXVyL2tXaCoxMDA6bnVsbCxlZmZlY3RpdmVDdDprV2g+MD90b3RhbENvc3RFdXIva1doKjEwMDpudWxsLGtXaCx2YXJpYWJsZUNvc3RFdXIsZml4ZWRDb3N0RXVyLHRvdGFsQ29zdEV1cixtb250aHM6dmFsaWQubGVuZ3RoLHBhcnRpYWw6dmFsaWQuc29tZShpdGVtPT5pdGVtLnBhcnRpYWwpfTsKICB9CiAgZnVuY3Rpb24gcXVhcnRlckZvck1vbnRoKG1vbnRoKXtyZXR1cm4gTWF0aC5mbG9vcigoTnVtYmVyKFN0cmluZyhtb250aCkuc2xpY2UoNSw3KSktMSkvMykrMTt9CiAgZnVuY3Rpb24gcmVuZGVyT3N0cm9tUHJpY2VTdGF0cyh5ZWFyKXsKICAgIGlmKCEkKCdvc3Ryb21QcmljZVN0YXRzTWV0cmljcycpKXJldHVybjsKICAgIGNvbnN0IGl0ZW1zPW9zdHJvbVN0YXRzRm9yWWVhcih5ZWFyKTsKICAgIGNvbnN0IGN1cnJlbnRZZWFyPW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKTsKICAgIGNvbnN0IGFubnVhbD1vc3Ryb21QZXJpb2RBdmVyYWdlKGl0ZW1zKTsKICAgIGNvbnN0IGNhcmRzPVtbU3RyaW5nKHllYXIpLGFubnVhbCx5ZWFyPT09Y3VycmVudFllYXI/ImJpcyBoZXV0ZSI6IkphaHJlc3dlcnQiXV07CiAgICBmb3IobGV0IHE9MTtxPD00O3ErKyljYXJkcy5wdXNoKFtgUSR7cX1gLG9zdHJvbVBlcmlvZEF2ZXJhZ2UoaXRlbXMuZmlsdGVyKGl0ZW09PnF1YXJ0ZXJGb3JNb250aChpdGVtLm1vbnRoKT09PXEpKSxgJHtpdGVtcy5maWx0ZXIoaXRlbT0+cXVhcnRlckZvck1vbnRoKGl0ZW0ubW9udGgpPT09cSkubGVuZ3RofSBNb25hdChlKWBdKTsKICAgICQoJ29zdHJvbVByaWNlU3RhdHNNZXRyaWNzJykuaW5uZXJIVE1MPWNhcmRzLm1hcCgoW2xhYmVsLHN0YXRzLHN1Yl0pPT5gPGFydGljbGU+PHNwYW4+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+PHN0cm9uZz4ke051bWJlci5pc0Zpbml0ZShzdGF0cy5hdmVyYWdlQ3QpP2Ake251bShzdGF0cy5hdmVyYWdlQ3QsMil9IGN0L2tXaGA6IuKAkyJ9PC9zdHJvbmc+PHNtYWxsPiR7c3RhdHMubW9udGhzP2Ake2VzY2FwZUh0bWwoc3ViKX0gwrcgJHtudW0oc3RhdHMua1doLDApfSBrV2gke051bWJlci5pc0Zpbml0ZShzdGF0cy5lZmZlY3RpdmVDdCk/YCDCtyBpbmtsLiBGaXhrb3N0ZW4gJHtudW0oc3RhdHMuZWZmZWN0aXZlQ3QsMil9IGN0L2tXaGA6IiJ9YDoia2VpbmUgT3N0cm9tLURhdGVuIn08L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCcnKTsKICAgIGNvbnN0IG1vbnRoTWFwPW5ldyBNYXAoaXRlbXMubWFwKGl0ZW09PltOdW1iZXIoaXRlbS5tb250aC5zbGljZSg1LDcpKSxpdGVtXSkpOwogICAgJCgnb3N0cm9tUHJpY2VTdGF0c1RhYmxlJykuaW5uZXJIVE1MPUFycmF5LmZyb20oe2xlbmd0aDoxMn0sKF8saSk9PmkrMSkubWFwKG09PnsKICAgICAgY29uc3QgaXRlbT1tb250aE1hcC5nZXQobSk7aWYoIWl0ZW0pcmV0dXJuIGA8dHI+PHRkPiR7TU9OVEhTW20tMV19PC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48L3RyPmA7CiAgICAgIGNvbnN0IGVmZmVjdGl2ZT1OdW1iZXIoaXRlbS50b3RhbEtXaCk+MCYmTnVtYmVyLmlzRmluaXRlKGl0ZW0udG90YWxDb3N0RXVyKT9OdW1iZXIoaXRlbS50b3RhbENvc3RFdXIpL051bWJlcihpdGVtLnRvdGFsS1doKSoxMDA6bnVsbDsKICAgICAgY29uc3QgcnVubmluZz1pdGVtLnBhcnRpYWx8fGl0ZW0ubW9udGg9PT1jdXJyZW50TW9udGhLZXkoKTsKICAgICAgcmV0dXJuIGA8dHI+PHRkPiR7TU9OVEhTW20tMV19JHtydW5uaW5nPycgPHNtYWxsIGNsYXNzPSJwcmljZS1ydW5uaW5nIj5sYXVmZW5kPC9zbWFsbD4nOicnfTwvdGQ+PHRkPiR7bnVtKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gsMil9IGN0PC90ZD48dGQ+JHtOdW1iZXIuaXNGaW5pdGUoZWZmZWN0aXZlKT9gJHtudW0oZWZmZWN0aXZlLDIpfSBjdGA6IuKAkyJ9PC90ZD48dGQ+JHtudW0oaXRlbS50b3RhbEtXaCwxKX0ga1doPC90ZD48dGQ+JHtpdGVtLmNvbXBsZXRlPydPc3Ryb20gZXhha3QnOid1bnZvbGxzdMOkbmRpZyd9PC90ZD48L3RyPmA7CiAgICB9KS5qb2luKCcnKTsKICAgIGNvbnN0IGxhc3Q9aXRlbXMubWFwKGl0ZW09PkRhdGUucGFyc2UoaXRlbS51cGRhdGVkQXR8fCcnKSkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkuc29ydCgoYSxiKT0+Yi1hKVswXTsKICAgICQoJ29zdHJvbVByaWNlU3RhdHNTdGF0dXMnKS50ZXh0Q29udGVudD1vc3Ryb21QcmljZVN0YXRzQnVzeT8nT3N0cm9tLVByZWlzZSB3ZXJkZW4gZ2VsYWRlbiDigKYnOml0ZW1zLmxlbmd0aD9gJHtpdGVtcy5sZW5ndGh9IE1vbmF0KGUpIHZlcmbDvGdiYXIke2xhc3Q/YCDCtyB6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUobGFzdCl9YDonJ30gwrcgUXVhcnRhbC9KYWhyIHZlcmJyYXVjaHNnZXdpY2h0ZXRgOnNldHRpbmdzLm9zdHJvbUFwcEtleT8nTm9jaCBrZWluZSBQcmVpc3N0YXRpc3RpayBmw7xyIGRpZXNlcyBKYWhyIGdlbGFkZW4uJzonTm9jaCBrZWluZSBQcmVpc3N0YXRpc3RpayBzeW5jaHJvbmlzaWVydC4gQXVmIGVpbmVtIHZlcmJ1bmRlbmVuIEdlcsOkdCBtaXQgT3N0cm9tLVNjaGzDvHNzZWwgYWt0dWFsaXNpZXJlbi4nOwogICAgJCgncmVmcmVzaE9zdHJvbVByaWNlU3RhdHNCdG4nKS5kaXNhYmxlZD1vc3Ryb21QcmljZVN0YXRzQnVzeXx8IXNldHRpbmdzLm9zdHJvbUFwcEtleTsKICAgIGRyYXdPc3Ryb21BdmVyYWdlUHJpY2VDaGFydCh5ZWFyLGl0ZW1zKTsKICB9CiAgZnVuY3Rpb24gZHJhd09zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0KHllYXIsaXRlbXM9b3N0cm9tU3RhdHNGb3JZZWFyKHllYXIpKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgnb3N0cm9tQXZlcmFnZVByaWNlQ2hhcnQnKSk7aWYoIWMpcmV0dXJuO2NvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOwogICAgY29uc3QgdmFscz1pdGVtcy5tYXAoaXRlbT0+TnVtYmVyKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTtpZighdmFscy5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LCdLZWluZSBPc3Ryb20tUHJlaXNkYXRlbicpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4udmFscykqMS4xNXx8MTsKICAgIGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKGl0ZW1zLm1hcChpdGVtPT5bTnVtYmVyKGl0ZW0ubW9udGguc2xpY2UoNSw3KSktMSxpdGVtXSkpO2N0eC5zdHJva2VTdHlsZT1DT0xPUlMuY29zdDtjdHgubGluZVdpZHRoPTIuODtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7CiAgICBmb3IobGV0IG09MDttPDEyO20rKyl7Y29uc3QgaXRlbT1tYXAuZ2V0KG0pO2lmKCFpdGVtfHwhTnVtYmVyLmlzRmluaXRlKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLWl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fWN0eC5zdHJva2UoKTsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLmNvc3Q7Zm9yKGxldCBtPTA7bTwxMjttKyspe2NvbnN0IGl0ZW09bWFwLmdldChtKTtpZighaXRlbXx8IU51bWJlci5pc0Zpbml0ZShpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSljb250aW51ZTtjb25zdCB4PWZyYW1lLmxlZnQrZnJhbWUucGxvdFcqbS8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1pdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doL21heCk7Y3R4LmJlZ2luUGF0aCgpO2N0eC5hcmMoeCx5LDMuMiwwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5mb250PScxMHB4IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LFNlZ29lIFVJLHNhbnMtc2VyaWYnO2N0eC5maWxsVGV4dChudW0oaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCwxKSx4LTEwLE1hdGgubWF4KDEwLHktOCkpO2N0eC5maWxsU3R5bGU9Q09MT1JTLmNvc3Q7fQogIH0KICBhc3luYyBmdW5jdGlvbiByZWZyZXNoT3N0cm9tUHJpY2VTdGF0cyh5ZWFyLHtzaWxlbnQ9ZmFsc2V9PXt9KXsKICAgIGlmKG9zdHJvbVByaWNlU3RhdHNCdXN5KXJldHVybiBmYWxzZTtpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtpZighc2lsZW50KXRvYXN0KCdPc3Ryb20genVlcnN0IHZlcmJpbmRlbicpO3JldHVybiBmYWxzZTt9CiAgICBjb25zdCB5PU51bWJlcih5ZWFyKTtpZighTnVtYmVyLmlzSW50ZWdlcih5KXx8eTwyMDIwfHx5Pm5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSl7aWYoIXNpbGVudCl0b2FzdCgnVW5nw7xsdGlnZXMgSmFocicpO3JldHVybiBmYWxzZTt9CiAgICBjb25zdCBub3c9bmV3IERhdGUoKSxsYXN0TW9udGg9eT09PW5vdy5nZXRGdWxsWWVhcigpP25vdy5nZXRNb250aCgpKzE6MTI7b3N0cm9tUHJpY2VTdGF0c0J1c3k9dHJ1ZTtyZW5kZXJPc3Ryb21QcmljZVN0YXRzKHkpOwogICAgbGV0IHVwZGF0ZWQ9MCx1bmF2YWlsYWJsZT0wO2NvbnN0IHJlY29yZE1hcD1uZXcgTWFwKHJlY29yZHMubWFwKHI9PltyLm1vbnRoLHsuLi5yfV0pKTsKICAgIHRyeXsKICAgICAgZm9yKGxldCBtPTE7bTw9bGFzdE1vbnRoO20rKyl7CiAgICAgICAgY29uc3QgbW9udGg9YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwnMCcpfWA7aWYoIXNpbGVudCkkKCdvc3Ryb21QcmljZVN0YXRzU3RhdHVzJykudGV4dENvbnRlbnQ9YCR7bW9udGhMYWJlbChtb250aCxmYWxzZSl9IHdpcmQgdm9uIE9zdHJvbSBnZWxhZGVuIOKApiAoJHttfS8ke2xhc3RNb250aH0pYDsKICAgICAgICB0cnl7CiAgICAgICAgICBjb25zdCBkYXRhPWF3YWl0IG9zdHJvbUZldGNoKGAvYXBpL21vbnRoP21vbnRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KG1vbnRoKX1gKTsKICAgICAgICAgIGlmKCFkYXRhPy5jb21wbGV0ZXx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLnRvdGFsS1doKSl8fE51bWJlcihkYXRhLnRvdGFsS1doKTw9MHx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS52YXJpYWJsZUNvc3RFdXIpKSl7dW5hdmFpbGFibGUrKztjb250aW51ZTt9CiAgICAgICAgICBjb25zdCBwYXJ0aWFsPW1vbnRoPT09Y3VycmVudE1vbnRoS2V5KCk7dXBzZXJ0T3N0cm9tUHJpY2VTdGF0KG1vbnRoLGRhdGEse3BhcnRpYWx9KTt1cGRhdGVkKys7CiAgICAgICAgICBpZighcGFydGlhbCYmcmVjb3JkTWFwLmhhcyhtb250aCkpe2NvbnN0IGl0ZW09cmVjb3JkTWFwLmdldChtb250aCksc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO2l0ZW0ucHJpY2VDdD1OdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCk7aXRlbS5iYXNlRmVlPU51bWJlcihkYXRhLmZpeGVkQ29zdEV1cil8fDA7aXRlbS5vc3Ryb21WYXJpYWJsZUNvc3RFdXI9TnVtYmVyKGRhdGEudmFyaWFibGVDb3N0RXVyKTtpdGVtLm9zdHJvbVRvdGFsQ29zdEV1cj1OdW1iZXIoZGF0YS50b3RhbENvc3RFdXIpO2l0ZW0ub3N0cm9tQ29uc3VtcHRpb25LV2g9TnVtYmVyKGRhdGEudG90YWxLV2gpO2l0ZW0ub3N0cm9tUHJpY2VDb21wbGV0ZT10cnVlO2l0ZW0ucHJpY2VTb3VyY2U9J29zdHJvbS1ob3VybHktY29uc3VtcHRpb24td2VpZ2h0ZWQnO2l0ZW0ucHJpY2VVcGRhdGVkQXQ9c3RhbXA7aXRlbS51cGRhdGVkQXQ9c3RhbXA7cmVjb3JkTWFwLnNldChtb250aCxpdGVtKTt9CiAgICAgICAgfWNhdGNoe3VuYXZhaWxhYmxlKys7fQogICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmU9PnNldFRpbWVvdXQocmVzb2x2ZSwxNDApKTsKICAgICAgfQogICAgICBpZih1cGRhdGVkKXNhdmVSZWNvcmRzKFsuLi5yZWNvcmRNYXAudmFsdWVzKCldLHtyZWFzb246YE9zdHJvbS1QcmVpc3N0YXRpc3RpayAke3l9IGFrdHVhbGlzaWVydGB9KTsKICAgICAgcmVuZGVyQWxsKCk7aWYoIXNpbGVudCl0b2FzdChgJHt1cGRhdGVkfSBPc3Ryb20tTW9uYXQoZSkgZsO8ciAke3l9IGFrdHVhbGlzaWVydCR7dW5hdmFpbGFibGU/YCDCtyAke3VuYXZhaWxhYmxlfSBuaWNodCB2ZXJmw7xnYmFyYDonJ31gKTtyZXR1cm4gdXBkYXRlZD4wOwogICAgfWZpbmFsbHl7b3N0cm9tUHJpY2VTdGF0c0J1c3k9ZmFsc2U7cmVuZGVyT3N0cm9tUHJpY2VTdGF0cyh5KTt9CiAgfQogIGZ1bmN0aW9uIGFubnVhbFN1bXMocm93cyl7CiAgICByZXR1cm4gcm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKWEudG90YWwrPXIudG90YWw7IGlmKE51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSlhLmhlYXQrPXIuaGVhdFB1bXA7IGlmKE51bWJlci5pc0Zpbml0ZShyLmFubmV4KSlhLmFubmV4Kz1yLmFubmV4OyBjb25zdCByZXN0PWRlcml2ZWQocik7IGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdD49MClhLnJlc3QrPXJlc3Q7IGNvbnN0IGNvc3Q9cmVjb3JkQ29zdChyKTsgaWYoTnVtYmVyLmlzRmluaXRlKGNvc3QpKWEuY29zdCs9Y29zdDsgaWYoTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKWEuY291bnQrKzsgcmV0dXJuIGE7IH0se3RvdGFsOjAsaGVhdDowLGFubmV4OjAscmVzdDowLGNvc3Q6MCxjb3VudDowfSk7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckFuYWx5c2lzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3QgeWVhclNlbGVjdD0kKCJhbmFseXNpc1llYXIiKTsKICAgIGNvbnN0IHByaW9yPU51bWJlcih5ZWFyU2VsZWN0LnZhbHVlKTsKICAgIGNvbnN0IHNlbGVjdGVkPXlzLmluY2x1ZGVzKHByaW9yKT9wcmlvcjooeXNbMF18fG5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSk7CiAgICB5ZWFyU2VsZWN0LmlubmVySFRNTD0oeXMubGVuZ3RoP3lzOltuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCldKS5tYXAoeT0+YDxvcHRpb24gdmFsdWU9IiR7eX0iPiR7eX08L29wdGlvbj5gKS5qb2luKCIiKTsKICAgIHllYXJTZWxlY3QudmFsdWU9U3RyaW5nKHNlbGVjdGVkKTsKICAgIGNvbnN0IHJvd3M9YW5hbHlzaXNZZWFyUm93cyhzZWxlY3RlZCksIHN1bXM9YW5udWFsU3Vtcyhyb3dzKTsKICAgIGNvbnN0IHByZXZpb3VzWWVhcj15cy5maWx0ZXIoeT0+eTxzZWxlY3RlZCkuc29ydCgoYSxiKT0+Yi1hKVswXXx8bnVsbDsKICAgIGNvbnN0IHByZXZpb3VzUm93cz1wcmV2aW91c1llYXI/YW5hbHlzaXNZZWFyUm93cyhwcmV2aW91c1llYXIpOltdOwogICAgY29uc3QgcHJldmlvdXM9YW5udWFsU3VtcyhwcmV2aW91c1Jvd3MpOwogICAgY29uc3QgdG90YWxEZWx0YT1wcmV2aW91cy5jb3VudCYmcHJldmlvdXMudG90YWw/KChzdW1zLnRvdGFsLXByZXZpb3VzLnRvdGFsKS9wcmV2aW91cy50b3RhbCoxMDApOm51bGw7CiAgICBjb25zdCBjb3BSb3dzPXJvd3MubWFwKHJlY29yZENvcCkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7CiAgICBjb25zdCBhbm51YWxDb3A9cm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApJiZOdW1iZXIuaXNGaW5pdGUoci5oZWF0R2VuZXJhdGVkKSl7YS5lKz1yLmhlYXRQdW1wO2EuaCs9ci5oZWF0R2VuZXJhdGVkO30gcmV0dXJuIGE7fSx7ZTowLGg6MH0pOwogICAgY29uc3QgZXhhY3RQcmljZU1vbnRocz1yb3dzLmZpbHRlcihyPT5yLm9zdHJvbVByaWNlQ29tcGxldGUmJk51bWJlci5pc0Zpbml0ZShyLm9zdHJvbVRvdGFsQ29zdEV1cikpLmxlbmd0aDsKICAgIGNvbnN0IG1ldHJpY3M9WwogICAgICBbIkdlc2FtdCIsYCR7bnVtKHN1bXMudG90YWwsMCl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKHRvdGFsRGVsdGEpP2Ake3BjdCh0b3RhbERlbHRhKX0genUgJHtwcmV2aW91c1llYXJ9YDpgJHtzdW1zLmNvdW50fSBNb25hdGVgXSwKICAgICAgWyJXw6RybWVwdW1wZSIsYCR7bnVtKHN1bXMuaGVhdCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLmhlYXQvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJBbHRlbnRlaWwiLGAke251bShzdW1zLmFubmV4LDApfSBrV2hgLHN1bXMudG90YWw/YCR7bnVtKHN1bXMuYW5uZXgvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJTY2hsZWUvS2x1cyIsYCR7bnVtKHN1bXMucmVzdCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLnJlc3Qvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJLb3N0ZW4iLGV1cm8oc3Vtcy5jb3N0KSxleGFjdFByaWNlTW9udGhzP2Ake2V4YWN0UHJpY2VNb250aHN9IE1vbmF0KGUpIG1pdCBPc3Ryb20tU3R1bmRlbnByZWlzZW5gOmFubnVhbENvcC5lPjA/YFdQLUFyYmVpdHN6YWhsICR7bnVtKGFubnVhbENvcC5oL2FubnVhbENvcC5lLDIpfWA6IkZhbGxiYWNrLVByZWlzZSJdCiAgICBdOwogICAgJCgiYW5hbHlzaXNNZXRyaWNzIikuaW5uZXJIVE1MPW1ldHJpY3MubWFwKChbbCx2LHNdKT0+YDxhcnRpY2xlPjxzcGFuPiR7bH08L3NwYW4+PHN0cm9uZz4ke3Z9PC9zdHJvbmc+PHNtYWxsPiR7c308L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCIiKTsKICAgICQoImFuYWx5c2lzVGFibGUiKS5pbm5lckhUTUw9cm93cy5sZW5ndGg/cm93cy5tYXAocj0+YDx0cj48dGQ+JHtlc2NhcGVIdG1sKG1vbnRoTGFiZWwoci5tb250aCxmYWxzZSkpfTwvdGQ+PHRkPiR7bnVtKHIudG90YWwsMSl9PC90ZD48dGQ+JHtudW0oci5oZWF0UHVtcCwxKX08L3RkPjx0ZD4ke251bShyLmFubmV4LDEpfTwvdGQ+PHRkPiR7bnVtKGRlcml2ZWQociksMSl9PC90ZD48dGQ+JHtldXJvKHJlY29yZENvc3QocikpfSR7ci5vc3Ryb21QcmljZUNvbXBsZXRlPyIgKiI6IiJ9PC90ZD48L3RyPmApLmpvaW4oIiIpOic8dHI+PHRkIGNvbHNwYW49IjYiPktlaW5lIE1vbmF0c2RhdGVuIGbDvHIgZGllc2VzIEphaHIuPC90ZD48L3RyPic7CiAgICAkKCJjb3BQYW5lbCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIWNvcFJvd3MubGVuZ3RoKTsKICAgIHJlbmRlck9zdHJvbVByaWNlU3RhdHMoc2VsZWN0ZWQpOwogICAgcmVuZGVyQ2xpbWF0ZUFuYWx5c2lzKCk7CiAgICBkcmF3QWxsb2NhdGlvbkNoYXJ0KHJvd3MpOyBkcmF3VG90YWxDaGFydEFsbFllYXJzKHlzKTsgZHJhd0Nvc3RDaGFydChyb3dzKTsgaWYoY29wUm93cy5sZW5ndGgpZHJhd0NvcENoYXJ0KHJvd3MpOwogIH0KCiAgZnVuY3Rpb24gY2FudmFzU2V0dXAoY2FudmFzKXsKICAgIGlmKCFjYW52YXMpcmV0dXJuIG51bGw7CiAgICBjb25zdCByZWN0PWNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsgY29uc3QgZHByPU1hdGgubWluKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvfHwxLDIpOyBjb25zdCB3aWR0aD1NYXRoLm1heCgyODAsTWF0aC5yb3VuZChyZWN0LndpZHRofHw2MDApKTsgY29uc3QgaGVpZ2h0PU1hdGgubWF4KDE4MCxNYXRoLnJvdW5kKHJlY3QuaGVpZ2h0fHwyNjApKTsKICAgIGNhbnZhcy53aWR0aD1NYXRoLnJvdW5kKHdpZHRoKmRwcik7IGNhbnZhcy5oZWlnaHQ9TWF0aC5yb3VuZChoZWlnaHQqZHByKTsgY29uc3QgY3R4PWNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOyBjdHguc2V0VHJhbnNmb3JtKGRwciwwLDAsZHByLDAsMCk7IGN0eC5jbGVhclJlY3QoMCwwLHdpZHRoLGhlaWdodCk7IHJldHVybiB7Y3R4LHdpZHRoLGhlaWdodH07CiAgfQogIGZ1bmN0aW9uIGRyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LHRleHQ9IktlaW5lIERhdGVuIil7CiAgICBjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0OyBjdHguZm9udD0iMTNweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjsgY3R4LnRleHRBbGlnbj0iY2VudGVyIjsgY3R4LmZpbGxUZXh0KHRleHQsd2lkdGgvMixoZWlnaHQvMik7IGN0eC50ZXh0QWxpZ249ImxlZnQiOwogIH0KICBmdW5jdGlvbiBjaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LGxhYmVscyx7bGVmdD00OCxib3R0b209MzQsdG9wPTE1LHJpZ2h0PTEyfT17fSl7CiAgICBjb25zdCBwbG90Vz13aWR0aC1sZWZ0LXJpZ2h0LCBwbG90SD1oZWlnaHQtdG9wLWJvdHRvbTsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuZ3JpZDsgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDsgY3R4LmZvbnQ9IjEwcHggLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsU2Vnb2UgVUksc2Fucy1zZXJpZiI7IGN0eC5saW5lV2lkdGg9MTsKICAgIGZvcihsZXQgaT0wO2k8PTQ7aSsrKXsgY29uc3QgeT10b3ArcGxvdEgqaS80OyBjdHguYmVnaW5QYXRoKCk7Y3R4Lm1vdmVUbyhsZWZ0LHkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseSk7Y3R4LnN0cm9rZSgpOyBjb25zdCB2YWw9bWF4KigxLWkvNCk7Y3R4LmZpbGxUZXh0KG51bSh2YWwsMCksNCx5KzMpOyB9CiAgICBpZihsYWJlbHM/Lmxlbmd0aCl7IGxhYmVscy5mb3JFYWNoKChsYWJlbCxpKT0+eyBjb25zdCB4PWxlZnQrKGxhYmVscy5sZW5ndGg9PT0xP3Bsb3RXLzI6cGxvdFcqaS8obGFiZWxzLmxlbmd0aC0xKSk7IGN0eC5maWxsVGV4dChsYWJlbCx4LTEwLGhlaWdodC0xMCk7IH0pOyB9CiAgICByZXR1cm4ge2xlZnQscmlnaHQsdG9wLGJvdHRvbSxwbG90VyxwbG90SH07CiAgfQogIGZ1bmN0aW9uIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCByb3dzPXNvcnRlZCgpLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpLnNsaWNlKC0xMik7IGlmKCFyb3dzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4ucm93cy5tYXAocj0+ci50b3RhbCkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgscm93cy5tYXAocj0+TU9OVEhTW051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTFdKSx7fSk7CiAgICBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLnRvdGFsO2N0eC5saW5lV2lkdGg9Mi41O2N0eC5iZWdpblBhdGgoKTtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PWZyYW1lLmxlZnQrKHJvd3MubGVuZ3RoPT09MT9mcmFtZS5wbG90Vy8yOmZyYW1lLnBsb3RXKmkvKHJvd3MubGVuZ3RoLTEpKTtjb25zdCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1yLnRvdGFsL21heCk7aT9jdHgubGluZVRvKHgseSk6Y3R4Lm1vdmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLnRvdGFsO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9ZnJhbWUubGVmdCsocm93cy5sZW5ndGg9PT0xP2ZyYW1lLnBsb3RXLzI6ZnJhbWUucGxvdFcqaS8ocm93cy5sZW5ndGgtMSkpO2NvbnN0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXIudG90YWwvbWF4KTtjdHguYmVnaW5QYXRoKCk7Y3R4LmFyYyh4LHksMywwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0FsbG9jYXRpb25DaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiYWxsb2NhdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxpZD1yb3dzLmZpbHRlcihyPT5bci5oZWF0UHVtcCxyLmFubmV4LHIudG90YWxdLnNvbWUoTnVtYmVyLmlzRmluaXRlKSk7IGlmKCF2YWxpZC5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbGlkLm1hcChyPT5NYXRoLm1heCgwLE51bWJlcihyLnRvdGFsKXx8KChOdW1iZXIoci5oZWF0UHVtcCl8fDApKyhOdW1iZXIoci5hbm5leCl8fDApKyhNYXRoLm1heCgwLGRlcml2ZWQocikpfHwwKSkpKSkqMS4xfHwxOyBjb25zdCBsYWJlbHM9dmFsaWQubWFwKHI9Pk1PTlRIU1tOdW1iZXIoci5tb250aC5zbGljZSg1LDcpKS0xXSk7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsbGFiZWxzLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy92YWxpZC5sZW5ndGgsIGJhclc9TWF0aC5taW4oMzgsc2xvdCouNjIpOwogICAgdmFsaWQuZm9yRWFjaCgocixpKT0+eyBjb25zdCB4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzI7IGxldCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SDsgY29uc3QgcGFydHM9W1tNYXRoLm1heCgwLE51bWJlcihyLmhlYXRQdW1wKXx8MCksQ09MT1JTLmhlYXRdLFtNYXRoLm1heCgwLE51bWJlcihyLmFubmV4KXx8MCksQ09MT1JTLmFubmV4XSxbTWF0aC5tYXgoMCxkZXJpdmVkKHIpfHwwKSxDT0xPUlMucmVzdF1dOyBmb3IoY29uc3QgW3YsY29sb3JdIG9mIHBhcnRzKXtjb25zdCBoPWZyYW1lLnBsb3RIKnYvbWF4O3ktPWg7Y3R4LmZpbGxTdHlsZT1jb2xvcjtjdHguZmlsbFJlY3QoeCx5LGJhclcsaCk7fSB9KTsKICB9CiAgZnVuY3Rpb24geWVhckNvbG9yKHllYXIseWVhcnNBc2MpewogICAgY29uc3QgaW5kZXg9TWF0aC5tYXgoMCx5ZWFyc0FzYy5pbmRleE9mKHllYXIpKTsKICAgIHJldHVybiBZRUFSX0NPTE9SU1tpbmRleCVZRUFSX0NPTE9SUy5sZW5ndGhdOwogIH0KICBmdW5jdGlvbiBkcmF3VG90YWxDaGFydEFsbFllYXJzKHllYXJMaXN0KXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgidG90YWxDaGFydCIpKTsgaWYoIWMpcmV0dXJuOwogICAgY29uc3QgeWVhcnNBc2M9Wy4uLnllYXJMaXN0XS5zb3J0KChhLGIpPT5hLWIpOwogICAgY29uc3Qgc2VyaWVzPXllYXJzQXNjLm1hcCh5ZWFyPT4oe3llYXIscm93czphbmFseXNpc1llYXJSb3dzKHllYXIpfSkpLmZpbHRlcihzPT5zLnJvd3Muc29tZShyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpKTsKICAgIGNvbnN0IHZhbHM9c2VyaWVzLmZsYXRNYXAocz0+cy5yb3dzKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKTsKICAgIGlmKCF2YWxzLmxlbmd0aCl7ZHJhd0VtcHR5KGMuY3R4LGMud2lkdGgsYy5oZWlnaHQpOyQoInllYXJDb21wYXJpc29uTGVnZW5kIikuaW5uZXJIVE1MPSIiO3JldHVybjt9CiAgICBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMubWFwKHI9PnIudG90YWwpKSoxLjEyfHwxOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7CiAgICBjb25zdCBjdXJyZW50WWVhcj1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk7CiAgICAkKCJ5ZWFyQ29tcGFyaXNvbkxlZ2VuZCIpLmlubmVySFRNTD1zZXJpZXMubWFwKGl0ZW09Pntjb25zdCBjb2xvcj15ZWFyQ29sb3IoaXRlbS55ZWFyLHllYXJzQXNjKTtjb25zdCBwYXN0PWl0ZW0ueWVhciE9PWN1cnJlbnRZZWFyO3JldHVybiBgPHNwYW4gY2xhc3M9IiR7cGFzdD8icGFzdCI6ImN1cnJlbnQifSIgc3R5bGU9ImNvbG9yOiR7Y29sb3J9Ij48aT48L2k+JHtpdGVtLnllYXJ9JHtwYXN0PyIiOiIgwrcgYWt0dWVsbCJ9PC9zcGFuPmA7fSkuam9pbigiIik7CiAgICBmb3IoY29uc3QgaXRlbSBvZiBzZXJpZXMpewogICAgICBjb25zdCBjb2xvcj15ZWFyQ29sb3IoaXRlbS55ZWFyLHllYXJzQXNjKSxkYXNoZWQ9aXRlbS55ZWFyIT09Y3VycmVudFllYXI7CiAgICAgIGNvbnN0IG1hcD1uZXcgTWFwKGl0ZW0ucm93cy5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKS5tYXAocj0+W051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTEsci50b3RhbF0pKTsKICAgICAgY3R4LnN0cm9rZVN0eWxlPWNvbG9yO2N0eC5saW5lV2lkdGg9ZGFzaGVkPzIuMjozO2N0eC5zZXRMaW5lRGFzaChkYXNoZWQ/WzcsNV06W10pO2N0eC5iZWdpblBhdGgoKTtsZXQgc3RhcnRlZD1mYWxzZTsKICAgICAgZm9yKGxldCBtPTA7bTwxMjttKyspe2lmKCFtYXAuaGFzKG0pKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLW1hcC5nZXQobSkvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fQogICAgICBjdHguc3Ryb2tlKCk7Y3R4LnNldExpbmVEYXNoKFtdKTsKICAgICAgY3R4LmZpbGxTdHlsZT1jb2xvcjtmb3IobGV0IG09MDttPDEyO20rKyl7aWYoIW1hcC5oYXMobSkpY29udGludWU7Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKm0vMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtbWFwLmdldChtKS9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSxkYXNoZWQ/Mi4yOjMuMiwwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBkcmF3Q29zdENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3N0Q2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbHM9cm93cy5tYXAocj0+cmVjb3JkQ29zdChyKSk7IGlmKCF2YWxzLnNvbWUoTnVtYmVyLmlzRmluaXRlKSl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsIktlaW5lIEtvc3RlbmRhdGVuIik7cmV0dXJuO30gY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy8xMixiYXJXPU1hdGgubWluKDM4LHNsb3QqLjYyKTsgdmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgaD1mcmFtZS5wbG90SCp2L21heCx4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzIseT1mcmFtZS50b3ArZnJhbWUucGxvdEgtaDtjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O2N0eC5maWxsUmVjdCh4LHksYmFyVyxoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0NvcENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3BDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgdmFscz1yb3dzLm1hcChyZWNvcmRDb3ApOyBpZighdmFscy5zb21lKE51bWJlci5pc0Zpbml0ZSkpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fSBjb25zdCBtYXg9TWF0aC5tYXgoNSwuLi52YWxzLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKSoxLjA1OyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7IGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuaGVhdDtjdHgubGluZVdpZHRoPTIuNDtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7dmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKmkvMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtdi9tYXgpO2lmKCFzdGFydGVkKXtjdHgubW92ZVRvKHgseSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRlclBhbmVsKCl7CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighbGF0ZXN0KXJldHVybjsKICAgICQoIm1ldGVyTGF0ZXN0IikuaW5uZXJIVE1MPWA8YXJ0aWNsZT48c3Bhbj5TdGFuZCB2b208L3NwYW4+PHN0cm9uZz4ke2RhdGVMYWJlbChsYXRlc3QuZGF0ZSl9PC9zdHJvbmc+PHNtYWxsPmxldHp0ZSBBYmxlc3VuZzwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkdlc2FtdDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC50b3RhbCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkFsdGVudGVpbDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC5hbm5leCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPmA7CiAgICAkKCJtZXRlckhpc3RvcnkiKS5pbm5lckhUTUw9bWV0ZXJSZWFkaW5ncy5zbGljZSgpLnJldmVyc2UoKS5zbGljZSgwLDgpLm1hcCgocixpKT0+YDxkaXYgY2xhc3M9Im1ldGVyLWhpc3Rvcnktcm93Ij48c3Bhbj4ke2RhdGVMYWJlbChyLmRhdGUpfTwvc3Bhbj48c3Ryb25nPkdlc2FtdCAke251bShyLnRvdGFsLDApfTwvc3Ryb25nPjxzdHJvbmc+QWx0ZW50ZWlsICR7bnVtKHIuYW5uZXgsMCl9PC9zdHJvbmc+JHtpPT09bWV0ZXJSZWFkaW5ncy5sZW5ndGgtMT8nPHNtYWxsPlN0YXJ0d2VydDwvc21hbGw+JzonJ308L2Rpdj5gKS5qb2luKCIiKTsKICAgICQoInVuZG9MYXRlc3RNZXRlckJ0biIpLmRpc2FibGVkPW1ldGVyUmVhZGluZ3MubGVuZ3RoPD0xOwogIH0KICBmdW5jdGlvbiByZW5kZXJEYXRhKCl7CiAgICBjb25zdCBpc3N1ZXM9W107IGxldCBjb21wbGV0ZUNvdW50PTA7CiAgICBmb3IoY29uc3QgciBvZiByZWNvcmRzKXsKICAgICAgY29uc3QgbWlzc2luZz1bXTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSltaXNzaW5nLnB1c2goIkdlc2FtdCIpOyBpZighTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApKW1pc3NpbmcucHVzaCgiV8Okcm1lcHVtcGUiKTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLmFubmV4KSltaXNzaW5nLnB1c2goIkFsdGVudGVpbCIpOyBjb25zdCByZXN0PWRlcml2ZWQocik7CiAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwKWlzc3Vlcy5wdXNoKHtsZXZlbDoiZXJyb3IiLG1vbnRoOnIubW9udGgsdGl0bGU6IkF1ZnRlaWx1bmcgdW5wbGF1c2liZWwiLGRldGFpbDpgU2NobGVlL0tsdXMgZXJnaWJ0ICR7bnVtKHJlc3QsMSl9IGtXaC5gfSk7CiAgICAgIGVsc2UgaWYobWlzc2luZy5sZW5ndGgpaXNzdWVzLnB1c2goe2xldmVsOiJ3YXJuaW5nIixtb250aDpyLm1vbnRoLHRpdGxlOiJNb25hdCB1bnZvbGxzdMOkbmRpZyIsZGV0YWlsOmBGZWhsdDogJHttaXNzaW5nLmpvaW4oIiwgIil9YH0pOwogICAgICBlbHNlIGNvbXBsZXRlQ291bnQrKzsKICAgIH0KICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RSZWNvcmQoKTsKICAgIGNvbnN0IHE9WwogICAgICBbIk1vbmF0ZSIsU3RyaW5nKHJlY29yZHMubGVuZ3RoKSwiZ2VzcGVpY2hlcnQiXSwKICAgICAgWyJWb2xsc3TDpG5kaWciLFN0cmluZyhjb21wbGV0ZUNvdW50KSxyZWNvcmRzLmxlbmd0aD9gJHtudW0oY29tcGxldGVDb3VudC9yZWNvcmRzLmxlbmd0aCoxMDAsMCl9ICVgOiLigJMiXSwKICAgICAgWyJIaW53ZWlzZSIsU3RyaW5nKGlzc3Vlcy5sZW5ndGgpLGlzc3Vlcy5zb21lKGk9PmkubGV2ZWw9PT0iZXJyb3IiKT8ibWluZC4gMSBGZWhsZXIiOiJwcsO8ZmVuIl0sCiAgICAgIFsiTGV0enRlciBNb25hdCIsbGF0ZXN0P21vbnRoTGFiZWwobGF0ZXN0Lm1vbnRoLGZhbHNlKToi4oCTIiwiYXV0b21hdGlzY2ggYmVyZWNobmV0Il0KICAgIF07CiAgICAkKCJxdWFsaXR5TWV0cmljcyIpLmlubmVySFRNTD1xLm1hcCgoW2wsdixzXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2x9PC9zcGFuPjxzdHJvbmc+JHt2fTwvc3Ryb25nPjxzbWFsbD4ke3N9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbigiIik7CiAgICAkKCJxdWFsaXR5SXNzdWVzIikuaW5uZXJIVE1MPWlzc3Vlcy5sZW5ndGg/aXNzdWVzLnNsaWNlKCkucmV2ZXJzZSgpLnNsaWNlKDAsMTYpLm1hcChpPT5gPGFydGljbGUgY2xhc3M9Imlzc3VlICR7aS5sZXZlbH0iPjxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChpLm1vbnRoKSl9OiAke2VzY2FwZUh0bWwoaS50aXRsZSl9PC9zdHJvbmc+PHNtYWxsPiR7ZXNjYXBlSHRtbChpLmRldGFpbCl9PC9zbWFsbD48L2Rpdj48L2FydGljbGU+YCkuam9pbigiIik6JzxhcnRpY2xlIGNsYXNzPSJpc3N1ZSI+PGRpdj48c3Ryb25nPktlaW5lIEF1ZmbDpGxsaWdrZWl0ZW48L3N0cm9uZz48c21hbGw+QWxsZSBnZXNwZWljaGVydGVuIE1vbmF0ZSBzaW5kIHBsYXVzaWJlbCB1bmQgdm9sbHN0w6RuZGlnLjwvc21hbGw+PC9kaXY+PC9hcnRpY2xlPic7CiAgICByZW5kZXJNZXRlclBhbmVsKCk7CiAgICAkKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlPXNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiI7CiAgICAkKCJvc3Ryb21BdXRvUmVmcmVzaElucHV0IikuY2hlY2tlZD1zZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlOwogICAgJCgicHJlZmVycmVkV2luZG93SG91cnNJbnB1dCIpLnZhbHVlPVN0cmluZyhzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vyc3x8Myk7CiAgICAkKCJmYWxsYmFja1ByaWNlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMikudG9GaXhlZCgzKTsKICAgICQoImRlZmF1bHRCYXNlRmVlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApLnRvRml4ZWQoMik7CiAgICBjb25zdCBsYXN0QmFja3VwPWxvY2FsU3RvcmFnZS5nZXRJdGVtKExBU1RfQkFDS1VQX0tFWSk7ICQoImJhY2t1cFN0YXR1cyIpLnRleHRDb250ZW50PWxhc3RCYWNrdXA/YExldHp0ZXMgQmFja3VwOiAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2RhdGVTdHlsZToibWVkaXVtIix0aW1lU3R5bGU6InNob3J0In0pLmZvcm1hdChuZXcgRGF0ZShsYXN0QmFja3VwKSl9YDoiTm9jaCBrZWluIEJhY2t1cCBtaXQgRWxkZWhvZiA2LjIgZXJzdGVsbHQuIjsKICAgIGNvbnN0IGhpc3RvcnlTdGF0dXM9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShPU1RST01fSElTVE9SWV9LRVkpLG51bGwpOwogICAgaWYoJCgib3N0cm9tSGlzdG9yeVN0YXR1cyIpKSQoIm9zdHJvbUhpc3RvcnlTdGF0dXMiKS50ZXh0Q29udGVudD1vc3Ryb21IaXN0b3J5QnVzeT8iSGlzdG9yaXNjaGUgT3N0cm9tLVByZWlzZSB3ZXJkZW4gZ2VsYWRlbiDigKYiOmhpc3RvcnlTdGF0dXM/LnVwZGF0ZWRBdD9gUHJlaXNoaXN0b3JpZSB6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUoaGlzdG9yeVN0YXR1cy51cGRhdGVkQXQpfSDCtyAke2hpc3RvcnlTdGF0dXMudXBkYXRlZHx8MH0gTW9uYXQoZSkgZXhha3QgwrcgJHtoaXN0b3J5U3RhdHVzLnVuYXZhaWxhYmxlfHwwfSBuaWNodCB2ZXJmw7xnYmFyYDpgSGlzdG9yaXNjaGUgUHJlaXNlIG5vY2ggbmljaHQgZ2VwcsO8ZnQuYDsKICAgIHJlbmRlclN5bmNQYW5lbCgpOwogIH0KCiAgZnVuY3Rpb24gZG93bmxvYWRCbG9iKGNvbnRlbnQsZmlsZW5hbWUsdHlwZSl7IGNvbnN0IGJsb2I9bmV3IEJsb2IoW2NvbnRlbnRdLHt0eXBlfSk7IGNvbnN0IHVybD1VUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOyBjb25zdCBhPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImEiKTsgYS5ocmVmPXVybDthLmRvd25sb2FkPWZpbGVuYW1lO2RvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYSk7YS5jbGljaygpO2EucmVtb3ZlKCk7c2V0VGltZW91dCgoKT0+VVJMLnJldm9rZU9iamVjdFVSTCh1cmwpLDEwMDApOyB9CiAgZnVuY3Rpb24gZXhwb3J0QmFja3VwKCl7CiAgICBjb25zdCBub3c9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgY29uc3QgcmVsZXZhbnRTZXR0aW5ncz17ZmFsbGJhY2tQcmljZTpzZXR0aW5ncy5mYWxsYmFja1ByaWNlLGRlZmF1bHRCYXNlRmVlOnNldHRpbmdzLmRlZmF1bHRCYXNlRmVlLG9zdHJvbUFwcEtleTpzZXR0aW5ncy5vc3Ryb21BcHBLZXksb3N0cm9tQXV0b1JlZnJlc2g6c2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2gscHJlZmVycmVkV2luZG93SG91cnM6c2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnN9OwogICAgY29uc3QgcGF5bG9hZD17dmVyc2lvbjoiNi4zLjQiLGFwcDoiRWxkZWhvZiIscHVycG9zZToiUHJpdmF0ZXMgbG9rYWxlcyBCYWNrdXAg4oCTIG5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbiIsZXhwb3J0ZWRBdDpub3csc2V0dGluZ3M6cmVsZXZhbnRTZXR0aW5ncyxyZWNvcmRzLHZhaWxsYW50TW9udGhzLG1ldGVyUmVhZGluZ3Msb3N0cm9tUHJpY2VTdGF0cyxjbGltYXRlTW9udGhzLGNsaW1hdGVXZWF0aGVyfTsKICAgIGRvd25sb2FkQmxvYihKU09OLnN0cmluZ2lmeShwYXlsb2FkLG51bGwsMiksYEVsZGVob2ZfUFJJVkFURV9CYWNrdXBfJHtkYXRlU3RhbXAoKX0uanNvbmAsImFwcGxpY2F0aW9uL2pzb24iKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTEFTVF9CQUNLVVBfS0VZLG5vdyk7IHJlbmRlckRhdGEoKTsgdG9hc3QoIlByaXZhdGVzIEJhY2t1cCBlcnN0ZWxsdCIpOwogIH0KICBmdW5jdGlvbiBleHBvcnRDc3YoKXsKICAgIGNvbnN0IHJvd3M9W1siTW9uYXQiLCJXw6RybWVwdW1wZSBrV2giLCJFcnpldWd0ZSBXw6RybWUga1doIiwiQXJiZWl0c3phaGwiLCJBbHRlbnRlaWwga1doIiwiU2NobGVlL0tsdXMga1doIiwiR2VzYW10IGtXaCIsIkdlc2FtdC1aw6RobGVyc3RhbmQga1doIiwiQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2giLCJBYmxlc2VkYXR1bSIsIlByZWlzIGN0L2tXaCIsIkZpeGtvc3RlbiBFVVIiLCJLb3N0ZW4gRVVSIiwiUHJlaXNxdWVsbGUiLCJPc3Ryb20tVmVyYnJhdWNoIGtXaCIsIk5vdGl6Il1dOwogICAgZm9yKGNvbnN0IHIgb2Ygc29ydGVkKCkpcm93cy5wdXNoKFtyLm1vbnRoLHIuaGVhdFB1bXA/PyIiLHIuaGVhdEdlbmVyYXRlZD8/IiIscmVjb3JkQ29wKHIpPz8iIixyLmFubmV4Pz8iIixkZXJpdmVkKHIpPz8iIixyLnRvdGFsPz8iIixyLnRvdGFsTWV0ZXJSZWFkaW5nPz8iIixyLmFubmV4TWV0ZXJSZWFkaW5nPz8iIixyLm1ldGVyUmVhZGluZ0RhdGU/PyIiLHIucHJpY2VDdD8/IiIsci5iYXNlRmVlPz8iIixyZWNvcmRDb3N0KHIpPz8iIixyLnByaWNlU291cmNlfHwiIixyLm9zdHJvbUNvbnN1bXB0aW9uS1doPz8iIixyLm5vdGV8fCIiXSk7CiAgICBkb3dubG9hZEJsb2IoIlx1RkVGRiIrcm93cy5tYXAocm93PT5yb3cubWFwKGNzdkNlbGwpLmpvaW4oIjsiKSkuam9pbigiXG4iKSxgRWxkZWhvZl9WZXJicmF1Y2hfJHtkYXRlU3RhbXAoKX0uY3N2YCwidGV4dC9jc3Y7Y2hhcnNldD11dGYtOCIpOyB0b2FzdCgiQ1NWIGVyc3RlbGx0Iik7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhY2t1cChmaWxlKXsKICAgIHRyeXsKICAgICAgY29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKGF3YWl0IGZpbGUudGV4dCgpKTsgY29uc3QgaW5jb21pbmc9QXJyYXkuaXNBcnJheShwYXlsb2FkKT9wYXlsb2FkOihBcnJheS5pc0FycmF5KHBheWxvYWQucmVjb3Jkcyk/cGF5bG9hZC5yZWNvcmRzOnBheWxvYWQuZGF0YSk7IGlmKCFBcnJheS5pc0FycmF5KGluY29taW5nKSl0aHJvdyBuZXcgRXJyb3IoIktlaW5lIE1vbmF0c2RhdGVuIGdlZnVuZGVuLiIpOwogICAgICBjb25zdCBjbGVhbmVkPXNhbml0aXplUmVjb3JkcyhpbmNvbWluZyk7IGlmKCFjbGVhbmVkLmxlbmd0aCYmIWNvbmZpcm0oIkRhcyBCYWNrdXAgZW50aMOkbHQga2VpbmUgTW9uYXRzd2VydGUuIExlZXJlbiBCZXN0YW5kIHdpcmtsaWNoIGltcG9ydGllcmVuPyIpKXJldHVybjsKICAgICAgaWYoIWNvbmZpcm0oYCR7Y2xlYW5lZC5sZW5ndGh9IE1vbmF0c3dlcnRlIGF1cyBkZW0gQmFja3VwIMO8YmVybmVobWVuPyBEZXIgYWt0dWVsbGUgU3RhbmQgd2lyZCB2b3JoZXIgbG9rYWwgZ2VzaWNoZXJ0LmApKXJldHVybjsKICAgICAgY29uc3QgaW1wb3J0U3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgICBzYXZlUmVjb3JkcyhjbGVhbmVkLm1hcChyPT4oey4uLnIsdXBkYXRlZEF0OmltcG9ydFN0YW1wfSkpLHtyZWFzb246IkJhY2t1cCBpbXBvcnRpZXJ0IixhbGxvd0VtcHR5OnRydWV9KTsKICAgICAgaWYocGF5bG9hZC5zZXR0aW5ncyYmdHlwZW9mIHBheWxvYWQuc2V0dGluZ3M9PT0ib2JqZWN0Iil7CiAgICAgICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLnBheWxvYWQuc2V0dGluZ3N9OwogICAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5wcmljZSkpJiYhTnVtYmVyLmlzRmluaXRlKE51bWJlcihwYXlsb2FkLnNldHRpbmdzLmZhbGxiYWNrUHJpY2UpKSlzZXR0aW5ncy5mYWxsYmFja1ByaWNlPU51bWJlcihwYXlsb2FkLnNldHRpbmdzLnByaWNlKTsKICAgICAgICBzYXZlU2V0dGluZ3MoKTsKICAgICAgfQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQudmFpbGxhbnRNb250aHMpKXsgdmFpbGxhbnRNb250aHM9cGF5bG9hZC52YWlsbGFudE1vbnRocy5tYXAodj0+KHsuLi52LHVwZGF0ZWRBdDppbXBvcnRTdGFtcH0pKTsgc2F2ZVZhaWxsYW50TW9udGhzKCk7IH0KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLm1ldGVyUmVhZGluZ3MpKXtzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3MpO31lbHNle21ldGVyUmVhZGluZ3M9bG9hZE1ldGVyUmVhZGluZ3MoKTtlbnN1cmVNZXRlckJhc2VsaW5lKCk7fQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQub3N0cm9tUHJpY2VTdGF0cykpc2F2ZU9zdHJvbVByaWNlU3RhdHMocGF5bG9hZC5vc3Ryb21QcmljZVN0YXRzKTsKICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLmNsaW1hdGVNb250aHMpKXNhdmVDbGltYXRlTW9udGhzKHBheWxvYWQuY2xpbWF0ZU1vbnRocyk7CiAgICAgIGlmKHBheWxvYWQuY2xpbWF0ZVdlYXRoZXImJnR5cGVvZiBwYXlsb2FkLmNsaW1hdGVXZWF0aGVyPT09Im9iamVjdCImJiFBcnJheS5pc0FycmF5KHBheWxvYWQuY2xpbWF0ZVdlYXRoZXIpKXtjbGltYXRlV2VhdGhlcj1jbGltYXRlV2VhdGhlck9iamVjdChwYXlsb2FkLmNsaW1hdGVXZWF0aGVyKTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShDTElNQVRFX1dFQVRIRVJfS0VZLEpTT04uc3RyaW5naWZ5KGNsaW1hdGVXZWF0aGVyKSk7fQogICAgICByZW5kZXJBbGwoKTsgdG9hc3QoIkJhY2t1cCBpbXBvcnRpZXJ0Iik7CiAgICB9Y2F0Y2goZXJyb3IpeyBhbGVydChgQmFja3VwIGtvbm50ZSBuaWNodCBpbXBvcnRpZXJ0IHdlcmRlbjogJHtlcnJvci5tZXNzYWdlfWApOyB9CiAgICBmaW5hbGx5eyAkKCJpbXBvcnRCYWNrdXBJbnB1dCIpLnZhbHVlPSIiOyB9CiAgfQoKCiAgLyogRWxkZWhvZiA2LjAuMSDigJMgc2NobGFua2VyIGxva2FsZXIgbXlWQUlMTEFOVC1DU1YtSW1wb3J0ICovCiAgZnVuY3Rpb24gdmFpbGxhbnRDc3ZOdW1iZXIodmFsdWUpewogICAgY29uc3QgdGV4dD1TdHJpbmcodmFsdWU/PyIiKS50cmltKCk7CiAgICBpZighdGV4dClyZXR1cm4gbnVsbDsKICAgIGNvbnN0IG5vcm1hbGl6ZWQ9dGV4dC5pbmNsdWRlcygiLCIpJiZ0ZXh0LmluY2x1ZGVzKCIuIikKICAgICAgP3RleHQubGFzdEluZGV4T2YoIiwiKT50ZXh0Lmxhc3RJbmRleE9mKCIuIikKICAgICAgICA/dGV4dC5yZXBsYWNlKC9cLi9nLCIiKS5yZXBsYWNlKCIsIiwiLiIpCiAgICAgICAgOnRleHQucmVwbGFjZSgvLC9nLCIiKQogICAgICA6dGV4dC5yZXBsYWNlKCIsIiwiLiIpOwogICAgY29uc3QgbnVtYmVyPU51bWJlcihub3JtYWxpemVkKTsKICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobnVtYmVyKT9udW1iZXI6bnVsbDsKICB9CiAgZnVuY3Rpb24gdmFpbGxhbnRDc3ZEYXRlUGFydHModmFsdWUpewogICAgY29uc3QgbWF0Y2g9L14oXGR7NH0pLShcZHsyfSktKFxkezJ9KSg/OlsgVF0oXGR7Mn0pOihcZHsyfSk6KFxkezJ9KSk/JC8uZXhlYyhTdHJpbmcodmFsdWV8fCIiKS50cmltKCkpOwogICAgaWYoIW1hdGNoKXJldHVybiBudWxsOwogICAgY29uc3QgeWVhcj1OdW1iZXIobWF0Y2hbMV0pLG1vbnRoPU51bWJlcihtYXRjaFsyXSksZGF5PU51bWJlcihtYXRjaFszXSk7CiAgICBjb25zdCBkYXRlPW5ldyBEYXRlKERhdGUuVVRDKHllYXIsbW9udGgtMSxkYXkpKTsKICAgIGlmKGRhdGUuZ2V0VVRDRnVsbFllYXIoKSE9PXllYXJ8fGRhdGUuZ2V0VVRDTW9udGgoKSE9PW1vbnRoLTF8fGRhdGUuZ2V0VVRDRGF0ZSgpIT09ZGF5KXJldHVybiBudWxsOwogICAgcmV0dXJuIHt5ZWFyLG1vbnRoLGRheSxkYXRlS2V5OmAke21hdGNoWzFdfS0ke21hdGNoWzJdfS0ke21hdGNoWzNdfWAsbW9udGhLZXk6YCR7bWF0Y2hbMV19LSR7bWF0Y2hbMl19YCxkYXRlVGltZTpTdHJpbmcodmFsdWV8fCIiKS50cmltKCl9OwogIH0KICBmdW5jdGlvbiBkZXRlY3RWYWlsbGFudENzdlR5cGUoaGVhZGVycyl7CiAgICBjb25zdCBmaWVsZHM9bmV3IFNldChoZWFkZXJzKSxoYXM9bmFtZT0+ZmllbGRzLmhhcyhuYW1lKTsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikmJmhhcygiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikmJmhhcygiSGVhdEdlbmVyYXRlZDpEb21lc3RpY0hvdFdhdGVyIikpcmV0dXJuICJhcm90aGVybS1lbmVyZ3kiOwogICAgaWYoaGFzKCJEYXRlVGltZSIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikmJmhhcygiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikmJiFoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikpcmV0dXJuICJ1bml0b3dlci1lbmVyZ3kiOwogICAgaWYoaGFzKCJEYXRlVGltZSIpJiZoYXMoIk91dGRvb3JUZW1wZXJhdHVyZSIpKXJldHVybiAic3lzdGVtLXRlbXBlcmF0dXJlIjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDdXJyZW50Um9vbVRlbXBlcmF0dXJlIikpcmV0dXJuICJ6b25lLXRlbXBlcmF0dXJlIjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJEaHdUYW5rVGVtcGVyYXR1cmUiKSlyZXR1cm4gImRody10ZW1wZXJhdHVyZSI7CiAgICBpZihoYXMoIm1vbnRoIikmJmhhcygiZWxlY3RyaWNpdHlLV2giKSYmaGFzKCJoZWF0aW5nSGVhdEtXaCIpKXJldHVybiAibW9udGhseS1lbmVyZ3kiOwogICAgcmV0dXJuICJ1bmtub3duIjsKICB9CiAgZnVuY3Rpb24gcGFyc2VWYWlsbGFudENzdlRleHQodGV4dCxpbmRleD0wKXsKICAgIGNvbnN0IG5vcm1hbGl6ZWQ9U3RyaW5nKHRleHR8fCIiKS5yZXBsYWNlKC9eXHVGRUZGLywiIikucmVwbGFjZSgvXHJcbj8vZywiXG4iKTsKICAgIGNvbnN0IGV4cG9ydGVkQXQ9KG5vcm1hbGl6ZWQubWF0Y2goL2V4cG9ydGVkIGF0XHMrKFxkezR9LVxkezJ9LVxkezJ9KVxzK1xkezJ9OlxkezJ9L2kpfHxbXSlbMV18fG51bGw7CiAgICBjb25zdCBkYXRhTGluZXM9bm9ybWFsaXplZC5zcGxpdCgiXG4iKS5maWx0ZXIobGluZT0+e2NvbnN0IHQ9bGluZS50cmltKCk7cmV0dXJuIHQmJiF0LnN0YXJ0c1dpdGgoIiMiKTt9KTsKICAgIGlmKCFkYXRhTGluZXMubGVuZ3RoKXJldHVybiB7aW5kZXgsdHlwZToidW5rbm93biIscm93czpbXSxpbnZhbGlkUm93czowfTsKICAgIGNvbnN0IGRlbGltaXRlcj1kYXRhTGluZXNbMF0uaW5jbHVkZXMoIjsiKT8iOyI6IiwiOwogICAgY29uc3QgaGVhZGVycz1kYXRhTGluZXNbMF0uc3BsaXQoZGVsaW1pdGVyKS5tYXAodj0+di50cmltKCkpOwogICAgY29uc3QgdHlwZT1kZXRlY3RWYWlsbGFudENzdlR5cGUoaGVhZGVycykscm93cz1bXTtsZXQgaW52YWxpZFJvd3M9MDsKICAgIGlmKHR5cGU9PT0ibW9udGhseS1lbmVyZ3kiKXsKICAgICAgZm9yKGNvbnN0IGxpbmUgb2YgZGF0YUxpbmVzLnNsaWNlKDEpKXsKICAgICAgICBjb25zdCBwYXJ0cz1saW5lLnNwbGl0KGRlbGltaXRlcikscmF3PU9iamVjdC5mcm9tRW50cmllcyhoZWFkZXJzLm1hcCgoaCxpKT0+W2gscGFydHNbaV0/PyIiXSkpLG1vbnRoPVN0cmluZyhyYXcubW9udGh8fCIiKS50cmltKCk7CiAgICAgICAgaWYoIS9eXGR7NH0tKDBbMS05XXwxWzAtMl0pJC8udGVzdChtb250aCkpe2ludmFsaWRSb3dzKys7Y29udGludWU7fQogICAgICAgIGNvbnN0IHZhbHVlcz17fTsKICAgICAgICBmb3IoY29uc3QgaCBvZiBoZWFkZXJzKXsKICAgICAgICAgIGlmKGg9PT0ibW9udGgiKWNvbnRpbnVlOwogICAgICAgICAgdmFsdWVzW2hdPVsiY29tcGxldGUiLCJlc3RpbWF0ZWQiXS5pbmNsdWRlcyhoKT9TdHJpbmcocmF3W2hdKS50cmltKCkudG9Mb3dlckNhc2UoKT09PSJ0cnVlIjp2YWlsbGFudENzdk51bWJlcihyYXdbaF0pOwogICAgICAgIH0KICAgICAgICByb3dzLnB1c2goe21vbnRoS2V5Om1vbnRoLHZhbHVlc30pOwogICAgICB9CiAgICAgIHJldHVybiB7aW5kZXgsdHlwZSxoZWFkZXJzLHJvd3MsaW52YWxpZFJvd3MsZXhwb3J0ZWRBdH07CiAgICB9CiAgICBmb3IoY29uc3QgbGluZSBvZiBkYXRhTGluZXMuc2xpY2UoMSkpewogICAgICBpZighbGluZS50cmltKCkpY29udGludWU7CiAgICAgIGNvbnN0IHZhbHVlcz1saW5lLnNwbGl0KGRlbGltaXRlcik7CiAgICAgIGNvbnN0IHJhdz1PYmplY3QuZnJvbUVudHJpZXMoaGVhZGVycy5tYXAoKGhlYWRlcixjb2x1bW4pPT5baGVhZGVyLHZhbHVlc1tjb2x1bW5dPz8iIl0pKTsKICAgICAgY29uc3QgZGF0ZT12YWlsbGFudENzdkRhdGVQYXJ0cyhyYXcuRGF0ZVRpbWUpO2lmKCFkYXRlKXtpbnZhbGlkUm93cysrO2NvbnRpbnVlO30KICAgICAgY29uc3QgcGFyc2VkPXsuLi5kYXRlLHZhbHVlczp7fX07CiAgICAgIGZvcihjb25zdCBoZWFkZXIgb2YgaGVhZGVycyl7aWYoaGVhZGVyIT09IkRhdGVUaW1lIilwYXJzZWQudmFsdWVzW2hlYWRlcl09dmFpbGxhbnRDc3ZOdW1iZXIocmF3W2hlYWRlcl0pO30KICAgICAgcm93cy5wdXNoKHBhcnNlZCk7CiAgICB9CiAgICByZXR1cm4ge2luZGV4LHR5cGUsaGVhZGVycyxyb3dzLGludmFsaWRSb3dzLGV4cG9ydGVkQXR9OwogIH0KICBmdW5jdGlvbiBzYW1lVmFpbGxhbnRWYWx1ZShhLGIsdG9sZXJhbmNlPS4wNSl7CiAgICBpZihhPT1udWxsfHxiPT1udWxsKXJldHVybiBhPT1udWxsJiZiPT1udWxsOwogICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoYSkpJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGIpKT9NYXRoLmFicyhOdW1iZXIoYSktTnVtYmVyKGIpKTw9dG9sZXJhbmNlOlN0cmluZyhhKT09PVN0cmluZyhiKTsKICB9CiAgZnVuY3Rpb24gYnVpbGRWYWlsbGFudEltcG9ydFByZXZpZXcocGFyc2VkRmlsZXMpewogICAgY29uc3QgZW5lcmd5VHlwZXM9WyJhcm90aGVybS1lbmVyZ3kiLCJ1bml0b3dlci1lbmVyZ3kiXTsKICAgIGNvbnN0IGRhaWx5PXsiYXJvdGhlcm0tZW5lcmd5IjpuZXcgTWFwKCksInVuaXRvd2VyLWVuZXJneSI6bmV3IE1hcCgpfTsKICAgIGNvbnN0IGNvbmZsaWN0TW9udGhzPW5ldyBTZXQoKTtsZXQgZHVwbGljYXRlUm93cz0wOwogICAgZm9yKGNvbnN0IGZpbGUgb2YgcGFyc2VkRmlsZXMuZmlsdGVyKGY9PmVuZXJneVR5cGVzLmluY2x1ZGVzKGYudHlwZSkpKXsKICAgICAgY29uc3QgdGFyZ2V0PWRhaWx5W2ZpbGUudHlwZV07CiAgICAgIGZvcihjb25zdCByb3cgb2YgZmlsZS5yb3dzKXsKICAgICAgICBjb25zdCBleGlzdGluZz10YXJnZXQuZ2V0KHJvdy5kYXRlS2V5KTsKICAgICAgICBpZighZXhpc3Rpbmcpe3RhcmdldC5zZXQocm93LmRhdGVLZXkscm93KTtjb250aW51ZTt9CiAgICAgICAgY29uc3QgbWV0cmljcz1uZXcgU2V0KFsuLi5PYmplY3Qua2V5cyhleGlzdGluZy52YWx1ZXN8fHt9KSwuLi5PYmplY3Qua2V5cyhyb3cudmFsdWVzfHx7fSldKTsKICAgICAgICBjb25zdCBkaWZmZXJzPVsuLi5tZXRyaWNzXS5zb21lKG1ldHJpYz0+IXNhbWVWYWlsbGFudFZhbHVlKGV4aXN0aW5nLnZhbHVlcz8uW21ldHJpY10scm93LnZhbHVlcz8uW21ldHJpY10pKTsKICAgICAgICBpZihkaWZmZXJzKWNvbmZsaWN0TW9udGhzLmFkZChyb3cubW9udGhLZXkpO2Vsc2UgZHVwbGljYXRlUm93cysrOwogICAgICB9CiAgICB9CiAgICBjb25zdCBhbGxEYXRlcz1bLi4ubmV3IFNldChbLi4uZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLmtleXMoKSwuLi5kYWlseVsidW5pdG93ZXItZW5lcmd5Il0ua2V5cygpXSldOwogICAgY29uc3QgbW9udGhLZXlzPVsuLi5uZXcgU2V0KGFsbERhdGVzLm1hcChkPT5kLnNsaWNlKDAsNykpKV0uc29ydCgpOwogICAgY29uc3Qgc3VtPShtYXAsZGF0ZXMsbWV0cmljKT0+ZGF0ZXMucmVkdWNlKChzLGtleSk9Pntjb25zdCB2PW1hcC5nZXQoa2V5KT8udmFsdWVzPy5bbWV0cmljXTtyZXR1cm4gcysoTnVtYmVyLmlzRmluaXRlKHYpP3Y6MCk7fSwwKTsKICAgIGNvbnN0IGZ1bGw9KGRhdGVzLHksbSk9Pntjb25zdCBleHBlY3RlZD1uZXcgRGF0ZSh5LG0sMCkuZ2V0RGF0ZSgpLHU9Wy4uLm5ldyBTZXQoZGF0ZXMpXS5zb3J0KCk7cmV0dXJuIHUubGVuZ3RoPT09ZXhwZWN0ZWQmJnVbMF09PT1gJHt5fS0ke1N0cmluZyhtKS5wYWRTdGFydCgyLCIwIil9LTAxYCYmdS5hdCgtMSk9PT1gJHt5fS0ke1N0cmluZyhtKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKGV4cGVjdGVkKS5wYWRTdGFydCgyLCIwIil9YDt9OwogICAgY29uc3QgY3VycmVudD1jdXJyZW50TW9udGhLZXkoKTsKICAgIGNvbnN0IG1vbnRocz1tb250aEtleXMubWFwKG1vbnRoPT57CiAgICAgIGNvbnN0IHk9TnVtYmVyKG1vbnRoLnNsaWNlKDAsNCkpLG09TnVtYmVyKG1vbnRoLnNsaWNlKDUsNykpOwogICAgICBjb25zdCBhcm89Wy4uLmRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXS5rZXlzKCldLmZpbHRlcihrPT5rLnN0YXJ0c1dpdGgoYCR7bW9udGh9LWApKS5zb3J0KCk7CiAgICAgIGNvbnN0IHVuaT1bLi4uZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLmtleXMoKV0uZmlsdGVyKGs9Pmsuc3RhcnRzV2l0aChgJHttb250aH0tYCkpLnNvcnQoKTsKICAgICAgY29uc3QgdW5pb249Wy4uLm5ldyBTZXQoWy4uLmFybywuLi51bmldKV0uc29ydCgpOwogICAgICBjb25zdCBleHBvcnRlZFBhcnRpYWw9cGFyc2VkRmlsZXMuc29tZShmPT5bImFyb3RoZXJtLWVuZXJneSIsInVuaXRvd2VyLWVuZXJneSJdLmluY2x1ZGVzKGYudHlwZSkmJmYuZXhwb3J0ZWRBdD8uc2xpY2UoMCw3KT09PW1vbnRoKTsKICAgICAgIGNvbnN0IGNvbXBsZXRlPWZ1bGwoYXJvLHksbSkmJmZ1bGwodW5pLHksbSkmJiFleHBvcnRlZFBhcnRpYWwmJm1vbnRoIT09Y3VycmVudDsKICAgICAgY29uc3QgaGVhdGluZ0VsZWN0cmljaXR5PShzdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKStzdW0oZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLHVuaSwiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKSkvMTAwMDsKICAgICAgY29uc3QgZGh3RWxlY3RyaWNpdHk9c3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikvMTAwMDsKICAgICAgY29uc3QgaGVhdGluZ0hlYXQ9KHN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJIZWF0R2VuZXJhdGVkOkhlYXRpbmciKStzdW0oZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLHVuaSwiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikpLzEwMDA7CiAgICAgIGNvbnN0IGRod0hlYXQ9c3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkhlYXRHZW5lcmF0ZWQ6RG9tZXN0aWNIb3RXYXRlciIpLzEwMDA7CiAgICAgIGNvbnN0IGVsZWN0cmljaXR5S1doPWhlYXRpbmdFbGVjdHJpY2l0eStkaHdFbGVjdHJpY2l0eSxoZWF0R2VuZXJhdGVkS1doPWhlYXRpbmdIZWF0K2Rod0hlYXQ7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgICAgY29uc3QgbmVnYXRpdmVSZXN0PUJvb2xlYW4oZXhpc3RpbmcmJk51bWJlci5pc0Zpbml0ZShleGlzdGluZy50b3RhbCkmJk51bWJlci5pc0Zpbml0ZShleGlzdGluZy5hbm5leCkmJmV4aXN0aW5nLnRvdGFsLWVsZWN0cmljaXR5S1doLWV4aXN0aW5nLmFubmV4PC0uMDEpOwogICAgICBjb25zdCBoYXNDb25mbGljdD1jb25mbGljdE1vbnRocy5oYXMobW9udGgpLGhhc0JvdGg9YXJvLmxlbmd0aD4wJiZ1bmkubGVuZ3RoPjAsaXNDdXJyZW50PW1vbnRoPT09Y3VycmVudCxpc0Z1dHVyZT1tb250aD5jdXJyZW50OwogICAgICBjb25zdCBibG9ja2VkPSFoYXNCb3RofHxoYXNDb25mbGljdHx8bmVnYXRpdmVSZXN0fHxpc0Z1dHVyZXx8KCFjb21wbGV0ZSYmIWlzQ3VycmVudCk7CiAgICAgIHJldHVybiB7bW9udGgsZWxlY3RyaWNpdHlLV2gsaGVhdEdlbmVyYXRlZEtXaCxoZWF0aW5nRWxlY3RyaWNpdHlLV2g6aGVhdGluZ0VsZWN0cmljaXR5LGRod0VsZWN0cmljaXR5S1doOmRod0VsZWN0cmljaXR5LGhlYXRpbmdIZWF0S1doOmhlYXRpbmdIZWF0LGRod0hlYXRLV2g6ZGh3SGVhdCxjb21wbGV0ZSxjb3ZlcmFnZVN0YXJ0OnVuaW9uWzBdfHxudWxsLGNvdmVyYWdlRW5kOnVuaW9uLmF0KC0xKXx8bnVsbCxibG9ja2VkLGhhc0JvdGgsaGFzQ29uZmxpY3QsbmVnYXRpdmVSZXN0LGlzQ3VycmVudH07CiAgICB9KTsKICAgIHJldHVybiB7bW9udGhzLGR1cGxpY2F0ZVJvd3MscmVjb2duaXplZDpwYXJzZWRGaWxlcy5maWx0ZXIoZj0+Zi50eXBlIT09InVua25vd24iKS5sZW5ndGgsdW5rbm93bjpwYXJzZWRGaWxlcy5maWx0ZXIoZj0+Zi50eXBlPT09InVua25vd24iKS5sZW5ndGgsaW52YWxpZFJvd3M6cGFyc2VkRmlsZXMucmVkdWNlKChzLGYpPT5zK2YuaW52YWxpZFJvd3MsMCl9OwogIH0KICBmdW5jdGlvbiBtZXJnZVZhaWxsYW50SW1wb3J0KG1vbnRocyl7CiAgICBjb25zdCByZWNvcmRNYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICBjb25zdCB2YWlsbGFudE1hcD1uZXcgTWFwKCh2YWlsbGFudE1vbnRoc3x8W10pLm1hcCh2PT5bdi5tb250aCx7Li4udn1dKSk7CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7bGV0IGltcG9ydGVkPTAsY3JlYXRlZD0wLHBhcnRpYWw9MDsKICAgIGZvcihjb25zdCBtb250aCBvZiBtb250aHMuZmlsdGVyKG09PiFtLmJsb2NrZWQpKXsKICAgICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkTWFwLmdldChtb250aC5tb250aCl8fHNhbml0aXplUmVjb3JkKHttb250aDptb250aC5tb250aH0pOwogICAgICBjb25zdCB3YXNOZXc9IXJlY29yZE1hcC5oYXMobW9udGgubW9udGgpOwogICAgICBleGlzdGluZy5oZWF0UHVtcD1tb250aC5lbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuaGVhdEdlbmVyYXRlZD1tb250aC5oZWF0R2VuZXJhdGVkS1doOwogICAgICBleGlzdGluZy5oZWF0aW5nRWxlY3RyaWNpdHk9bW9udGguaGVhdGluZ0VsZWN0cmljaXR5S1doOwogICAgICBleGlzdGluZy5kaHdFbGVjdHJpY2l0eT1tb250aC5kaHdFbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuaGVhdGluZ0hlYXQ9bW9udGguaGVhdGluZ0hlYXRLV2g7CiAgICAgIGV4aXN0aW5nLmRod0hlYXQ9bW9udGguZGh3SGVhdEtXaDsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXBTb3VyY2U9bW9udGguY29tcGxldGU/Im15dmFpbGxhbnQtY3N2LWltcG9ydCI6Im15dmFpbGxhbnQtY3N2LWltcG9ydC1wYXJ0aWFsIjsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXBVcGRhdGVkQXQ9c3RhbXA7CiAgICAgIGV4aXN0aW5nLnVwZGF0ZWRBdD1zdGFtcDsKICAgICAgaWYoIW1vbnRoLmNvbXBsZXRlKXsKICAgICAgICBwYXJ0aWFsKys7CiAgICAgICAgY29uc3Qgbm90ZT1gbXlWQUlMTEFOVCBDU1YtVGVpbG1vbmF0ICR7bW9udGguY292ZXJhZ2VTdGFydH0gYmlzICR7bW9udGguY292ZXJhZ2VFbmR9YDsKICAgICAgICBpZighU3RyaW5nKGV4aXN0aW5nLm5vdGV8fCIiKS5pbmNsdWRlcyhub3RlKSlleGlzdGluZy5ub3RlPWV4aXN0aW5nLm5vdGU/YCR7ZXhpc3Rpbmcubm90ZX0g4oCiICR7bm90ZX1gOm5vdGU7CiAgICAgICAgZXhpc3RpbmcuY2xvc2VkPWZhbHNlO2V4aXN0aW5nLmNsb3NlZEF0PW51bGw7CiAgICAgIH0KICAgICAgcmVjb3JkTWFwLnNldChtb250aC5tb250aCxleGlzdGluZyk7CiAgICAgIHZhaWxsYW50TWFwLnNldChtb250aC5tb250aCx7bW9udGg6bW9udGgubW9udGgsZWxlY3RyaWNpdHlLV2g6bW9udGguZWxlY3RyaWNpdHlLV2gsaGVhdEdlbmVyYXRlZEtXaDptb250aC5oZWF0R2VuZXJhdGVkS1doLGhlYXRpbmdFbGVjdHJpY2l0eUtXaDptb250aC5oZWF0aW5nRWxlY3RyaWNpdHlLV2gsZGh3RWxlY3RyaWNpdHlLV2g6bW9udGguZGh3RWxlY3RyaWNpdHlLV2gsaGVhdGluZ0hlYXRLV2g6bW9udGguaGVhdGluZ0hlYXRLV2gsZGh3SGVhdEtXaDptb250aC5kaHdIZWF0S1doLHNvdXJjZTpleGlzdGluZy5oZWF0UHVtcFNvdXJjZSxlc3RpbWF0ZWQ6IW1vbnRoLmNvbXBsZXRlLHVwZGF0ZWRBdDpzdGFtcH0pOwogICAgICBpbXBvcnRlZCsrO2lmKHdhc05ldyljcmVhdGVkKys7CiAgICB9CiAgICBzYXZlUmVjb3JkcyhbLi4ucmVjb3JkTWFwLnZhbHVlcygpXSx7cmVhc29uOiJteVZBSUxMQU5UIENTViBpbXBvcnRpZXJ0In0pOwogICAgdmFpbGxhbnRNb250aHM9Wy4uLnZhaWxsYW50TWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpO3NhdmVWYWlsbGFudE1vbnRocygpOwogICAgcmV0dXJuIHtpbXBvcnRlZCxjcmVhdGVkLHBhcnRpYWx9OwogIH0KICBhc3luYyBmdW5jdGlvbiBpbXBvcnRWYWlsbGFudENzdkZpbGVzKGZpbGVMaXN0KXsKICAgIGNvbnN0IGZpbGVzPVsuLi4oZmlsZUxpc3R8fFtdKV07aWYoIWZpbGVzLmxlbmd0aClyZXR1cm47CiAgICBzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIiwiRGF0ZWllbiB3ZXJkZW4gbG9rYWwgZ2VwcsO8ZnQg4oCmIik7CiAgICB0cnl7CiAgICAgIGNvbnN0IHBhcnNlZD1bXTtmb3IobGV0IGk9MDtpPGZpbGVzLmxlbmd0aDtpKyspcGFyc2VkLnB1c2gocGFyc2VWYWlsbGFudENzdlRleHQoYXdhaXQgZmlsZXNbaV0udGV4dCgpLGkpKTsKICAgICAgY29uc3QgaGFzQXJvPXBhcnNlZC5zb21lKHg9PngudHlwZT09PSJhcm90aGVybS1lbmVyZ3kiKSxoYXNVbmk9cGFyc2VkLnNvbWUoeD0+eC50eXBlPT09InVuaXRvd2VyLWVuZXJneSIpOwogICAgICBpZihoYXNBcm8hPT1oYXNVbmkpdGhyb3cgRXJyb3IoIlTDpGdsaWNoZSBFbmVyZ2lld2VydGUgbnVyIG1pdCBhcm9USEVSTSB1bmQgdW5pVE9XRVIgZ2VtZWluc2FtIGltcG9ydGllcmVuLiIpOwogICAgICBjb25zdCBkYWlseT1oYXNBcm8mJmhhc1VuaT9idWlsZFZhaWxsYW50SW1wb3J0UHJldmlldyhwYXJzZWQpOnttb250aHM6W119OwogICAgICBjb25zdCBtYXA9bmV3IE1hcChtb250aGx5VmFpbGxhbnRJbXBvcnRzKHBhcnNlZCkubWFwKHg9Plt4Lm1vbnRoLHhdKSk7CiAgICAgIGZvcihjb25zdCByb3cgb2YgZGFpbHkubW9udGhzLmZpbHRlcih4PT4heC5ibG9ja2VkKSltYXAuc2V0KHJvdy5tb250aCxyb3cpOwogICAgICBjb25zdCBtb250aHM9Wy4uLm1hcC52YWx1ZXMoKV0sdGVtcD1jbGltYXRlUHJldmlldyhwYXJzZWQpOwogICAgICBpZighbW9udGhzLmxlbmd0aCYmIXRlbXAubGVuZ3RoKXRocm93IEVycm9yKCJLZWluZSBpbXBvcnRpZXJiYXJlbiBFbmVyZ2lld2VydGUgb2RlciBUZW1wZXJhdHVyZGF0ZWllbiBlcmthbm50LiIpOwogICAgICBjb25zdCBza2lwcGVkPWRhaWx5Lm1vbnRocy5maWx0ZXIoeD0+eC5ibG9ja2VkKS5sZW5ndGg7CiAgICAgIGlmKCFjb25maXJtKG1vbnRocy5sZW5ndGgrIiBFbmVyZ2llbW9uYXRlIHVuZCAiK3RlbXAubGVuZ3RoKyIgVGVtcGVyYXR1cm1vbmF0ZSDDvGJlcm5laG1lbj8gIisoc2tpcHBlZD9za2lwcGVkKyIgRW5lcmdpZS1Nb25hdGUgd2VyZGVuIHdlZ2VuIHVudm9sbHN0w6RuZGlnZXIgb2RlciB3aWRlcnNwcsO8Y2hsaWNoZXIgRGF0ZW4gw7xiZXJzcHJ1bmdlbi4gIjoiIikrIlrDpGhsZXJzdMOkbmRlLCBPc3Ryb20tUHJlaXNlIHVuZCBOb3RpemVuIGJsZWliZW4gdW52ZXLDpG5kZXJ0LiIpKXJldHVybjsKICAgICAgaWYobW9udGhzLmxlbmd0aCltZXJnZVZhaWxsYW50SW1wb3J0KG1vbnRocyk7CiAgICAgIGlmKHRlbXAubGVuZ3RoKWNsaW1hdGVJbXBvcnQodGVtcCk7CiAgICAgIHJlbmRlckFsbCgpOwogICAgICBzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIixtb250aHMubGVuZ3RoKyIgRW5lcmdpZS1Nb25hdGUgdW5kICIrdGVtcC5sZW5ndGgrIiBUZW1wZXJhdHVyLU1vbmF0ZSBpbXBvcnRpZXJ0Iiwib2siKTsKICAgICAgdG9hc3QoIlZhaWxsYW50LURhdGVuIGltcG9ydGllcnQiKTsKICAgIH1jYXRjaChlcnJvcil7c2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsZXJyb3IubWVzc2FnZSwiZXJyb3IiKTt9CiAgICBmaW5hbGx5eyQoInZhaWxsYW50Q3N2RmlsZXNJbnB1dCIpLnZhbHVlPSIiO30KICB9CgogIGFzeW5jIGZ1bmN0aW9uIG9zdHJvbUZldGNoKHBhdGgpewogICAgaWYoIXNldHRpbmdzLm9zdHJvbUFwcEtleSl0aHJvdyBuZXcgRXJyb3IoIkFwcC1TY2hsw7xzc2VsIGZlaGx0LiIpOwogICAgY29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2gocGF0aCx7aGVhZGVyczp7IngtZWxkZWhvZi1rZXkiOnNldHRpbmdzLm9zdHJvbUFwcEtleSwiYWNjZXB0IjoiYXBwbGljYXRpb24vanNvbiJ9LGNhY2hlOiJuby1zdG9yZSJ9KTsgY29uc3QgdGV4dD1hd2FpdCByZXNwb25zZS50ZXh0KCk7IGxldCBwYXlsb2FkPXt9OyB0cnl7cGF5bG9hZD10ZXh0P0pTT04ucGFyc2UodGV4dCk6e307fWNhdGNoe30KICAgIGlmKCFyZXNwb25zZS5vayl0aHJvdyBuZXcgRXJyb3IocGF5bG9hZC5lcnJvcnx8cGF5bG9hZC5tZXNzYWdlfHx0ZXh0fHxgRmVobGVyICR7cmVzcG9uc2Uuc3RhdHVzfWApOyByZXR1cm4gcGF5bG9hZDsKICB9CiAgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE9zdHJvbShzaG93VG9hc3Q9ZmFsc2UpewogICAgaWYob3N0cm9tQnVzeXx8IXNldHRpbmdzLm9zdHJvbUFwcEtleSl7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7cmV0dXJuIGZhbHNlO30KICAgIG9zdHJvbUJ1c3k9dHJ1ZTtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTsKICAgIHRyeXsgY29uc3QgcGF5bG9hZD1hd2FpdCBvc3Ryb21GZXRjaChgL2FwaS9saXZlJHtzaG93VG9hc3Q/Ij9yZWZyZXNoPTEiOiIifWApOyBzYXZlT3N0cm9tQ2FjaGUocGF5bG9hZCk7IGlmKHNob3dUb2FzdCl0b2FzdCgiT3N0cm9tIGFrdHVhbGlzaWVydCIpOyByZXR1cm4gdHJ1ZTsgfQogICAgY2F0Y2goZXJyb3IpeyBzZXRPc3Ryb21TdGF0dXMoYEZlaGxlcjogJHtlcnJvci5tZXNzYWdlfWAsImVycm9yIik7IGlmKHNob3dUb2FzdCl0b2FzdChgT3N0cm9tOiAke2Vycm9yLm1lc3NhZ2V9YCk7IHJldHVybiBmYWxzZTsgfQogICAgZmluYWxseXtvc3Ryb21CdXN5PWZhbHNlO3JlbmRlck9zdHJvbURhc2hib2FyZCgpO30KICB9CiAgZnVuY3Rpb24gc2NoZWR1bGVPc3Ryb20oKXsgY2xlYXJJbnRlcnZhbChvc3Ryb21UaW1lcik7b3N0cm9tVGltZXI9bnVsbDsgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5JiZzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlKW9zdHJvbVRpbWVyPXNldEludGVydmFsKCgpPT5yZWZyZXNoT3N0cm9tKGZhbHNlKSwxMCo2MCoxMDAwKTsgfQogIGZ1bmN0aW9uIHNldE9zdHJvbVN0YXR1cyh0ZXh0LGtpbmQ9IiIpeyBjb25zdCBlbD0kKCJvc3Ryb21TdGF0dXMiKTtlbC50ZXh0Q29udGVudD10ZXh0O2VsLnN0eWxlLmNvbG9yPWtpbmQ9PT0iZXJyb3IiPyIjZmZhYWE5IjoiIjsgfQogIGZ1bmN0aW9uIGZvcm1hdERhdGVUaW1lKHZhbHVlKXsgY29uc3QgZD1uZXcgRGF0ZSh2YWx1ZSk7IGlmKE51bWJlci5pc05hTihkLnZhbHVlT2YoKSkpcmV0dXJuICLigJMiOyByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7d2Vla2RheToic2hvcnQiLGRheToiMi1kaWdpdCIsbW9udGg6IjItZGlnaXQiLGhvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQoZCk7IH0KICBmdW5jdGlvbiBpbnRlcnZhbFJvd3MoKXsgcmV0dXJuIChBcnJheS5pc0FycmF5KG9zdHJvbUxpdmU/LnByaWNlRm9yZWNhc3QpP29zdHJvbUxpdmUucHJpY2VGb3JlY2FzdDpbXSkubWFwKHA9Pih7dGltZTpuZXcgRGF0ZShwLmRhdGV8fHAuc3RhcnR8fHAudGltZXN0YW1wKS5nZXRUaW1lKCkscHJpY2U6TnVtYmVyKHAudG90YWxDdFBlcktXaD8/cC5wcmljZUN0UGVyS1doPz9wLnByaWNlKX0pKS5maWx0ZXIocD0+TnVtYmVyLmlzRmluaXRlKHAudGltZSkmJk51bWJlci5pc0Zpbml0ZShwLnByaWNlKSkuc29ydCgoYSxiKT0+YS50aW1lLWIudGltZSk7IH0KICBmdW5jdGlvbiBpbmZlclN0ZXAocm93cyl7IGNvbnN0IGRpZmZzPVtdO2ZvcihsZXQgaT0xO2k8cm93cy5sZW5ndGg7aSsrKXtjb25zdCBkPXJvd3NbaV0udGltZS1yb3dzW2ktMV0udGltZTtpZihkPj01KjYwZTMmJmQ8PTIqMzYwMGUzKWRpZmZzLnB1c2goZCk7fSBpZighZGlmZnMubGVuZ3RoKXJldHVybiAzNjAwZTM7ZGlmZnMuc29ydCgoYSxiKT0+YS1iKTtyZXR1cm4gZGlmZnNbTWF0aC5mbG9vcihkaWZmcy5sZW5ndGgvMildOyB9CiAgZnVuY3Rpb24gY29tcHV0ZVByaWNlV2luZG93KHJvd3MsaG91cnMsbW9kZSl7CiAgICBpZighcm93cy5sZW5ndGgpcmV0dXJuIG51bGw7IGNvbnN0IHN0ZXA9aW5mZXJTdGVwKHJvd3MpOyBjb25zdCBjb3VudD1NYXRoLm1heCgxLE1hdGgucm91bmQoaG91cnMqMzYwMGUzL3N0ZXApKTsgY29uc3Qgbm93PURhdGUubm93KCk7IGNvbnN0IHBvb2w9cm93cy5maWx0ZXIocj0+ci50aW1lPj1ub3ctc3RlcCkuc2xpY2UoMCxNYXRoLm1heChjb3VudCxNYXRoLnJvdW5kKDQ4KjM2MDBlMy9zdGVwKSkpOwogICAgbGV0IGJlc3Q9bnVsbDsKICAgIGZvcihsZXQgaT0wO2krY291bnQ8PXBvb2wubGVuZ3RoO2krKyl7Y29uc3Qgc2xpY2U9cG9vbC5zbGljZShpLGkrY291bnQpO2xldCBjb250aWd1b3VzPXRydWU7Zm9yKGxldCBqPTE7ajxzbGljZS5sZW5ndGg7aisrKWlmKHNsaWNlW2pdLnRpbWUtc2xpY2Vbai0xXS50aW1lPnN0ZXAqMS42KXtjb250aWd1b3VzPWZhbHNlO2JyZWFrO31pZighY29udGlndW91cyljb250aW51ZTtjb25zdCBhdmc9c2xpY2UucmVkdWNlKChzLHIpPT5zK3IucHJpY2UsMCkvc2xpY2UubGVuZ3RoO2NvbnN0IGNhbmRpZGF0ZT17c3RhcnQ6c2xpY2VbMF0udGltZSxlbmQ6c2xpY2UuYXQoLTEpLnRpbWUrc3RlcCxhdmd9O2lmKCFiZXN0fHwobW9kZT09PSJtaW4iP2F2ZzxiZXN0LmF2Zzphdmc+YmVzdC5hdmcpKWJlc3Q9Y2FuZGlkYXRlO30KICAgIHJldHVybiBiZXN0OwogIH0KICBmdW5jdGlvbiByZW5kZXJPc3Ryb21EYXNoYm9hcmQoKXsKICAgIGNvbnN0IGNhblJlZnJlc2g9Qm9vbGVhbihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpOwogICAgY29uc3QgaGFzU3luY2VkRGF0YT1Cb29sZWFuKG9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0KTsKICAgIGNvbnN0IHZpc2libGU9Y2FuUmVmcmVzaHx8aGFzU3luY2VkRGF0YTsKICAgICQoIm9zdHJvbVNldHVwSGludCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsdmlzaWJsZSk7CiAgICAkKCJvc3Ryb21EYXNoYm9hcmQiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCF2aXNpYmxlKTsKICAgICQoIm9zdHJvbU1pbmlDaGFydCIpLnBhcmVudEVsZW1lbnQuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhdmlzaWJsZSk7CiAgICAkKCJyZWZyZXNoT3N0cm9tQnRuIikuZGlzYWJsZWQ9IWNhblJlZnJlc2h8fG9zdHJvbUJ1c3k7CiAgICBpZighdmlzaWJsZSl7IHNldE9zdHJvbVN0YXR1cygiTmljaHQgdmVyYnVuZGVuIik7IHJldHVybjsgfQogICAgaWYob3N0cm9tQnVzeSlzZXRPc3Ryb21TdGF0dXMoIkFrdHVhbGlzaWVydW5nIGzDpHVmdCDigKYiKTsKICAgIGVsc2UgaWYoaGFzU3luY2VkRGF0YSYmIWNhblJlZnJlc2gpc2V0T3N0cm9tU3RhdHVzKGBWb20gYW5kZXJlbiBHZXLDpHQgc3luY2hyb25pc2llcnQgwrcgJHtmb3JtYXREYXRlVGltZShvc3Ryb21MaXZlLmdlbmVyYXRlZEF0KX1gKTsKICAgIGVsc2UgaWYoaGFzU3luY2VkRGF0YSlzZXRPc3Ryb21TdGF0dXMoYEFrdHVhbGlzaWVydCAke2Zvcm1hdERhdGVUaW1lKG9zdHJvbUxpdmUuZ2VuZXJhdGVkQXQpfWApOwogICAgZWxzZSBzZXRPc3Ryb21TdGF0dXMoIk5vY2gga2VpbmUgTGl2ZS1EYXRlbiIpOwogICAgY29uc3Qgcm93cz1pbnRlcnZhbFJvd3MoKTsgaWYoIXJvd3MubGVuZ3RoKXsgWyJvc3Ryb21DdXJyZW50UHJpY2UiLCJvc3Ryb21CZXN0UHJpY2UiLCJvc3Ryb21Xb3JzdFByaWNlIl0uZm9yRWFjaChpZD0+JChpZCkudGV4dENvbnRlbnQ9IuKAkyIpOyBbIm9zdHJvbUN1cnJlbnRNZXRhIiwib3N0cm9tQmVzdE1ldGEiLCJvc3Ryb21Xb3JzdE1ldGEiXS5mb3JFYWNoKGlkPT4kKGlkKS50ZXh0Q29udGVudD0iTm9jaCBrZWluZSBQcmVpc3ZvcnNjaGF1Iik7IGRyYXdPc3Ryb21NaW5pKFtdKTsgcmV0dXJuOyB9CiAgICBjb25zdCBub3c9RGF0ZS5ub3coKSxzdGVwPWluZmVyU3RlcChyb3dzKTsgY29uc3QgY3VycmVudD1yb3dzLmZpbmQoKHIsaSk9PnIudGltZTw9bm93JiYocm93c1tpKzFdPy50aW1lPz9yLnRpbWUrc3RlcCk+bm93KXx8cm93cy5maW5kKHI9PnIudGltZT5ub3cpfHxyb3dzLmF0KC0xKTsgY29uc3QgaG91cnM9TnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKXx8MzsgY29uc3QgYmVzdD1jb21wdXRlUHJpY2VXaW5kb3cocm93cyxob3VycywibWluIiksIHdvcnN0PWNvbXB1dGVQcmljZVdpbmRvdyhyb3dzLGhvdXJzLCJtYXgiKTsKICAgICQoIm9zdHJvbUJlc3RMYWJlbCIpLnRleHRDb250ZW50PWBCZXN0ZXMgJHtob3Vyc31oLUZlbnN0ZXJgOyAkKCJvc3Ryb21Xb3JzdExhYmVsIikudGV4dENvbnRlbnQ9YFNjaGxlY2h0ZXN0ZXMgJHtob3Vyc31oLUZlbnN0ZXJgOwogICAgJCgib3N0cm9tQ3VycmVudFByaWNlIikudGV4dENvbnRlbnQ9YCR7bnVtKGN1cnJlbnQ/LnByaWNlLDIpfSBjdC9rV2hgOyAkKCJvc3Ryb21DdXJyZW50TWV0YSIpLnRleHRDb250ZW50PWN1cnJlbnQ/Zm9ybWF0RGF0ZVRpbWUoY3VycmVudC50aW1lKToi4oCTIjsKICAgICQoIm9zdHJvbUJlc3RQcmljZSIpLnRleHRDb250ZW50PWJlc3Q/YCR7bnVtKGJlc3QuYXZnLDIpfSBjdC9rV2hgOiLigJMiOyAkKCJvc3Ryb21CZXN0TWV0YSIpLnRleHRDb250ZW50PWJlc3Q/YCR7Zm9ybWF0RGF0ZVRpbWUoYmVzdC5zdGFydCl9IOKAkyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUoYmVzdC5lbmQpKX1gOiLigJMiOwogICAgJCgib3N0cm9tV29yc3RQcmljZSIpLnRleHRDb250ZW50PXdvcnN0P2Ake251bSh3b3JzdC5hdmcsMil9IGN0L2tXaGA6IuKAkyI7ICQoIm9zdHJvbVdvcnN0TWV0YSIpLnRleHRDb250ZW50PXdvcnN0P2Ake2Zvcm1hdERhdGVUaW1lKHdvcnN0LnN0YXJ0KX0g4oCTICR7bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCIsbWludXRlOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZSh3b3JzdC5lbmQpKX1gOiLigJMiOwogICAgZHJhd09zdHJvbU1pbmkocm93cy5maWx0ZXIocj0+ci50aW1lPj1ub3ctc3RlcCkuc2xpY2UoMCw0OCkpOwogIH0KICBmdW5jdGlvbiBkcmF3T3N0cm9tTWluaShyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgib3N0cm9tTWluaUNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBpZighcm93cy5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LCJLZWluZSBPc3Ryb20tUHJlaXNkYXRlbiIpO3JldHVybjt9IGNvbnN0IG1pbj1NYXRoLm1pbiguLi5yb3dzLm1hcChyPT5yLnByaWNlKSksbWF4PU1hdGgubWF4KC4uLnJvd3MubWFwKHI9PnIucHJpY2UpKSxzcGFuPU1hdGgubWF4KDEsbWF4LW1pbik7IGNvbnN0IHBhZD17bDo0MyxyOjgsdDoxMixiOjMwfSx3PXdpZHRoLXBhZC5sLXBhZC5yLGg9aGVpZ2h0LXBhZC50LXBhZC5iOwogICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkO2N0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7Y3R4LmZvbnQ9IjEwcHggc2Fucy1zZXJpZiI7Zm9yKGxldCBpPTA7aTw9MztpKyspe2NvbnN0IHk9cGFkLnQraCppLzM7Y3R4LmJlZ2luUGF0aCgpO2N0eC5tb3ZlVG8ocGFkLmwseSk7Y3R4LmxpbmVUbyh3aWR0aC1wYWQucix5KTtjdHguc3Ryb2tlKCk7Y3R4LmZpbGxUZXh0KG51bShtYXgtc3BhbippLzMsMCksNCx5KzMpO30gY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy50b3RhbDtjdHgubGluZVdpZHRoPTI7Y3R4LmJlZ2luUGF0aCgpO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9cGFkLmwrKHJvd3MubGVuZ3RoPT09MT93LzI6dyppLyhyb3dzLmxlbmd0aC0xKSkseT1wYWQudCtoKigxLShyLnByaWNlLW1pbikvc3Bhbik7aT9jdHgubGluZVRvKHgseSk6Y3R4Lm1vdmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICAgIGNvbnN0IHN0ZXA9TWF0aC5tYXgoMSxNYXRoLmZsb29yKHJvd3MubGVuZ3RoLzUpKTsgcm93cy5mb3JFYWNoKChyLGkpPT57aWYoaSVzdGVwJiZpIT09cm93cy5sZW5ndGgtMSlyZXR1cm47Y29uc3QgeD1wYWQubCsocm93cy5sZW5ndGg9PT0xP3cvMjp3KmkvKHJvd3MubGVuZ3RoLTEpKTtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5maWxsVGV4dChuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZShyLnRpbWUpKSx4LTgsaGVpZ2h0LTkpO30pOwogIH0KICBhc3luYyBmdW5jdGlvbiBzYXZlQW5kQ2hlY2tPc3Ryb20oKXsKICAgIGNvbnN0IGtleT0kKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlLnRyaW0oKTsgc2V0dGluZ3Mub3N0cm9tQXBwS2V5PWtleTsgc2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2g9JCgib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIpLmNoZWNrZWQ7IHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzPU51bWJlcigkKCJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0IikudmFsdWUpfHwzOyBzYXZlU2V0dGluZ3MoKTsKICAgIGlmKCFrZXkpe3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIkJpdHRlIEFwcC1TY2hsw7xzc2VsIGVpbnRyYWdlbi4iLCJlcnJvciIpO3JlbmRlck9zdHJvbURhc2hib2FyZCgpO3JldHVybjt9CiAgICBzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJWZXJiaW5kdW5nIHdpcmQgZ2VwcsO8ZnQg4oCmIik7CiAgICB0cnl7IGNvbnN0IGhlYWx0aD1hd2FpdCBvc3Ryb21GZXRjaCgiL2FwaS9oZWFsdGg/ZGVlcD10b2tlbiIpOyBpZighaGVhbHRoLmNvbmZpZ3VyZWQpdGhyb3cgbmV3IEVycm9yKCJDbG91ZGZsYXJlLVNlY3JldHMgc2luZCBuaWNodCB2b2xsc3TDpG5kaWcgZWluZ2VyaWNodGV0LiIpOyBzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJPc3Ryb20tVmVyYmluZHVuZyBlcmZvbGdyZWljaC4iLCJvayIpOyBhd2FpdCByZWZyZXNoT3N0cm9tKHRydWUpOyBzY2hlZHVsZU9zdHJvbSgpOyByZW5kZXJBbGwoKTsgfQogICAgY2F0Y2goZXJyb3Ipe3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsZXJyb3IubWVzc2FnZSwiZXJyb3IiKTt9CiAgfQogIGZ1bmN0aW9uIGRpc2Nvbm5lY3RPc3Ryb20oKXsgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5JiYhY29uZmlybSgiT3N0cm9tLVZlcmJpbmR1bmcgd2lya2xpY2ggZW50ZmVybmVuPyIpKXJldHVybjsgc2V0dGluZ3Mub3N0cm9tQXBwS2V5PSIiO3NhdmVTZXR0aW5ncygpO3NhdmVPc3Ryb21DYWNoZShudWxsKTtsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShPU1RST01fQ09OVFJPTF9LRVkpO3NjaGVkdWxlT3N0cm9tKCk7cmVuZGVyQWxsKCk7c2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiVmVyYmluZHVuZyBlbnRmZXJudC4iKTt0b2FzdCgiT3N0cm9tIGdldHJlbm50Iik7IH0KCgogIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hPc3Ryb21IaXN0b3J5KHtzaWxlbnQ9ZmFsc2Usb25seU1pc3Npbmc9ZmFsc2UsbWF4TW9udGhzPUluZmluaXR5fT17fSl7CiAgICBpZihvc3Ryb21IaXN0b3J5QnVzeSlyZXR1cm47CiAgICBpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtpZighc2lsZW50KXRvYXN0KCJPc3Ryb20genVlcnN0IHZlcmJpbmRlbiIpO3JldHVybjt9CiAgICBjb25zdCBlbGlnaWJsZT1zb3J0ZWQoKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpJiZyLm1vbnRoPGN1cnJlbnRNb250aEtleSgpKS5maWx0ZXIocj0+IW9ubHlNaXNzaW5nfHwhci5vc3Ryb21QcmljZUNvbXBsZXRlKTsKICAgIGlmKCFlbGlnaWJsZS5sZW5ndGgpe2lmKCFzaWxlbnQpdG9hc3QoIlByZWlzaGlzdG9yaWUgaXN0IGJlcmVpdHMgdm9sbHN0w6RuZGlnIik7cmV0dXJuO30KICAgIG9zdHJvbUhpc3RvcnlCdXN5PXRydWU7cmVuZGVyRGF0YSgpOwogICAgbGV0IHVwZGF0ZWQ9MCx1bmF2YWlsYWJsZT0wLHByb2Nlc3NlZD0wOwogICAgY29uc3QgbWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgdHJ5ewogICAgICBmb3IoY29uc3QgciBvZiBlbGlnaWJsZS5zbGljZSgtTWF0aC5tYXgoMSxOdW1iZXIobWF4TW9udGhzKXx8ZWxpZ2libGUubGVuZ3RoKSkpewogICAgICAgIHByb2Nlc3NlZCsrOwogICAgICAgIGlmKCFzaWxlbnQpc2V0U3RhdHVzKCJvc3Ryb21IaXN0b3J5U3RhdHVzIixgJHttb250aExhYmVsKHIubW9udGgsZmFsc2UpfSB3aXJkIHZvbiBPc3Ryb20gZ2VsYWRlbiDigKYgKCR7cHJvY2Vzc2VkfS8ke01hdGgubWluKGVsaWdpYmxlLmxlbmd0aCxtYXhNb250aHMpfSlgKTsKICAgICAgICB0cnl7CiAgICAgICAgICBjb25zdCBkYXRhPWF3YWl0IG9zdHJvbUZldGNoKGAvYXBpL21vbnRoP21vbnRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHIubW9udGgpfWApOwogICAgICAgICAgaWYoIWRhdGE/LmNvbXBsZXRlfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSl8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEudG90YWxDb3N0RXVyKSkpe3VuYXZhaWxhYmxlKys7Y29udGludWU7fQogICAgICAgICAgY29uc3QgaXRlbT1tYXAuZ2V0KHIubW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6ci5tb250aH0pOwogICAgICAgICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgICAgICAgaXRlbS5wcmljZUN0PU51bWJlcihkYXRhLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKTsKICAgICAgICAgIGl0ZW0uYmFzZUZlZT1OdW1iZXIoZGF0YS5maXhlZENvc3RFdXIpfHwwOwogICAgICAgICAgaXRlbS5vc3Ryb21WYXJpYWJsZUNvc3RFdXI9TnVtYmVyKGRhdGEudmFyaWFibGVDb3N0RXVyKTsKICAgICAgICAgIGl0ZW0ub3N0cm9tVG90YWxDb3N0RXVyPU51bWJlcihkYXRhLnRvdGFsQ29zdEV1cik7CiAgICAgICAgICBpdGVtLm9zdHJvbUNvbnN1bXB0aW9uS1doPU51bWJlcihkYXRhLnRvdGFsS1doKTsKICAgICAgICAgIGl0ZW0ub3N0cm9tUHJpY2VDb21wbGV0ZT10cnVlOwogICAgICAgICAgaXRlbS5wcmljZVNvdXJjZT0ib3N0cm9tLWhvdXJseS1jb25zdW1wdGlvbi13ZWlnaHRlZCI7CiAgICAgICAgICBpdGVtLnByaWNlVXBkYXRlZEF0PXN0YW1wOwogICAgICAgICAgaXRlbS51cGRhdGVkQXQ9c3RhbXA7CiAgICAgICAgICBtYXAuc2V0KHIubW9udGgsaXRlbSk7dXBzZXJ0T3N0cm9tUHJpY2VTdGF0KHIubW9udGgsZGF0YSx7cGFydGlhbDpmYWxzZX0pO3VwZGF0ZWQrKzsKICAgICAgICB9Y2F0Y2goZXJyb3Ipe3VuYXZhaWxhYmxlKys7fQogICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmU9PnNldFRpbWVvdXQocmVzb2x2ZSwxNDApKTsKICAgICAgfQogICAgICBpZih1cGRhdGVkKXNhdmVSZWNvcmRzKFsuLi5tYXAudmFsdWVzKCldLHtyZWFzb246Ik9zdHJvbS1TdHVuZGVucHJlaXNlIGFrdHVhbGlzaWVydCJ9KTsKICAgICAgY29uc3Qgc3RhdHVzPXt1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHVwZGF0ZWQsdW5hdmFpbGFibGV9O2xvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9ISVNUT1JZX0tFWSxKU09OLnN0cmluZ2lmeShzdGF0dXMpKTsKICAgICAgcmVuZGVyQWxsKCk7CiAgICAgIGlmKCFzaWxlbnQpdG9hc3QoYCR7dXBkYXRlZH0gTW9uYXQoZSkgbWl0IE9zdHJvbS1TdHVuZGVucHJlaXNlbiBha3R1YWxpc2llcnQke3VuYXZhaWxhYmxlP2AgwrcgJHt1bmF2YWlsYWJsZX0gbmljaHQgdmVyZsO8Z2JhcmA6IiJ9YCk7CiAgICB9ZmluYWxseXtvc3Ryb21IaXN0b3J5QnVzeT1mYWxzZTtyZW5kZXJEYXRhKCk7fQogIH0KCiAgZnVuY3Rpb24gc3luY1JhbmRvbUJ5dGVzKGxlbmd0aD0zMil7Y29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ5dGVzKTtyZXR1cm4gYnl0ZXM7fQogIGZ1bmN0aW9uIHN5bmNCeXRlc1RvQmFzZTY0VXJsKGJ5dGVzKXtsZXQgYmluYXJ5PSIiO2ZvcihsZXQgaT0wO2k8Ynl0ZXMubGVuZ3RoO2krPTgxOTIpYmluYXJ5Kz1TdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksaSs4MTkyKSk7cmV0dXJuIGJ0b2EoYmluYXJ5KS5yZXBsYWNlQWxsKCIrIiwiLSIpLnJlcGxhY2VBbGwoIi8iLCJfIikucmVwbGFjZSgvPSskL2csIiIpO30KICBmdW5jdGlvbiBzeW5jQmFzZTY0VXJsVG9CeXRlcyh2YWx1ZSl7Y29uc3QgcmF3PVN0cmluZyh2YWx1ZXx8IiIpLnJlcGxhY2VBbGwoIi0iLCIrIikucmVwbGFjZUFsbCgiXyIsIi8iKTtjb25zdCBwYWRkZWQ9cmF3KyI9Ii5yZXBlYXQoKDQtcmF3Lmxlbmd0aCU0KSU0KTtjb25zdCBiaW5hcnk9YXRvYihwYWRkZWQpO2NvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KGJpbmFyeS5sZW5ndGgpO2ZvcihsZXQgaT0wO2k8YmluYXJ5Lmxlbmd0aDtpKyspYnl0ZXNbaV09YmluYXJ5LmNoYXJDb2RlQXQoaSk7cmV0dXJuIGJ5dGVzO30KICBmdW5jdGlvbiBzeW5jUmVjb3ZlcnlOb3JtYWxpemUodmFsdWUpe3JldHVybiBTdHJpbmcodmFsdWV8fCIiKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teMC05YS1mXS9nLCIiKTt9CiAgZnVuY3Rpb24gc3luY1JlY292ZXJ5Rm9ybWF0KHZhbHVlKXtjb25zdCByYXc9c3luY1JlY292ZXJ5Tm9ybWFsaXplKHZhbHVlKS50b1VwcGVyQ2FzZSgpO3JldHVybiByYXcubWF0Y2goLy57MSw0fS9nKT8uam9pbigiLSIpfHwiIjt9CiAgZnVuY3Rpb24gc3luY0dlbmVyYXRlUmVjb3ZlcnlLZXkoKXtyZXR1cm4gWy4uLnN5bmNSYW5kb21CeXRlcygzMildLm1hcChiPT5iLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCIwIikpLmpvaW4oIiIpO30KICBmdW5jdGlvbiBzeW5jR2VuZXJhdGVJZChwcmVmaXgsYnl0ZXM9MTYpe3JldHVybiBgJHtwcmVmaXh9LSR7c3luY0J5dGVzVG9CYXNlNjRVcmwoc3luY1JhbmRvbUJ5dGVzKGJ5dGVzKSl9YDt9CiAgZnVuY3Rpb24gbG9hZFN5bmNTdGF0ZSgpewogICAgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU1lOQ19TVEFURV9LRVkpLHt9KTsKICAgIHJldHVybiB7Y29uZmlndXJlZDpCb29sZWFuKHJhdz8uY29uZmlndXJlZCksdmF1bHRJZDpTdHJpbmcocmF3Py52YXVsdElkfHwiIiksZGV2aWNlSWQ6U3RyaW5nKHJhdz8uZGV2aWNlSWR8fCIiKSxkZXZpY2VOYW1lOlN0cmluZyhyYXc/LmRldmljZU5hbWV8fCIiKSxkZXZpY2VUb2tlbjpTdHJpbmcocmF3Py5kZXZpY2VUb2tlbnx8IiIpLHJlY292ZXJ5S2V5OigoKT0+e2NvbnN0IGN1cnJlbnQ9c3luY1JlY292ZXJ5Tm9ybWFsaXplKHJhdz8ucmVjb3ZlcnlLZXl8fCIiKTtjb25zdCBsZWdhY3k9c3luY1JlY292ZXJ5Tm9ybWFsaXplKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNZTkNfU0VDUkVUX0xFR0FDWV9LRVkpfHwiIik7cmV0dXJuIGN1cnJlbnQubGVuZ3RoPT09NjQ/Y3VycmVudDpsZWdhY3kubGVuZ3RoPT09NjQ/bGVnYWN5OmN1cnJlbnQ7fSkoKSxyb2xlOnJhdz8ucm9sZT09PSJhZG1pbiI/ImFkbWluIjoibWVtYmVyIixzY29wZToiZnVsbCIsc2VydmVyUmV2aXNpb246TWF0aC5tYXgoMCxOdW1iZXIocmF3Py5zZXJ2ZXJSZXZpc2lvbj8/cmF3Py5yZXZpc2lvbil8fDApLGxhc3RTeW5jQXQ6U3RyaW5nKHJhdz8ubGFzdFN5bmNBdHx8IiIpLGxhc3RFcnJvcjpTdHJpbmcocmF3Py5sYXN0RXJyb3J8fCIiKX07CiAgfQogIGZ1bmN0aW9uIHNhdmVTeW5jU3RhdGUoKXtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTWU5DX1NUQVRFX0tFWSxKU09OLnN0cmluZ2lmeShzeW5jU3RhdGUpKTt9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0Rlcml2ZUtleShyZWNvdmVyeUtleSx2YXVsdElkKXsKICAgIGNvbnN0IHJhdz1zeW5jUmVjb3ZlcnlOb3JtYWxpemUocmVjb3ZlcnlLZXkpO2lmKHJhdy5sZW5ndGghPT02NCl0aHJvdyBuZXcgRXJyb3IoIldpZWRlcmhlcnN0ZWxsdW5nc3NjaGzDvHNzZWwgaXN0IHVudm9sbHN0w6RuZGlnLiIpOwogICAgY29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkocmF3Lm1hdGNoKC8uezJ9L2cpLm1hcCh2PT5wYXJzZUludCh2LDE2KSkpO2NvbnN0IGJhc2U9YXdhaXQgY3J5cHRvLnN1YnRsZS5pbXBvcnRLZXkoInJhdyIsYnl0ZXMsIkhLREYiLGZhbHNlLFsiZGVyaXZlS2V5Il0pOwogICAgcmV0dXJuIGNyeXB0by5zdWJ0bGUuZGVyaXZlS2V5KHtuYW1lOiJIS0RGIixoYXNoOiJTSEEtMjU2IixzYWx0Om5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh2YXVsdElkKSxpbmZvOm5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSgiZWxkZWhvZi1wcml2YXRlLXN5bmMtdjEiKX0sYmFzZSx7bmFtZToiQUVTLUdDTSIsbGVuZ3RoOjI1Nn0sZmFsc2UsWyJlbmNyeXB0IiwiZGVjcnlwdCJdKTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0VuY3J5cHQocGF5bG9hZCl7Y29uc3Qga2V5PWF3YWl0IHN5bmNEZXJpdmVLZXkoc3luY1N0YXRlLnJlY292ZXJ5S2V5LHN5bmNTdGF0ZS52YXVsdElkKTtjb25zdCBpdj1zeW5jUmFuZG9tQnl0ZXMoMTIpO2NvbnN0IGFhZD1uZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoYCR7U1lOQ19FTlZFTE9QRV9TQ0hFTUF9OiR7c3luY1N0YXRlLnZhdWx0SWR9YCk7Y29uc3QgcGxhaW49bmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtjb25zdCBlbmNyeXB0ZWQ9YXdhaXQgY3J5cHRvLnN1YnRsZS5lbmNyeXB0KHtuYW1lOiJBRVMtR0NNIixpdixhZGRpdGlvbmFsRGF0YTphYWQsdGFnTGVuZ3RoOjEyOH0sa2V5LHBsYWluKTtyZXR1cm4ge3NjaGVtYTpTWU5DX0VOVkVMT1BFX1NDSEVNQSxhbGdvcml0aG06IkFFUy1HQ00tMjU2L0hLREYtU0hBLTI1NiIsaXY6c3luY0J5dGVzVG9CYXNlNjRVcmwoaXYpLGNpcGhlcnRleHQ6c3luY0J5dGVzVG9CYXNlNjRVcmwobmV3IFVpbnQ4QXJyYXkoZW5jcnlwdGVkKSksc2NvcGU6ImZ1bGwiLGNyZWF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkscGF5bG9hZEJ1aWxkOkFQUF9CVUlMRH07fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNEZWNyeXB0KGVudmVsb3BlKXtpZihlbnZlbG9wZT8uc2NoZW1hIT09U1lOQ19FTlZFTE9QRV9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJVbmJla2FubnRlcyBTeW5jLVBha2V0LiIpO2NvbnN0IGtleT1hd2FpdCBzeW5jRGVyaXZlS2V5KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSxzeW5jU3RhdGUudmF1bHRJZCk7Y29uc3QgYWFkPW5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShgJHtTWU5DX0VOVkVMT1BFX1NDSEVNQX06JHtzeW5jU3RhdGUudmF1bHRJZH1gKTtsZXQgcGxhaW47dHJ5e3BsYWluPWF3YWl0IGNyeXB0by5zdWJ0bGUuZGVjcnlwdCh7bmFtZToiQUVTLUdDTSIsaXY6c3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuaXYpLGFkZGl0aW9uYWxEYXRhOmFhZCx0YWdMZW5ndGg6MTI4fSxrZXksc3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuY2lwaGVydGV4dCkpO31jYXRjaHt0aHJvdyBuZXcgRXJyb3IoIlN5bmMtUGFrZXQga29ubnRlIG5pY2h0IGVudHNjaGzDvHNzZWx0IHdlcmRlbi4iKTt9Y29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShwbGFpbikpO2lmKHBheWxvYWQ/LnNjaGVtYSE9PVNZTkNfUEFZTE9BRF9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJTeW5jLVBha2V0IHN0YW1tdCBhdXMgZWluZXIgbmljaHQga29tcGF0aWJsZW4gRWxkZWhvZi1WZXJzaW9uLiIpO3JldHVybiBwYXlsb2FkO30KICBhc3luYyBmdW5jdGlvbiBzeW5jQXBpKHBhdGgsYm9keSl7Y29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2goYC9hcGkvc3luYy8ke3BhdGh9YCx7bWV0aG9kOiJQT1NUIixoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiIsImFjY2VwdCI6ImFwcGxpY2F0aW9uL2pzb24ifSxib2R5OkpTT04uc3RyaW5naWZ5KGJvZHkpLGNhY2hlOiJuby1zdG9yZSJ9KTtsZXQgcGF5bG9hZD17fTt0cnl7cGF5bG9hZD1hd2FpdCByZXNwb25zZS5qc29uKCk7fWNhdGNoe31pZighcmVzcG9uc2Uub2spe2NvbnN0IGVycm9yPW5ldyBFcnJvcihwYXlsb2FkLmVycm9yfHxgU3luYy1GZWhsZXIgJHtyZXNwb25zZS5zdGF0dXN9YCk7ZXJyb3Iuc3RhdHVzPXJlc3BvbnNlLnN0YXR1cztlcnJvci5wYXlsb2FkPXBheWxvYWQ7dGhyb3cgZXJyb3I7fXJldHVybiBwYXlsb2FkO30KICBmdW5jdGlvbiBzeW5jQXV0aChleHRyYT17fSl7cmV0dXJuIHt2YXVsdElkOnN5bmNTdGF0ZS52YXVsdElkLGRldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxkZXZpY2VUb2tlbjpzeW5jU3RhdGUuZGV2aWNlVG9rZW4sLi4uZXh0cmF9O30KICBmdW5jdGlvbiBzeW5jSXRlbVRpbWUoaXRlbSl7Zm9yKGNvbnN0IGtleSBvZiBbInVwZGF0ZWRBdCIsInByaWNlVXBkYXRlZEF0IiwiaGVhdFB1bXBVcGRhdGVkQXQiLCJjbG9zZWRBdCJdKXtjb25zdCB0PURhdGUucGFyc2UoaXRlbT8uW2tleV18fCIiKTtpZihOdW1iZXIuaXNGaW5pdGUodCkpcmV0dXJuIHQ7fXJldHVybiAwO30KICBmdW5jdGlvbiBzeW5jTWVyZ2VCeUtleShsb2NhbCxyZW1vdGUsa2V5RmllbGQpe2NvbnN0IG1hcD1uZXcgTWFwKCk7Zm9yKGNvbnN0IGl0ZW0gb2YgQXJyYXkuaXNBcnJheShsb2NhbCk/bG9jYWw6W10pbWFwLnNldChTdHJpbmcoaXRlbT8uW2tleUZpZWxkXXx8IiIpLGl0ZW0pO2Zvcihjb25zdCByZW1vdGVJdGVtIG9mIEFycmF5LmlzQXJyYXkocmVtb3RlKT9yZW1vdGU6W10pe2NvbnN0IGtleT1TdHJpbmcocmVtb3RlSXRlbT8uW2tleUZpZWxkXXx8IiIpO2lmKCFrZXkpY29udGludWU7Y29uc3QgbG9jYWxJdGVtPW1hcC5nZXQoa2V5KTtpZighbG9jYWxJdGVtfHxzeW5jSXRlbVRpbWUocmVtb3RlSXRlbSk+PXN5bmNJdGVtVGltZShsb2NhbEl0ZW0pKW1hcC5zZXQoa2V5LHJlbW90ZUl0ZW0pO31yZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV07fQogIGZ1bmN0aW9uIHN5bmNDdXJyZW50UGF5bG9hZCgpe3JldHVybiB7c2NoZW1hOlNZTkNfUEFZTE9BRF9TQ0hFTUEscGF5bG9hZFZlcnNpb246IjYuMy40IixhcHA6IkVsZGVob2YiLHNjb3BlOiJmdWxsIixyZWNvcmRzOnNhbml0aXplUmVjb3JkcyhyZWNvcmRzKSx2YWlsbGFudE1vbnRoczpBcnJheS5pc0FycmF5KHZhaWxsYW50TW9udGhzKT92YWlsbGFudE1vbnRoczpbXSxjbGltYXRlTW9udGhzOmNsaW1hdGVTYW5pdGl6ZShjbGltYXRlTW9udGhzKSxtZXRlclJlYWRpbmdzOnNhbml0aXplTWV0ZXJSZWFkaW5ncyhtZXRlclJlYWRpbmdzKSxtZXRlclJlYWRpbmdzVXBkYXRlZEF0OmxvY2FsU3RvcmFnZS5nZXRJdGVtKE1FVEVSX01FVEFfS0VZKXx8IiIsb3N0cm9tTGl2ZTpvc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKG9zdHJvbVByaWNlU3RhdHMpLGV4cG9ydGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHNvdXJjZURldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxzb3VyY2VEZXZpY2VOYW1lOnN5bmNTdGF0ZS5kZXZpY2VOYW1lfTt9CiAgZnVuY3Rpb24gc3luY01lcmdlUGF5bG9hZChsb2NhbCxyZW1vdGUpewogICAgY29uc3QgbG9jYWxNZXRlclRpbWU9RGF0ZS5wYXJzZShsb2NhbD8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIpfHwwLHJlbW90ZU1ldGVyVGltZT1EYXRlLnBhcnNlKHJlbW90ZT8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIpfHwwOwogICAgbGV0IG1lcmdlZE1ldGVycztpZihyZW1vdGVNZXRlclRpbWU+bG9jYWxNZXRlclRpbWUpbWVyZ2VkTWV0ZXJzPXJlbW90ZS5tZXRlclJlYWRpbmdzfHxbXTtlbHNlIGlmKGxvY2FsTWV0ZXJUaW1lPnJlbW90ZU1ldGVyVGltZSltZXJnZWRNZXRlcnM9bG9jYWwubWV0ZXJSZWFkaW5nc3x8W107ZWxzZSBtZXJnZWRNZXRlcnM9KHJlbW90ZT8ubWV0ZXJSZWFkaW5ncz8ubGVuZ3RofHwwKT49KGxvY2FsPy5tZXRlclJlYWRpbmdzPy5sZW5ndGh8fDApP3JlbW90ZS5tZXRlclJlYWRpbmdzfHxbXTpsb2NhbC5tZXRlclJlYWRpbmdzfHxbXTsKICAgIGNvbnN0IGxvY2FsTGl2ZT1EYXRlLnBhcnNlKGxvY2FsPy5vc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpfHwwLHJlbW90ZUxpdmU9RGF0ZS5wYXJzZShyZW1vdGU/Lm9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0fHwiIil8fDA7CiAgICByZXR1cm4ge3NjaGVtYTpTWU5DX1BBWUxPQURfU0NIRU1BLHBheWxvYWRWZXJzaW9uOiI2LjMuNCIsYXBwOiJFbGRlaG9mIixzY29wZToiZnVsbCIscmVjb3JkczpzYW5pdGl6ZVJlY29yZHMoc3luY01lcmdlQnlLZXkobG9jYWw/LnJlY29yZHMscmVtb3RlPy5yZWNvcmRzLCJtb250aCIpKSx2YWlsbGFudE1vbnRoczpzeW5jTWVyZ2VCeUtleShsb2NhbD8udmFpbGxhbnRNb250aHMscmVtb3RlPy52YWlsbGFudE1vbnRocywibW9udGgiKSxjbGltYXRlTW9udGhzOmNsaW1hdGVTYW5pdGl6ZShzeW5jTWVyZ2VCeUtleShsb2NhbD8uY2xpbWF0ZU1vbnRocyxyZW1vdGU/LmNsaW1hdGVNb250aHMsIm1vbnRoIikpLG1ldGVyUmVhZGluZ3M6c2FuaXRpemVNZXRlclJlYWRpbmdzKG1lcmdlZE1ldGVycyksbWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdDpyZW1vdGVNZXRlclRpbWU+bG9jYWxNZXRlclRpbWU/cmVtb3RlLm1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6bG9jYWwubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdCxvc3Ryb21MaXZlOnJlbW90ZUxpdmU+PWxvY2FsTGl2ZT9yZW1vdGU/Lm9zdHJvbUxpdmV8fG51bGw6bG9jYWw/Lm9zdHJvbUxpdmV8fG51bGwsb3N0cm9tUHJpY2VTdGF0czpzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdHMoc3luY01lcmdlQnlLZXkobG9jYWw/Lm9zdHJvbVByaWNlU3RhdHMscmVtb3RlPy5vc3Ryb21QcmljZVN0YXRzLCJtb250aCIpKSxleHBvcnRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxzb3VyY2VEZXZpY2VJZDpzeW5jU3RhdGUuZGV2aWNlSWQsc291cmNlRGV2aWNlTmFtZTpzeW5jU3RhdGUuZGV2aWNlTmFtZX07CiAgfQogIGZ1bmN0aW9uIHN5bmNDb21wYXJhYmxlKHBheWxvYWQpe3JldHVybiBKU09OLnN0cmluZ2lmeSh7cmVjb3JkczpzYW5pdGl6ZVJlY29yZHMocGF5bG9hZD8ucmVjb3Jkc3x8W10pLHZhaWxsYW50TW9udGhzOnBheWxvYWQ/LnZhaWxsYW50TW9udGhzfHxbXSxjbGltYXRlTW9udGhzOmNsaW1hdGVTYW5pdGl6ZShwYXlsb2FkPy5jbGltYXRlTW9udGhzfHxbXSksbWV0ZXJSZWFkaW5nczpzYW5pdGl6ZU1ldGVyUmVhZGluZ3MocGF5bG9hZD8ubWV0ZXJSZWFkaW5nc3x8W10pLG1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6cGF5bG9hZD8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIsb3N0cm9tTGl2ZTpwYXlsb2FkPy5vc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHBheWxvYWQ/Lm9zdHJvbVByaWNlU3RhdHN8fFtdKX0pO30KICBmdW5jdGlvbiBzeW5jQXBwbHlQYXlsb2FkKHBheWxvYWQpe3N5bmNBcHBseWluZz10cnVlO3RyeXtzYXZlUmVjb3JkcyhwYXlsb2FkLnJlY29yZHN8fFtdLHtyZWFzb246IkdlcsOkdGUtU3luYyIsYWxsb3dFbXB0eTp0cnVlfSk7dmFpbGxhbnRNb250aHM9QXJyYXkuaXNBcnJheShwYXlsb2FkLnZhaWxsYW50TW9udGhzKT9wYXlsb2FkLnZhaWxsYW50TW9udGhzOltdO3NhdmVWYWlsbGFudE1vbnRocygpO3NhdmVDbGltYXRlTW9udGhzKHBheWxvYWQuY2xpbWF0ZU1vbnRoc3x8W10pO3NhdmVNZXRlclJlYWRpbmdzKHBheWxvYWQubWV0ZXJSZWFkaW5nc3x8W10se3RvdWNoOmZhbHNlfSk7aWYocGF5bG9hZC5tZXRlclJlYWRpbmdzVXBkYXRlZEF0KWxvY2FsU3RvcmFnZS5zZXRJdGVtKE1FVEVSX01FVEFfS0VZLHBheWxvYWQubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdCk7c2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQub3N0cm9tTGl2ZXx8bnVsbCk7c2F2ZU9zdHJvbVByaWNlU3RhdHMocGF5bG9hZC5vc3Ryb21QcmljZVN0YXRzfHxbXSk7fWZpbmFsbHl7c3luY0FwcGx5aW5nPWZhbHNlO31yZW5kZXJBbGwoKTt9CiAgZnVuY3Rpb24gc2NoZWR1bGVDbG91ZFN5bmMoZGVsYXk9OTAwKXtjbGVhclRpbWVvdXQoc3luY0RlYm91bmNlVGltZXIpO2lmKCFzeW5jU3RhdGUuY29uZmlndXJlZHx8c3luY0FwcGx5aW5nKXJldHVybjtzeW5jRGVib3VuY2VUaW1lcj1zZXRUaW1lb3V0KCgpPT57aWYoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlIT09ImhpZGRlbiImJm5hdmlnYXRvci5vbkxpbmUhPT1mYWxzZSlzeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pO30sZGVsYXkpO30KICBmdW5jdGlvbiBzY2hlZHVsZVN5bmNQb2xsKCl7Y2xlYXJJbnRlcnZhbChzeW5jUG9sbFRpbWVyKTtzeW5jUG9sbFRpbWVyPW51bGw7aWYoIXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjtzeW5jUG9sbFRpbWVyPXNldEludGVydmFsKCgpPT57aWYoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlPT09InZpc2libGUiJiZuYXZpZ2F0b3Iub25MaW5lIT09ZmFsc2Upc3luY05vdyh7c2lsZW50OnRydWV9KTt9LDYwKjEwMDApO30KICBhc3luYyBmdW5jdGlvbiBjcmVhdGVTeW5jVmF1bHQoKXtpZihzeW5jQnVzeSlyZXR1cm47Y29uc3QgZGV2aWNlTmFtZT1TdHJpbmcoJCgic3luY0NyZWF0ZURldmljZU5hbWUiKS52YWx1ZXx8IiIpLnRyaW0oKTtpZihkZXZpY2VOYW1lLmxlbmd0aDwyKXt0b2FzdCgiR2Vyw6R0ZW5hbWVuIGVpbmdlYmVuIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtzeW5jU3RhdGU9e2NvbmZpZ3VyZWQ6dHJ1ZSx2YXVsdElkOnN5bmNHZW5lcmF0ZUlkKCJ2YXVsdCIsMTgpLGRldmljZUlkOnN5bmNHZW5lcmF0ZUlkKCJkZXZpY2UiLDE2KSxkZXZpY2VOYW1lLGRldmljZVRva2VuOnN5bmNHZW5lcmF0ZUlkKCJ0b2tlbiIsMzIpLHJlY292ZXJ5S2V5OnN5bmNHZW5lcmF0ZVJlY292ZXJ5S2V5KCkscm9sZToiYWRtaW4iLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtjb25zdCBzbmFwc2hvdD1zeW5jQ3VycmVudFBheWxvYWQoKTtjb25zdCBlbnZlbG9wZT1hd2FpdCBzeW5jRW5jcnlwdChzbmFwc2hvdCk7Y29uc3QgcmVzdWx0PWF3YWl0IHN5bmNBcGkoInZhdWx0L2NyZWF0ZSIse3ZhdWx0SWQ6c3luY1N0YXRlLnZhdWx0SWQsZGV2aWNlSWQ6c3luY1N0YXRlLmRldmljZUlkLGRldmljZU5hbWUsZGV2aWNlVG9rZW46c3luY1N0YXRlLmRldmljZVRva2VuLHNjb3BlOiJmdWxsIixlbnZlbG9wZX0pO3N5bmNTdGF0ZS5zZXJ2ZXJSZXZpc2lvbj1yZXN1bHQucmV2aXNpb247c3luY1N0YXRlLmxhc3RTeW5jQXQ9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO3NhdmVTeW5jU3RhdGUoKTtzY2hlZHVsZVN5bmNQb2xsKCk7cmVuZGVyQWxsKCk7dG9hc3QoIkdlcsOkdGUtU3luYyBlaW5nZXJpY2h0ZXQiKTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZT1sb2FkU3luY1N0YXRlKCk7c3luY1N0YXRlLmxhc3RFcnJvcj1lcnJvci5tZXNzYWdlO3NhdmVTeW5jU3RhdGUoKTthbGVydChgR2Vyw6R0ZS1TeW5jIGtvbm50ZSBuaWNodCBlaW5nZXJpY2h0ZXQgd2VyZGVuOiAke2Vycm9yLm1lc3NhZ2V9YCk7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBhc3luYyBmdW5jdGlvbiBjcmVhdGVTeW5jUGFpcmluZygpe2lmKHN5bmNCdXN5fHwhc3luY1N0YXRlLmNvbmZpZ3VyZWQpcmV0dXJuO2lmKHN5bmNTdGF0ZS5yb2xlIT09ImFkbWluIil7dG9hc3QoIk51ciBkYXMgZXJzdGUgVmVyd2FsdHVuZ3NnZXLDpHQga2FubiBuZXVlIEdlcsOkdGUga29wcGVsbiIpO3JldHVybjt9c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7Y29uc3QgcmVzdWx0PWF3YWl0IHN5bmNBcGkoInBhaXIvY3JlYXRlIixzeW5jQXV0aCh7c2NvcGU6ImZ1bGwifSkpOyQoInN5bmNQYWlyVmF1bHQiKS50ZXh0Q29udGVudD1zeW5jU3RhdGUudmF1bHRJZDskKCJzeW5jUGFpckNvZGUiKS50ZXh0Q29udGVudD1yZXN1bHQuY29kZTskKCJzeW5jUGFpclJlY292ZXJ5IikudGV4dENvbnRlbnQ9c3luY1JlY292ZXJ5Rm9ybWF0KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSk7JCgic3luY1BhaXJFeHBpcnkiKS50ZXh0Q29udGVudD1gQ29kZSBnw7xsdGlnIGJpcyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUocmVzdWx0LmV4cGlyZXNBdCkpfWA7JCgic3luY1BhaXJSZXN1bHQiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTt9Y2F0Y2goZXJyb3Ipe3RvYXN0KGVycm9yLm1lc3NhZ2UpO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gam9pblN5bmNWYXVsdCgpe2lmKHN5bmNCdXN5KXJldHVybjtjb25zdCB2YXVsdElkPVN0cmluZygkKCJzeW5jSm9pblZhdWx0SWQiKS52YWx1ZXx8IiIpLnRyaW0oKSxjb2RlPVN0cmluZygkKCJzeW5jSm9pbkNvZGUiKS52YWx1ZXx8IiIpLnRyaW0oKSxyZWNvdmVyeUtleT1zeW5jUmVjb3ZlcnlOb3JtYWxpemUoJCgic3luY0pvaW5SZWNvdmVyeSIpLnZhbHVlKSxkZXZpY2VOYW1lPVN0cmluZygkKCJzeW5jSm9pbkRldmljZU5hbWUiKS52YWx1ZXx8IiIpLnRyaW0oKTtpZighdmF1bHRJZHx8IWNvZGV8fHJlY292ZXJ5S2V5Lmxlbmd0aCE9PTY0fHxkZXZpY2VOYW1lLmxlbmd0aDwyKXt0b2FzdCgiS29wcGx1bmdzZGF0ZW4gdm9sbHN0w6RuZGlnIGVpbmdlYmVuIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3RyeXtjb25zdCBkZXZpY2VJZD1zeW5jR2VuZXJhdGVJZCgiZGV2aWNlIiwxNiksZGV2aWNlVG9rZW49c3luY0dlbmVyYXRlSWQoInRva2VuIiwzMik7Y29uc3QgY2xhaW09YXdhaXQgc3luY0FwaSgicGFpci9jbGFpbSIse3ZhdWx0SWQsY29kZSxkZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VufSk7c3luY1N0YXRlPXtjb25maWd1cmVkOnRydWUsdmF1bHRJZCxkZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VuLHJlY292ZXJ5S2V5LHJvbGU6Y2xhaW0ucm9sZXx8Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOjAsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6IiJ9O3NhdmVTeW5jU3RhdGUoKTtjb25zdCByZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSk7Y29uc3QgcmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUpO2NvbnN0IG1lcmdlZD1zeW5jTWVyZ2VQYXlsb2FkKHN5bmNDdXJyZW50UGF5bG9hZCgpLHJlbW90ZVBheWxvYWQpO3N5bmNBcHBseVBheWxvYWQobWVyZ2VkKTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cmVtb3RlLnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7aWYoc3luY0NvbXBhcmFibGUobWVyZ2VkKSE9PXN5bmNDb21wYXJhYmxlKHJlbW90ZVBheWxvYWQpKXtjb25zdCBlbnZlbG9wZT1hd2FpdCBzeW5jRW5jcnlwdChtZXJnZWQpO2NvbnN0IHB1c2hlZD1hd2FpdCBzeW5jQXBpKCJzbmFwc2hvdC9wdXNoIixzeW5jQXV0aCh7YmFzZVJldmlzaW9uOnJlbW90ZS5yZXZpc2lvbixlbnZlbG9wZX0pKTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cHVzaGVkLnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7fXNjaGVkdWxlU3luY1BvbGwoKTtyZW5kZXJBbGwoKTt0b2FzdCgiR2Vyw6R0IGdla29wcGVsdCB1bmQgYWt0dWFsaXNpZXJ0Iik7fWNhdGNoKGVycm9yKXtzeW5jU3RhdGU9e2NvbmZpZ3VyZWQ6ZmFsc2UsdmF1bHRJZDoiIixkZXZpY2VJZDoiIixkZXZpY2VOYW1lOiIiLGRldmljZVRva2VuOiIiLHJlY292ZXJ5S2V5OiIiLHJvbGU6Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOjAsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6ZXJyb3IubWVzc2FnZX07c2F2ZVN5bmNTdGF0ZSgpO2FsZXJ0KGBLb3BwbHVuZyBmZWhsZ2VzY2hsYWdlbjogJHtlcnJvci5tZXNzYWdlfWApO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gc3luY05vdyh7c2lsZW50PWZhbHNlLHJldHJ5PXRydWV9PXt9KXtpZihzeW5jQnVzeXx8IXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybiBmYWxzZTtzeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtjb25zdCByZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSk7Y29uc3QgcmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUpO2NvbnN0IGxvY2FsUGF5bG9hZD1zeW5jQ3VycmVudFBheWxvYWQoKTtjb25zdCBtZXJnZWQ9c3luY01lcmdlUGF5bG9hZChsb2NhbFBheWxvYWQscmVtb3RlUGF5bG9hZCk7c3luY0FwcGx5UGF5bG9hZChtZXJnZWQpO2xldCByZXZpc2lvbj1yZW1vdGUucmV2aXNpb247aWYoc3luY0NvbXBhcmFibGUobWVyZ2VkKSE9PXN5bmNDb21wYXJhYmxlKHJlbW90ZVBheWxvYWQpKXt0cnl7Y29uc3QgZW52ZWxvcGU9YXdhaXQgc3luY0VuY3J5cHQobWVyZ2VkKTtjb25zdCBwdXNoZWQ9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVzaCIsc3luY0F1dGgoe2Jhc2VSZXZpc2lvbjpyZW1vdGUucmV2aXNpb24sZW52ZWxvcGV9KSk7cmV2aXNpb249cHVzaGVkLnJldmlzaW9uO31jYXRjaChlcnJvcil7aWYoZXJyb3Iuc3RhdHVzPT09NDA5JiZyZXRyeSl7c3luY0J1c3k9ZmFsc2U7cmV0dXJuIGF3YWl0IHN5bmNOb3coe3NpbGVudCxyZXRyeTpmYWxzZX0pO310aHJvdyBlcnJvcjt9fXN5bmNTdGF0ZS5zZXJ2ZXJSZXZpc2lvbj1yZXZpc2lvbjtzeW5jU3RhdGUubGFzdFN5bmNBdD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7c3luY1N0YXRlLmxhc3RFcnJvcj0iIjtzYXZlU3luY1N0YXRlKCk7aWYoIXNpbGVudCl0b2FzdCgiQWxsZSBHZXLDpHRlIGF1ZiBha3R1ZWxsZW0gU3RhbmQiKTtyZXR1cm4gdHJ1ZTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZS5sYXN0RXJyb3I9ZXJyb3IubWVzc2FnZTtzYXZlU3luY1N0YXRlKCk7aWYoIXNpbGVudCl0b2FzdChgU3luYzogJHtlcnJvci5tZXNzYWdlfWApO3JldHVybiBmYWxzZTt9ZmluYWxseXtzeW5jQnVzeT1mYWxzZTtyZW5kZXJTeW5jUGFuZWwoKTt9fQogIGZ1bmN0aW9uIGRpc2Nvbm5lY3RTeW5jKCl7aWYoIWNvbmZpcm0oIkRpZXNlcyBHZXLDpHQgbG9rYWwgdm9tIEVsZGVob2YtU3luYyB0cmVubmVuPyBEaWUgRGF0ZW4gYXVmIGRlbSBHZXLDpHQgYmxlaWJlbiBlcmhhbHRlbi4iKSlyZXR1cm47c3luY1N0YXRlPXtjb25maWd1cmVkOmZhbHNlLHZhdWx0SWQ6IiIsZGV2aWNlSWQ6IiIsZGV2aWNlTmFtZToiIixkZXZpY2VUb2tlbjoiIixyZWNvdmVyeUtleToiIixyb2xlOiJtZW1iZXIiLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtzYXZlU3luY1N0YXRlKCk7c2NoZWR1bGVTeW5jUG9sbCgpO3JlbmRlclN5bmNQYW5lbCgpO3RvYXN0KCJHZXLDpHQgdm9tIFN5bmMgZ2V0cmVubnQiKTt9CiAgZnVuY3Rpb24gcmVuZGVyU3luY1BhbmVsKCl7aWYoISQoInN5bmNQYW5lbCIpKXJldHVybjskKCJzeW5jU2V0dXBCb3giKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHN5bmNTdGF0ZS5jb25maWd1cmVkKTskKCJzeW5jQWN0aXZlQm94IikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc3luY1N0YXRlLmNvbmZpZ3VyZWQpO2NvbnN0IGJhZGdlPSQoInN5bmNCYWRnZSIpO2JhZGdlLmNsYXNzTmFtZT1gc3luYy1iYWRnZSAke3N5bmNCdXN5PyJidXN5IjpzeW5jU3RhdGUubGFzdEVycm9yPyJlcnJvciI6c3luY1N0YXRlLmNvbmZpZ3VyZWQ/Im9rIjoiIn1gO2JhZGdlLnRleHRDb250ZW50PXN5bmNCdXN5PyJzeW5jaHJvbmlzaWVydCDigKYiOnN5bmNTdGF0ZS5sYXN0RXJyb3I/IkZlaGxlciI6c3luY1N0YXRlLmNvbmZpZ3VyZWQ/InZlcmJ1bmRlbiI6Im5pY2h0IGVpbmdlcmljaHRldCI7aWYoIXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjskKCJzeW5jRGV2aWNlVGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5kZXZpY2VOYW1lfHwiZGllc2VzIEdlcsOkdCI7JCgic3luY1JvbGVUZXh0IikudGV4dENvbnRlbnQ9c3luY1N0YXRlLnJvbGU9PT0iYWRtaW4iPyJWZXJ3YWx0dW5nc2dlcsOkdCI6Imdla29wcGVsdGVzIEdlcsOkdCI7JCgic3luY1JldmlzaW9uVGV4dCIpLnRleHRDb250ZW50PVN0cmluZyhzeW5jU3RhdGUuc2VydmVyUmV2aXNpb258fDApOyQoInN5bmNMYXN0VGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5sYXN0U3luY0F0P2B6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUoc3luY1N0YXRlLmxhc3RTeW5jQXQpfWA6Im5vY2ggbmllIjskKCJzeW5jU3RhdHVzIikudGV4dENvbnRlbnQ9c3luY1N0YXRlLmxhc3RFcnJvcj9gTGV0enRlciBGZWhsZXI6ICR7c3luY1N0YXRlLmxhc3RFcnJvcn1gOiLDhG5kZXJ1bmdlbiB3ZXJkZW4gYXV0b21hdGlzY2ggYWJnZWdsaWNoZW4uIjskKCJzeW5jU3RhdHVzIikuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke3N5bmNTdGF0ZS5sYXN0RXJyb3I/ImVycm9yIjoib2sifWA7JCgic3luY1BhaXJCdG4iKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHN5bmNTdGF0ZS5yb2xlIT09ImFkbWluIik7fQoKICBmdW5jdGlvbiBzYXZlQ29zdFNldHRpbmdzKCl7IHNldHRpbmdzLmZhbGxiYWNrUHJpY2U9TWF0aC5tYXgoMCxOdW1iZXIoJCgiZmFsbGJhY2tQcmljZUlucHV0IikudmFsdWUpfHwwKTtzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZT1NYXRoLm1heCgwLE51bWJlcigkKCJkZWZhdWx0QmFzZUZlZUlucHV0IikudmFsdWUpfHwwKTtzYXZlU2V0dGluZ3MoKTtzY2hlZHVsZUNsb3VkU3luYygpO3JlbmRlckFsbCgpO3RvYXN0KCJLb3N0ZW4tRWluc3RlbGx1bmdlbiBnZXNwZWljaGVydCIpOyB9CgogIGZ1bmN0aW9uIHJlbmRlckFsbCgpeyB1cGRhdGVSZWNvdmVyeUJhbm5lcigpO3JlbmRlckRhc2hib2FyZCgpO3JlbmRlclJlY29yZHMoKTtyZW5kZXJBbmFseXNpcygpO3JlbmRlckRhdGEoKTsgfQogIGZ1bmN0aW9uIHJlc2l6ZUNoYXJ0cygpeyBjbGVhclRpbWVvdXQocmVzaXplVGltZXIpO3Jlc2l6ZVRpbWVyPXNldFRpbWVvdXQoKCk9PnsgaWYoY3VycmVudFZpZXc9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7IGlmKGN1cnJlbnRWaWV3PT09ImFuYWx5c2lzVmlldyIpcmVuZGVyQW5hbHlzaXMoKTsgfSwxMDApOyB9CgogIGZ1bmN0aW9uIGJpbmQoKXsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixldmVudD0+ewogICAgICBjb25zdCBuYXY9ZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLW5hdl0iKTsgaWYobmF2KXtzd2l0Y2hWaWV3KG5hdi5kYXRhc2V0Lm5hdik7cmV0dXJuO30KICAgICAgY29uc3QgZWRpdD1ldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtZWRpdC1tb250aF0iKTsgaWYoZWRpdCl7b3BlblJlY29yZE1vZGFsKGVkaXQuZGF0YXNldC5lZGl0TW9udGgpO3JldHVybjt9CiAgICAgIGlmKGV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWxdIikpe2Nsb3NlUmVjb3JkTW9kYWwoKTtyZXR1cm47fQogICAgICBpZihldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtY2xvc2UtbWV0ZXItbW9kYWxdIikpe2Nsb3NlTWV0ZXJNb2RhbCgpO3JldHVybjt9CiAgICB9KTsKICAgICQoImRhc2hib2FyZEFkZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZFJlY29yZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZE1ldGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLG9wZW5NZXRlck1vZGFsKTsKICAgICQoImVkaXRMYXRlc3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pm9wZW5SZWNvcmRNb2RhbCgkKCJlZGl0TGF0ZXN0QnRuIikuZGF0YXNldC5tb250aCkpOwogICAgJCgicmVjb3JkRm9ybSIpLmFkZEV2ZW50TGlzdGVuZXIoInN1Ym1pdCIsc2F2ZUVkaXRlZFJlY29yZCk7IFsicmVjb3JkVG90YWwiLCJyZWNvcmRIZWF0UHVtcCIsInJlY29yZEFubmV4Il0uZm9yRWFjaChpZD0+JChpZCkuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLHVwZGF0ZURlcml2ZWRQcmV2aWV3KSk7CiAgICAkKCJtZXRlckZvcm0iKS5hZGRFdmVudExpc3RlbmVyKCJzdWJtaXQiLHNhdmVNZXRlclJlYWRpbmdGcm9tRm9ybSk7IFsibWV0ZXJEYXRlIiwibWV0ZXJUb3RhbCIsIm1ldGVyQW5uZXgiXS5mb3JFYWNoKGlkPT4kKGlkKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsdXBkYXRlTWV0ZXJQcmV2aWV3KSk7CiAgICAkKCJ1bmRvTGF0ZXN0TWV0ZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsdW5kb0xhdGVzdE1ldGVyUmVhZGluZyk7CiAgICAkKCJyZWNvcmRZZWFyRmlsdGVyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJSZWNvcmRzKTsgJCgiYW5hbHlzaXNZZWFyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJBbmFseXNpcyk7CiAgICAkKCJyZXN0b3JlU2hhZG93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHJlc3RvcmVTaGFkb3cpOyAkKCJleHBvcnRCYWNrdXBCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXhwb3J0QmFja3VwKTsgJCgiZXhwb3J0Q3N2QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV4cG9ydENzdik7ICQoImltcG9ydEJhY2t1cElucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+e2NvbnN0IGY9JCgiaW1wb3J0QmFja3VwSW5wdXQiKS5maWxlcz8uWzBdO2lmKGYpaW1wb3J0QmFja3VwKGYpO30pOwogICAgJCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+aW1wb3J0VmFpbGxhbnRDc3ZGaWxlcygkKCJ2YWlsbGFudENzdkZpbGVzSW5wdXQiKS5maWxlcykpOwogICAgJCgic2F2ZU9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQW5kQ2hlY2tPc3Ryb20pOyAkKCJkaXNjb25uZWN0T3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGRpc2Nvbm5lY3RPc3Ryb20pOyAkKCJyZWZyZXNoT3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5yZWZyZXNoT3N0cm9tKHRydWUpKTsgJCgicmVmcmVzaE9zdHJvbUhpc3RvcnlCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PnJlZnJlc2hPc3Ryb21IaXN0b3J5KCkpOyAkKCJyZWZyZXNoT3N0cm9tUHJpY2VTdGF0c0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+cmVmcmVzaE9zdHJvbVByaWNlU3RhdHMoTnVtYmVyKCQoImFuYWx5c2lzWWVhciIpLnZhbHVlKXx8bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpKSk7ICQoImdvT3N0cm9tU2V0dGluZ3NCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pntzd2l0Y2hWaWV3KCJkYXRhVmlldyIpO3NldFRpbWVvdXQoKCk9PiQoIm9zdHJvbVNldHRpbmdzUGFuZWwiKS5zY3JvbGxJbnRvVmlldyh7YmVoYXZpb3I6InNtb290aCIsYmxvY2s6InN0YXJ0In0pLDEwMCk7fSk7CiAgICAkKCJzeW5jQ3JlYXRlQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGNyZWF0ZVN5bmNWYXVsdCk7ICQoInN5bmNKb2luQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGpvaW5TeW5jVmF1bHQpOyAkKCJzeW5jTm93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5zeW5jTm93KHtzaWxlbnQ6ZmFsc2V9KSk7ICQoInN5bmNQYWlyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGNyZWF0ZVN5bmNQYWlyaW5nKTsgJCgic3luY0Rpc2Nvbm5lY3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZGlzY29ubmVjdFN5bmMpOwogICAgJCgic2F2ZUNvc3RTZXR0aW5nc0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQ29zdFNldHRpbmdzKTsKICAgICQoImxvYWRDbGltYXRlV2VhdGhlckJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixsb2FkQ2xpbWF0ZVdlYXRoZXIpOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVdlYXRoZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsbG9hZENsaW1hdGVXZWF0aGVyKTsKICAgICQoImRhc2hib2FyZENsaW1hdGVEZXRhaWxzQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT57c3dpdGNoVmlldygiYW5hbHlzaXNWaWV3Iik7c2V0VGltZW91dCgoKT0+JCgiY2xpbWF0ZUFuYWx5c2lzUGFuZWwiKS5zY3JvbGxJbnRvVmlldyh7YmVoYXZpb3I6InNtb290aCIsYmxvY2s6InN0YXJ0In0pLDcwKTt9KTsKICAgICQoImRhc2hib2FyZENsaW1hdGVNb250aEJ1dHRvbnMiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXZlbnQ9Pntjb25zdCBiPWV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1jbGltYXRlLW1vbnRoXSIpO2lmKCFiKXJldHVybjtkYXNoYm9hcmRDbGltYXRlU2VsZWN0ZWRNb250aD0ibW9udGgtIitTdHJpbmcoYi5kYXRhc2V0LmNsaW1hdGVNb250aCkucGFkU3RhcnQoMiwiMCIpO3JlbmRlckRhc2hib2FyZENsaW1hdGUoKTt9KTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWNsaW1hdGUtcGVyaW9kXSIpLmZvckVhY2goYnRuPT5idG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT57ZGFzaGJvYXJkQ2xpbWF0ZVBlcmlvZD1idG4uZGF0YXNldC5jbGltYXRlUGVyaW9kO2Rhc2hib2FyZENsaW1hdGVTZWxlY3RlZE1vbnRoPW51bGw7cmVuZGVyRGFzaGJvYXJkQ2xpbWF0ZSgpO30pKTsKICAgIFsiZGFzaGJvYXJkQ2xpbWF0ZVRlbXBlcmF0dXJlQ2hhcnQiLCJkYXNoYm9hcmRDbGltYXRlRWxlY3RyaWNDaGFydCJdLmZvckVhY2goaWQ9PiQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixldmVudD0+ewogICAgICBjb25zdCBjYW52YXM9ZXZlbnQuY3VycmVudFRhcmdldCxyZWN0PWNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSx3aWR0aD1NYXRoLm1heCgyODAsTWF0aC5yb3VuZChyZWN0LndpZHRofHw2MDApKSxtb250aHM9ZGFzaGJvYXJkQ29tcGFyaXNvbk1vbnRocygpOwogICAgICBjb25zdCBpbmRleD1NYXRoLmZsb29yKChldmVudC5jbGllbnRYLXJlY3QubGVmdC00NykvKHdpZHRoLTQ3LTEwKSptb250aHMubGVuZ3RoKTsKICAgICAgaWYoaW5kZXg+PTAmJmluZGV4PG1vbnRocy5sZW5ndGgpe2Rhc2hib2FyZENsaW1hdGVTZWxlY3RlZE1vbnRoPSJtb250aC0iK1N0cmluZyhtb250aHNbaW5kZXhdKS5wYWRTdGFydCgyLCIwIik7cmVuZGVyRGFzaGJvYXJkQ2xpbWF0ZSgpO30KICAgIH0pKTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJyZXNpemUiLHJlc2l6ZUNoYXJ0cyk7IGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoInZpc2liaWxpdHljaGFuZ2UiLCgpPT57aWYoZG9jdW1lbnQuaGlkZGVuKXJldHVybjtpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe2NvbnN0IGFnZT1EYXRlLm5vdygpLURhdGUucGFyc2Uob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKTtpZighTnVtYmVyLmlzRmluaXRlKGFnZSl8fGFnZT4xMCo2MGUzKXJlZnJlc2hPc3Ryb20oZmFsc2UpO31pZihzeW5jU3RhdGUuY29uZmlndXJlZClzeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pO30pOwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsZXZlbnQ9PntpZihldmVudC5rZXkhPT0iRXNjYXBlIilyZXR1cm47aWYoISQoInJlY29yZE1vZGFsIikuY2xhc3NMaXN0LmNvbnRhaW5zKCJoaWRkZW4iKSljbG9zZVJlY29yZE1vZGFsKCk7ZWxzZSBpZighJCgibWV0ZXJNb2RhbCIpLmNsYXNzTGlzdC5jb250YWlucygiaGlkZGVuIikpY2xvc2VNZXRlck1vZGFsKCk7fSk7CiAgfQoKICBmdW5jdGlvbiBpbml0KCl7CiAgICBhcHBseUhpc3RvcmljYWxTZWVkKCk7ZW5zdXJlTWV0ZXJCYXNlbGluZSgpOwogICAgYmluZCgpO3JlbmRlckFsbCgpO3NjaGVkdWxlT3N0cm9tKCk7c2NoZWR1bGVTeW5jUG9sbCgpOwogICAgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXsgY29uc3QgYWdlPURhdGUubm93KCktRGF0ZS5wYXJzZShvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpOyBpZighb3N0cm9tTGl2ZXx8IU51bWJlci5pc0Zpbml0ZShhZ2UpfHxhZ2U+MTAqNjBlMylyZWZyZXNoT3N0cm9tKGZhbHNlKTsgc2V0VGltZW91dCgoKT0+cmVmcmVzaE9zdHJvbUhpc3Rvcnkoe3NpbGVudDp0cnVlLG9ubHlNaXNzaW5nOnRydWUsbWF4TW9udGhzOjJ9KSw0MjAwKTsgfQogICAgaWYoc3luY1N0YXRlLmNvbmZpZ3VyZWQpc2V0VGltZW91dCgoKT0+c3luY05vdyh7c2lsZW50OnRydWV9KSw2NTApOwogICAgaWYoInNlcnZpY2VXb3JrZXIiIGluIG5hdmlnYXRvcil3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigibG9hZCIsKCk9Pm5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLnJlZ2lzdGVyKCJzdy5qcz92PTYuMy40IikuY2F0Y2goKCk9Pnt9KSk7CiAgICBjb25zb2xlLmluZm8oYEVsZGVob2YgJHtBUFBfQlVJTER9YCk7CiAgfQogIGluaXQoKTsKfSkoKTsK","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/sw.js":{"body":"Y29uc3QgQ0FDSEU9ImVsZGVob2YtdjYtMy00LXdlYXRoZXItaGVhdC1wb3dlci0yMDI2MTAzMSI7CmNvbnN0IENPUkU9WyIuLyIsIi4vP3Y9Ni4zLjQiLCIuL2luZGV4Lmh0bWwiLCIuL3N0eWxlcy5jc3M/dj02LjMuNCIsIi4vYXBwLmpzP3Y9Ni4zLjQiLCIuL21hbmlmZXN0LndlYm1hbmlmZXN0IiwiLi9pY29uLTE5Mi5wbmciLCIuL2ljb24tNTEyLnBuZyJdOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImluc3RhbGwiLGV2ZW50PT57ZXZlbnQud2FpdFVudGlsKGNhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMuYWRkQWxsKENPUkUpKS50aGVuKCgpPT5zZWxmLnNraXBXYWl0aW5nKCkpKX0pOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImFjdGl2YXRlIixldmVudD0+e2V2ZW50LndhaXRVbnRpbChjYWNoZXMua2V5cygpLnRoZW4oa2V5cz0+UHJvbWlzZS5hbGwoa2V5cy5maWx0ZXIoaz0+ayE9PUNBQ0hFKS5tYXAoaz0+Y2FjaGVzLmRlbGV0ZShrKSkpKS50aGVuKCgpPT5zZWxmLmNsaWVudHMuY2xhaW0oKSkpfSk7CnNlbGYuYWRkRXZlbnRMaXN0ZW5lcigiZmV0Y2giLGV2ZW50PT57CiAgY29uc3QgdXJsPW5ldyBVUkwoZXZlbnQucmVxdWVzdC51cmwpOwogIGlmKGV2ZW50LnJlcXVlc3QubWV0aG9kIT09IkdFVCJ8fHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCIvYXBpLyIpKXJldHVybjsKICBldmVudC5yZXNwb25kV2l0aChmZXRjaChldmVudC5yZXF1ZXN0KS50aGVuKHJlc3BvbnNlPT57Y29uc3QgY29weT1yZXNwb25zZS5jbG9uZSgpO2NhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMucHV0KGV2ZW50LnJlcXVlc3QsY29weSkpO3JldHVybiByZXNwb25zZTt9KS5jYXRjaCgoKT0+Y2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4oY2FjaGVkPT5jYWNoZWR8fGNhY2hlcy5tYXRjaCgiLi9pbmRleC5odG1sIikpKSk7Cn0pOwo=","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/manifest.webmanifest":{"body":"ewogICJuYW1lIjogIkVsZGVob2YgNi4yLjEg4oCTIFZlcmJyYXVjaHNidWNoIiwKICAic2hvcnRfbmFtZSI6ICJFbGRlaG9mIiwKICAiZGVzY3JpcHRpb24iOiAiU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4g4oCTIG1pdCBrb21wYWt0ZXIgT3N0cm9tLVByZWlzw7xiZXJzaWNodC4iLAogICJzdGFydF91cmwiOiAiLi8/dj02LjIuMSIsCiAgInNjb3BlIjogIi4vIiwKICAiZGlzcGxheSI6ICJzdGFuZGFsb25lIiwKICAib3JpZW50YXRpb24iOiAicG9ydHJhaXQtcHJpbWFyeSIsCiAgImJhY2tncm91bmRfY29sb3IiOiAiIzA2MTAxYyIsCiAgInRoZW1lX2NvbG9yIjogIiMwNzExMWYiLAogICJpY29ucyI6IFsKICAgIHsic3JjIjoiaWNvbi0xOTIucG5nIiwic2l6ZXMiOiIxOTJ4MTkyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifSwKICAgIHsic3JjIjoiaWNvbi01MTIucG5nIiwic2l6ZXMiOiI1MTJ4NTEyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifQogIF0KfQo=","type":"application/manifest+json; charset=utf-8","cache":"no-cache"},"/icon-192.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFk0lEQVR42u3du24TQRiG4fVoBShpkKJ0hi6iTEqKKAURJbdASZcqN5AbSJWOkkuAEoUiSkFLSW/RWC6RKFxQWFrlZO96ZnbmP7xfGeWwh8ffzOx6ncnOwVFDbGU5XxT7W4HDbS/t/h6AiI4AiBICEKGBiNISAhCGAEQYwojSEgIQARCpV0IAIgAi9UoIQARApF4JAYgAiNQrIQARABEAEaWjGIAIgEi9EgIQSeOobotPLqe2T8nN+UzR1k7kPxdmXkwVTLmeHZMLaJ2b27OZYTHHV9MykiwDekzHNpqtPOWSZBPQXTpu0QyRlIVRFkNSAEEnQlIiIyOAoFOLkQVAnR7opDCKM6QbEHQkVFG6oTqA0COkitIBBfQYSHcky190Ld1Aqz2EzqhVNLyHlDUQespU0fAeSr8zH9Dj3JAOQOixaiigB0OiAaHHtqFQQA+pm81nIXEeHYq9FEitEtLaQAxeHgaygB4MKVjGE6sZBRD146eEaCAiDBD146qEaCCSdCkoMyDqx1sJ0UBEDCCT9fPp+g0lRAMl6TFmiEl0he7B0NoJeN7xy/Cwtfri59PfNvbx5HKa5fnozA1kYAK0uWwMVFHec8QQtrUPhjMApcrAEIBSTWAoJyDtV4DiNNz9qT9fD9VNg7Kse1rnL6DEIjG2NGMIK6pHaf0ASJYe5kDoScrF3xeeRQb00GoAqnaOu/pxa6iFzkh/yMnSLKAnY/04rKKAHhZ6KZ9TFtAzRv346aGAHnoIQKXP3MD68WCohQ5LMxqoqJ5t68d2FQX0sIUAKnduUurHpKGAHudbm/hh9QE9hevHWA+10GFp5reBSurJWz9mXgMBPeyLR0CFj/h49VPXUPq/e2rRUx3Zxe6/br/UzYcCeurWT6dH6VjWQqdmad3Xo3FpFtBTffaj+tUS0COqftTtdUBPlfrp1aPFUECPwO5RdAQCegrXz1Z65BtqoaNoFihwaRbQI7x+hL+uAnpkTn20HB9xQ9iQlpb8rudEPdzKIGN1D5Noy+d7Q2kZ1kMDiZ5xA4gYrx9rQ9jV2+/Dv/ns5/ux62fv9FuZbaCBSuuJ+P5t06unwDYASOvsZ4ge5kCEAIj6AZCouNIDoMz1400PgLKSsn7JB0Cjz34ARKif7cLN1HsZcmVvcf0BPTRQpJ4nJ84GLigDqJCeB/XTLbvcGgIQAVBUIu6Er6ufktsAIBEg0s/ck3oKbwOrsPqlElc/G7rHBguGsBHj8H4FgLLVD3oARABE/QCIqQ+AHNUPegBE9wCo3uyHAIj6AVDx+kEPgOgeABEAEQARAiACIAIgAiBCsgM6vppyQFVkdaZ+fPwlBdDN+azk/qv+R+vG9oshjLgEZK+ElO5R4Iivkvg4TuKP6309THYOjnL9rpPLadM0t2ezwvuQ8X+vxD3inqKnPJ2MM+jGxoOFGc/B893XjKfbDWHL+YKZIEmaAy3niyyMVot5rgZJTt7x694kmioiqaswDJHUZXzicMYo5mr8atZdB6KKSBKglCqihPzUT9N7JZoqIkmA4qqIEnJSP83we2FxVYQhOXqqNVBcFRV+hxDpzRj100TcjR/OiIHM9uAVCSiijTBkVU+T+H6gXkYMZFanPnkADWHEQGZy6pMTUC8jDJkcvFaZPHv5aozf2+7vPfhKrfcrokdHA/UWEj1kT8+IDbSukOihArPmYnrKAboraWUIRgb0NOUf61nOF90eMpxp11Ohgbq8+3JID6mmUxkQjAzoqQ/oriEYRdCpq0cEIBgppSMLEIyGuxFCRyKgx4ycY3q8UJVDRy6gdYw8YFp3aUOaGwWAeiV5iFg3mgC58iRfjHpARFT4jEQCIAIgAiACIEIARABEAEQARAiACIAIgAiACAEQARABEAEQIQAiACIAIgAibvMfGKe/xgpKwHYAAAAASUVORK5CYII=","type":"image/png","cache":"public, max-age=31536000, immutable"},"/icon-512.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAPpUlEQVR42u3dvW5UVxcG4OORFUWkiYToSIkooaRAFEEucwsp6VxxA9wAlTvKXEJSIlIgCtqU9CiN5TJSChcpiCw09gwz4/Oz93qfp8ynLzFnznnftc62zdGdB48HgIouzy9chC1WLgGAAgAo5fjeXRdBAQCgAABLAAoA0AEKAAAFAGAJUAAAOkABAKAAACwBCgAABQBgCVAAACgAAEuAAgDQAQoAAAUAYAlQAAAoAABLgAIAQAEAWAIUAAAKAMASoAAAUAAAlgAFAKADFAAACgAgfglQAAA2AABLgAIAQAEAoAAAqot6C6QAAGwAACQtAQoAwAYAQNISoAAAbAAAJC0BCgDABgBA0hKgAABsAAAoAACG6m+BFACADQCApCVAAQDYAABIWgIUAIANAAAFAMDXSr4FUgAANgAAFAAAa+q9BVIAADYAAJKWAAUAYAMAQAEAcKNKb4EUAEBqmbkEIZ69vu8isKP3Lz+7CAmO7jx47CrIelAMe7k8v1AAiHv0gQJQAAh9lIECUADIfZSBDlAACH00gQJQACyd+x9OneCxk6dnI99+JZtAAdBi9At6mm2FYk3QewcogAq5L/HprhJqNIECYJnoF/oUKIPea0ABMF/0C31KNkHXNdB1BygAuQ9NlEGnNaAAmCT65T5qQAEogLj0F/2EN0FfNdBvByiAhqJf7qMJeqwBBYDoh9AaUACIfpiqBhrvAAXA3ukv+qFMDXTaAQpA9IMaUABMn/6iH25fAw12gAIQ/aIfcmugxw5QAJOnv+iHhA5QANJf+sOsNdBOBygA0S/6IbQGeiyAlRtL+kP7tj9TLfzNqcf37toA0tNf9MNSq8Die0B3S4ACMPiDDlAASH/ovwMWrAEFkJj+oh+sAj12gENg6Q+92vL0tXAsrACkP6ADGuUV0IHpL/qhHe28C+rrFZACkP5QvAbm7ABnANIfWMCmZ3POd0F9/TiYApD+oANCKQDpDzpAASD9QQcoAOkv/UEHKADpL/1BB+yho3NgBSD9QQfYAKS/9IeYDkABuG8g9Fm2BCiAjfeB9AcdoACkP5CVALfXyznwymcPxC4B4TngFZDxHzzdCsD47/6AyA6IXQJCC0D6gw7QAYkF4NU/IBkGZwDGf/C8T6GLbwSKKwAvf4DBi6DAApD+gA7I3QAAiCsA4z9gCUgsAOkP6IDcDQCAuAIw/gPzLwHtfyfoyucNYAMIGv8BZlgCFIDxH5AMCsD4D8gQBbDUJ2f8BywBERsAgCUgrgCM/4AlwAYAsMwS0PiPAgQVgPEfkBX1C8A3/wBSxQZg/AckRkwBGP8B2WIDMP4DciOmAIz/gISxARj/AemRXQAA1C8A738AOWMDSNngABmiAIz/gLSxARj/gWaSpOVfB+QQmGgv3j10EYhVpAC8/+Hg9NcBxGZO2Q3A+x92n/11AJl5cuyjJTn61/7hm+efXB9yOANA+u/6v4ICaM71l3He/3BwvusAbnQ9VQocA9gAkP46ABsASH8dQJLuD4F9AygTRbljYXbJn/cvO37hXHADcADAiIO8VYDC2eIVENJfBxBKASD9dQAKoEMOAJgtr3UA9VKo2k8COwAQ/VP/yx0LJ/tw+vnpmb8QBsLS3ypAPQoA6a8DUAAg/XUACgCkvw6gvKM7Dx53+qX7HXA0EsGOhdNcPwfe/vPAl+cXNgCoOYBbBeiUAkD6z/H1/P37I58aCgBqTtz2ABQA5Obspq/N+E+b/J3AiP7xv0jHwtgAICv9b/xqjf8ogJH5NXDS39eMRLIB/M8PAUj/Br9y439JZdLGKyCkP4RSAEj/qbz653sfIi3zXUCIfrABgPSfcvzXaigAyJ39dQAKAIrn45a3/zoABQC5yagDojT7u6AHh8AIxDnH/7U/st8YgQ0A6e/PDgoACRgw/usAFADSX/a5DigApF7k+K8DWJZDYER/Q5fFsTA2AKR/0PivHVEASH9cJRQAci1y/NcBKACkP64Yc3AIjCBra/xfu3SOhbEBIP1dQ/rT8i8CUgBIrkbHfx2AAkD643qiAJBWkeO/DmA6DoERUp1dXsfC2ACQ/kHjv5ZFASD9cbVRAMijyPFfB6AAkP648q1r/IcABofACKAex/+1j8CxMDYApL/PAhQAEidg/PeJoACQNfhcUABImcjx36fDYRwCI1wKfkyOhbEBIP2Dxn+fV1Pa/x5QBYA08alhAwA5UmX899mhAJAg+ATZxiEwgqPm+L/2UToWxgaA9PeZggJAUgSM/z7ZRXTxLUAKABnh88UGANKh9PjvU+Y6h8AIhdCP27EwNgCkf9D473NHASAF8OlPpZcTYAXg+ff8h47/7gEUgPQHd0Iuh8AeeHLH/7VbwrGwDQDpj3sDBYAn3PjvDmEfHZ0AKwDPNrhPbAB4qokf/90taRwCe5hh423jWNgGgPQ3/rt/UAB4enEXsUFfJ8CDV0CeW2Yb/1teL1798O/2e8m7IBsA0p+Kzbc1/d1RCgDpb/zPTX/3VVVeAYl+2O8G8zroRt0dANgApD/Gf3daLgUg/UmtvYPS3/2mAJD+xv/c9HfXKQCkP7np796rwSGw6Df+S//b3oSOhW0ASH/cjSgAPG/G/4Dx3z2pAJD+pKe/O1MBIP2N/7np7/7skUNg0Y/0H/9GdSxsA0D6G/+z0t8dqwDwLIH7VgHgKTL+543/7l4FgOeH6PR3D7fPIbDoN/5L/zluZsfCNgCkP1np765WAHhOjP/R6e/eVgB4QnCHu8MVAJ4N43/Y+O8+b5BDYI8E0n+ZG96xsA0A6W/8z0p/d74CwDNAdPq7/1vgFdDCJt2CPV0h4//U6e9djQ0AAAUAxv+Y8R8FAEh/FAAY/6U/JTgExoDcZRVJf2wAkLiISH8UAAAKAIz/oACgcp1IfxQABI7/0h8FAGZ/UACQMf5LfxQAAAoAjP9wO34SmG87e/J2hv/K6ccTl/q6u8//cIWxAVA5/ef8D3U0/o+Y/sWuMAqAaqEsoaZLf1cYBUDrYVEgoUYZ/6dIfx2AAqD1mJBQrjAKAIz/oAAghvRHAUDi+C/9UQBg9gcFABnjv/RHAQCgAMD4DwoACpP+KABIHP+lPwoAzP6gACBj/Jf+KAAAFADEjP/+ki8UAETWhvRHAUDg+C/9UQBg9gcFADHjPygAMP6DAoCM8V/6owDA7A8KADLGf+lPs45dAoo5e/J22gJ494v0xwYAcel/sU/6z/D1gAKA4ezJ29bS9suve9MBKADo3l7j/9e/7FMHoABgwvG/wdm/5a8QFADSf/zxf9Mv+tcBKACozF/zggKAUvb95h9QAGD8BwUA1cd/6Y8CALM/KAA4yOnHk77G/+7Sv6krjAJARsTN/q4wCgAd0Pf47wqjANABidl0+5c/rjAKgPQOOP140lo2fXP8H+vVf+wVZnH+PgCMjcvM/q4wNgBo0fbx3zd9ogDA7A8KAGLGf1AAYPwHBQAZ47/0RwGA2R8UAGSM/9IfBQBmf1AAEDP+gwIA4z8oAMgY/6U/CgDM/qAAIGP8l/4oADD7gwKAmPEfFAAY/0EBQMb4L/1RAGD2BwUAGeO/9EcBgNkfFADEjP+gAMD4DwoAMsZ/6Y8CALM/KADIGP+lPygAzP6gACBm/AcUAMZ/UACQMf5Lf1AAmP1BAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAK45v3Lz2v/5OnZfR8nMIPrafPnr38pAAAUAAAKAAAFAIACAEABAKAAbsV3gq558/yTi4C7SM4ULIDrPwoAML9Ofwhg8AoIIJYCsL+D+0cBAKAAMMSBO0cBNM2vhPMk456ZU5lfA2cDAKS/DQCPdM9OP574Ot0qKAA82LhJ2NXRnQePe/8zPHu9/lbuw6mfEdvmxbuH9f5QZ0/eGv+l/6SKHQDYAEx5dbScsNIfBUBbT3u9B77NnG0//UveDOyi5iugwVugPVV6KdTOu6DGo1/o7+XGbzHv/RVQhQIYHAMAsxdA7+k/DMPq8vzCRwsQaDUMgw4ACC2AAh3gd0IA0yn5/mf4+ruA7AEAiRtAyQ6wBACSZNcC+NIBndaAvyESmEeN9z/Dph8E8zoIoLyNPwlcowO8BQJkyN4FMHT4OshbIGBqZd7/DLv8LiCvgwDjf9wGUKMDvAUCjP+HF8DQz+sgb4EARi6ArlcBSwAgN25bAF10gCUAmEKx9z/DYX8hTI8/LGYJACTGCAXQ/ipgCQCM/xMWQHergCUAkBWjFUDLq4AlADD+T14AHa0ClgBASoxcAG2uApYAwPg/UwF0sQpYAgD5MEkBtLYKWAIA4/+sBdD4KmAJACTDhAXQTg3cuAToAOCbmVB7/J+8AK5qwO0FkFgAi68ClgDA+L9YASxeA06DAem/ZAFc1UDLHzxAiNUi/9VFVgEvggDj//IFsGANAEj/5Qtg/hqwBAA0VAAz14AOAIz/bRXAVQ00dTcA0l8BlFoFfEsoSH9aLIB5asCLICB8/G+3AGaoAR0Axv/k9G+9AObZBnQASH8FEFcDmw4DdACEpH+4VV9f7ug14EAYktM/efwfhuHoux9/6verP753d5R/z7PXN9wcH051A0h/G0D1hcCBMKSR/t0XwLg1oAMgZPyX/nUKYJQacCAMIenPlb7PALY47HjgxsOAwXkAFEp/43/BDWCUhcAeANLfBhC9ENgDQPrbAEIXAnsASH8bQPRCYA+AGtEv/RXAIU2gA0D6K4DcJtjUAWoApH/vVi7BF5sOCbb8siBHAiD9bQD1dwJ7AEh/BZDbBDoAeol+6a8Axvfzb4+2/K9qAAz+CiC3BnQASH8FoAOAWaNf+iuAJjpADYD0VwA6ABD9CkANANJfAaR1gBqAKaJf+isAHQAGfxSAGgCDPwqg5Q5QAyD6FYAaUAOwa/RLfwVQrQPUAIh+BaAG1ACiX/orADUAcl/0K4DMGtAEiH7RrwDUgBogK/dFvwJQA5oA0Y8CUAOagNKhL/oVgBp4dMD/SxnQe+6LfgXArWpAGdBd6Mt9BcAkTaAPaDDuRb8CYO4aUAwsm/VyXwHQYhPAPOS+AkAZIPdRAGgChD4KAGWA0EcBoBKQ+CgAtAKCHgUAwKRWLgGAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgAABQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAEv6D8v4I+AK37xrAAAAAElFTkSuQmCC","type":"image/png","cache":"public, max-age=31536000, immutable"}};

function serveEmbeddedAsset(pathname, method = "GET") {
  let path = pathname || "/";
  if (path === "/" || path === "") path = "/index.html";
  const asset = EMBEDDED_ASSETS[path] || EMBEDDED_ASSETS["/index.html"];
  const headers = {
    "content-type": asset.type,
    "cache-control": asset.cache,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin"
  };
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  const binary = atob(asset.body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, { status: 200, headers });
}
