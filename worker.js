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

const EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjMuNCDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPGxpbmsgcmVsPSJpY29uIiBocmVmPSJpY29uLTE5Mi5wbmciPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0ic3R5bGVzLmNzcz92PTYuMy40Ij4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwLXNoZWxsIj4KICA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPgogICAgPGRpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPjxzcGFuIGNsYXNzPSJicmFuZC1tYXJrIj7ijII8L3NwYW4+PHNwYW4+RWxkZWhvZjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3VidGl0bGUiPlZlcmJyYXVjaHNidWNoPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJidWlsZC1waWxsIj42LjMuNDwvc3Bhbj4KICA8L2hlYWRlcj4KCiAgPG1haW4+CiAgICA8ZGl2IGlkPSJyZWNvdmVyeUJhbm5lciIgY2xhc3M9ImJhbm5lciB3YXJuaW5nIGhpZGRlbiIgcm9sZT0ic3RhdHVzIj4KICAgICAgPGRpdj48c3Ryb25nPkxva2FsZSBTaWNoZXJoZWl0c2tvcGllIGdlZnVuZGVuPC9zdHJvbmc+PHNwYW4+RGVyIG5vcm1hbGUgTW9uYXRzZGF0ZW5zcGVpY2hlciBpc3QgbGVlciwgYWJlciBlaW5lIGZyw7xoZXJlIGxva2FsZSBLb3BpZSBpc3Qgdm9yaGFuZGVuLjwvc3Bhbj48L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0icmVzdG9yZVNoYWRvd0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldpZWRlcmhlcnN0ZWxsZW48L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IGFjdGl2ZSIgaWQ9ImRhc2hib2FyZFZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGFzaGJvYXJkVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPsOcQkVSU0lDSFQ8L3NwYW4+PGgxIGlkPSJkYXNoYm9hcmRUaXRsZSI+VmVyYnJhdWNoIGF1ZiBlaW5lbiBCbGljazwvaDE+PHA+WsOkaGxlcnN0w6RuZGUsIFfDpHJtZXB1bXBlLCBPc3Ryb20tUHJlaXNlIHVuZCBLbGltYSBhdWYgZWluZW4gQmxpY2suPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJkYXNoYm9hcmRBZGRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBsYXRlc3QtcGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkxFVFpURVIgTU9OQVQ8L3NwYW4+PGgyIGlkPSJsYXRlc3RNb250aFRpdGxlIj5Ob2NoIGtlaW5lIE1vbmF0c3dlcnRlPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJlZGl0TGF0ZXN0QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QgaGlkZGVuIiB0eXBlPSJidXR0b24iPkJlYXJiZWl0ZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCIgaWQ9ImxhdGVzdE1ldHJpY3MiPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJjb21wYXJpc29uLWxpbmUiIGlkPSJsYXRlc3RDb21wYXJpc29uIj48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBvc3Ryb20tcGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPgogICAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+T1NUUk9NPC9zcGFuPjxoMj5QcmVpc8O8YmVyc2ljaHQ8L2gyPjxzbWFsbCBpZD0ib3N0cm9tU3RhdHVzIj5Ob2NoIG5pY2h0IGdlbGFkZW48L3NtYWxsPjwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBpZD0icmVmcmVzaE9zdHJvbUJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPkFrdHVhbGlzaWVyZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJvc3Ryb21TZXR1cEhpbnQiIGNsYXNzPSJlbXB0eS1zdGF0ZSBoaWRkZW4iPjxzdHJvbmc+T3N0cm9tIGlzdCBub2NoIG5pY2h0IGVpbmdlcmljaHRldC48L3N0cm9uZz48c3Bhbj5EZW4gRWxkZWhvZi1BcHAtU2NobMO8c3NlbCBmaW5kZXN0IGR1IHVudGVyIERhdGVuIOKGkiBPc3Ryb20uPC9zcGFuPjxidXR0b24gaWQ9ImdvT3N0cm9tU2V0dGluZ3NCdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5FaW5yaWNodGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ib3N0cm9tRGFzaGJvYXJkIiBjbGFzcz0ib3N0cm9tLWdyaWQiPgogICAgICAgICAgPGFydGljbGUgY2xhc3M9InByaWNlLWNhcmQgY3VycmVudCI+PHNwYW4+QWt0dWVsbGVyIFByZWlzPC9zcGFuPjxzdHJvbmcgaWQ9Im9zdHJvbUN1cnJlbnRQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21DdXJyZW50TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8YXJ0aWNsZSBjbGFzcz0icHJpY2UtY2FyZCBiZXN0Ij48c3BhbiBpZD0ib3N0cm9tQmVzdExhYmVsIj5CZXN0ZXMgWmVpdGZlbnN0ZXI8L3NwYW4+PHN0cm9uZyBpZD0ib3N0cm9tQmVzdFByaWNlIj7igJM8L3N0cm9uZz48c21hbGwgaWQ9Im9zdHJvbUJlc3RNZXRhIj7igJM8L3NtYWxsPjwvYXJ0aWNsZT4KICAgICAgICAgIDxhcnRpY2xlIGNsYXNzPSJwcmljZS1jYXJkIHdvcnN0Ij48c3BhbiBpZD0ib3N0cm9tV29yc3RMYWJlbCI+U2NobGVjaHRlc3RlcyBaZWl0ZmVuc3Rlcjwvc3Bhbj48c3Ryb25nIGlkPSJvc3Ryb21Xb3JzdFByaWNlIj7igJM8L3N0cm9uZz48c21hbGwgaWQ9Im9zdHJvbVdvcnN0TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBwcmljZS1jaGFydC13cmFwIj48Y2FudmFzIGlkPSJvc3Ryb21NaW5pQ2hhcnQiIGFyaWEtbGFiZWw9Ik9zdHJvbSBQcmVpc3ZlcmxhdWYiPjwvY2FudmFzPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgZGFzaGJvYXJkLWNoYXJ0LXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5WRVJMQVVGPC9zcGFuPjxoMj5HZXNhbXR2ZXJicmF1Y2g8L2gyPjwvZGl2PjxidXR0b24gY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiBkYXRhLW5hdj0iYW5hbHlzaXNWaWV3IiB0eXBlPSJidXR0b24iPkF1c3dlcnR1bmcgw7ZmZm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAiPjxjYW52YXMgaWQ9ImRhc2hib2FyZENvbnN1bXB0aW9uQ2hhcnQiIGFyaWEtbGFiZWw9Ikdlc2FtdHZlcmJyYXVjaCBkZXIgbGV0enRlbiBNb25hdGUiPjwvY2FudmFzPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgZGFzaGJvYXJkLWNsaW1hdGUtcGFuZWwiIGlkPSJkYXNoYm9hcmRDbGltYXRlUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPgogICAgICAgICAgPGRpdj4KICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImV5ZWJyb3ciPktMSU1BICZhbXA7IFfDhFJNRVBVTVBFPC9zcGFuPgogICAgICAgICAgICA8aDI+V2VsY2hlcyBKYWhyIHdhciB3w6RybWVyIOKAkyB1bmQgd2llIHZpZWwgU3Ryb20gYnJhdWNodGUgZGllIEhlaXp1bmc/PC9oMj4KICAgICAgICAgICAgPHNtYWxsPjIwMjQgLyAyMDI1IC8gMjAyNiDCtyBnbGVpY2hlIE1vbmF0ZSwgZ2xlaWNoZSBKYWhyZXNmYXJiZW48L3NtYWxsPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGlkPSJkYXNoYm9hcmRDbGltYXRlRGV0YWlsc0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPkRldGFpbGF1c3dlcnR1bmc8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQgY2xpbWF0ZS1jb3VwbGVkLWludHJvIj5EaWUgb2JlcmUgS3VydmUgemVpZ3QgZGllIEF1w59lbnRlbXBlcmF0dXIuIERpcmVrdCBkYXJ1bnRlciBzaWVoc3QgZHUgZGVuIDxzdHJvbmc+U3Ryb212ZXJicmF1Y2ggZsO8cnMgSGVpemVuPC9zdHJvbmc+IChvaG5lIFdhcm13YXNzZXIpLiBCZWlkZSBEaWFncmFtbWUgdmVyd2VuZGVuIGRpZXNlbGJlbiBNb25hdGUgdW5kIEphaHJlc2ZhcmJlbi48L3A+CiAgICAgICAgPGRpdiBpZD0iZGFzaGJvYXJkQ2xpbWF0ZUxlZ2VuZCIgY2xhc3M9ImNsaW1hdGUtY291cGxlZC1sZWdlbmQiIGFyaWEtbGFiZWw9IkphaHJlc2ZhcmJlbiI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXJhbmdlIiByb2xlPSJncm91cCIgYXJpYS1sYWJlbD0iWmVpdHJhdW0gZsO8ciBkZW4gSmFocmVzdmVyZ2xlaWNoIj4KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBkYXRhLWNsaW1hdGUtcGVyaW9kPSJoZWF0aW5nIiBjbGFzcz0iYWN0aXZlIiBhcmlhLXByZXNzZWQ9InRydWUiPkhlaXptb25hdGU8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBkYXRhLWNsaW1hdGUtcGVyaW9kPSJhbGwiIGFyaWEtcHJlc3NlZD0iZmFsc2UiPkdhbnplcyBKYWhyPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPHAgaWQ9ImRhc2hib2FyZENsaW1hdGVZZWFyIiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXRpbWVmcmFtZSI+PC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImNsaW1hdGUtY291cGxlZC1wbG90Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNsaW1hdGUtY291cGxlZC10aXRsZSI+PHN0cm9uZz4xLiBBdcOfZW50ZW1wZXJhdHVyPC9zdHJvbmc+PHNwYW4+TW9uYXRzbWl0dGVsIMK3IMKwQyDCtyBlaW5oZWl0bGljaGUgV2V0dGVycXVlbGxlPC9zcGFuPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBjbGltYXRlLWNvdXBsZWQtY2hhcnQiPjxjYW52YXMgaWQ9ImRhc2hib2FyZENsaW1hdGVUZW1wZXJhdHVyZUNoYXJ0IiBhcmlhLWxhYmVsPSJBdcOfZW50ZW1wZXJhdHVyZW4gZGVyIFZlcmdsZWljaHNqYWhyZSI+PC9jYW52YXM+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXBsb3QiPgogICAgICAgICAgPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXRpdGxlIj48c3Ryb25nPjIuIEhlaXpzdHJvbSBkZXIgV8Okcm1lcHVtcGU8L3N0cm9uZz48c3Bhbj5rV2ggcHJvIE1vbmF0IMK3IG9obmUgV2FybXdhc3Nlcjwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgY2xpbWF0ZS1jb3VwbGVkLWNoYXJ0Ij48Y2FudmFzIGlkPSJkYXNoYm9hcmRDbGltYXRlRWxlY3RyaWNDaGFydCIgYXJpYS1sYWJlbD0iSGVpenN0cm9tYmVkYXJmIGRlciBXw6RybWVwdW1wZSBpbSBKYWhyZXN2ZXJnbGVpY2giPjwvY2FudmFzPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJjbGltYXRlLWNvdXBsZWQtbm90aWNlIj5KZSBow7ZoZXIgZGllIHp3ZWl0ZSBLdXJ2ZSwgZGVzdG8gbWVociBTdHJvbSBoYXQgZGllIFfDpHJtZXB1bXBlIGbDvHJzIEhlaXplbiBnZWJyYXVjaHQuIFRlbXBlcmF0dXIgdW5kIEhlaXpzdHJvbSB3ZXJkZW4gbmljaHQgYXVmIGRlcnNlbGJlbiBaYWhsZW5za2FsYSBkYXJnZXN0ZWxsdC4gRmVobGVuZGUgTW9uYXRlIGJsZWliZW4gbGVlci48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnkiIGlkPSJkYXNoYm9hcmRDbGltYXRlVHJlbmQiIHJvbGU9InN0YXR1cyI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZGFzaGJvYXJkLWNsaW1hdGUtbW9udGgtdGl0bGUiPk1vbmF0IGltIERldGFpbCA8c21hbGw+QW50aXBwZW46IFRlbXBlcmF0dXIsIFN0cm9tLCBXw6RybWUgdW5kIEhlaXotQ09QIGFsbGVyIEphaHJlPC9zbWFsbD48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJkYXNoYm9hcmRDbGltYXRlTW9udGhCdXR0b25zIiBjbGFzcz0iZGFzaGJvYXJkLWNsaW1hdGUtbW9udGhzIiByb2xlPSJncm91cCIgYXJpYS1sYWJlbD0iVmVyZ2xlaWNoc21vbmF0IGF1c3fDpGhsZW4iPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImRhc2hib2FyZENsaW1hdGVNb250aERldGFpbCIgY2xhc3M9ImNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwiIGFyaWEtbGl2ZT0icG9saXRlIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIiPgogICAgICAgICAgPHAgaWQ9ImRhc2hib2FyZENsaW1hdGVTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCIgcm9sZT0ic3RhdHVzIj48L3A+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJkYXNoYm9hcmQtY2xpbWF0ZS1hY3Rpb25zIj48YnV0dG9uIGlkPSJkYXNoYm9hcmRDbGltYXRlV2VhdGhlckJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldldHRlcmhpc3RvcmllIGxhZGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KICAgIDwvc2VjdGlvbj4KCiAgICA8c2VjdGlvbiBjbGFzcz0idmlldyIgaWQ9ImNvbnN1bXB0aW9uVmlldyIgYXJpYS1sYWJlbGxlZGJ5PSJjb25zdW1wdGlvblRpdGxlIj4KICAgICAgPGRpdiBjbGFzcz0icGFnZS1oZWFkIj4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5WRVJCUkFVQ0g8L3NwYW4+PGgxIGlkPSJjb25zdW1wdGlvblRpdGxlIj5Nb25hdHN3ZXJ0ZTwvaDE+PHA+R2VzYW10LSB1bmQgQWx0ZW50ZWlsLVZlcmJyYXVjaCBlbnRzdGVoZW4gYXVzIGRlbiBaw6RobGVyc3TDpG5kZW4uIFfDpHJtZXB1bXBlIGtvbW10IGF1cyBkZXIgbXlWQUlMTEFOVC1DU1Y7IFNjaGxlZS9LbHVzIHdpcmQgYXV0b21hdGlzY2ggYmVyZWNobmV0LjwvcD48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBpZD0iYWRkUmVjb3JkQnRuIiB0eXBlPSJidXR0b24iPisgWsOkaGxlcnN0w6RuZGU8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXRvb2xiYXIiPjxzdHJvbmcgaWQ9InJlY29yZENvdW50Ij4wIE1vbmF0ZTwvc3Ryb25nPjxzZWxlY3QgaWQ9InJlY29yZFllYXJGaWx0ZXIiIGFyaWEtbGFiZWw9IkphaHIgZmlsdGVybiI+PG9wdGlvbiB2YWx1ZT0iYWxsIj5BbGxlIEphaHJlPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0icmVjb3JkTGlzdCIgY2xhc3M9InJlY29yZC1saXN0Ij48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iYW5hbHlzaXNWaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImFuYWx5c2lzVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkFVU1dFUlRVTkc8L3NwYW4+PGgxIGlkPSJhbmFseXNpc1RpdGxlIj5WZXJicmF1Y2ggdmVyc3RlaGVuPC9oMT48cD5KYWhyZXN3ZXJ0ZSwgQXVmdGVpbHVuZywgS29zdGVuIHVuZCBXw6RybWVwdW1wZW4tRWZmaXppZW56LjwvcD48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBmaWx0ZXItcGFuZWwiPgogICAgICAgIDxsYWJlbD5EZXRhaWxqYWhyPHNlbGVjdCBpZD0iYW5hbHlzaXNZZWFyIj48L3NlbGVjdD48L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9ImFuYWx5c2lzLWFsbC15ZWFycy1oaW50Ij48c3Ryb25nPk1laHJqYWhyZXN2ZXJnbGVpY2g8L3N0cm9uZz48c3Bhbj5BbGxlIHZvcmhhbmRlbmVuIEphaHJlIHdlcmRlbiBnZW1laW5zYW0gZGFyZ2VzdGVsbHQuIFZlcmdhbmdlbmUgSmFocmUgZ2VzdHJpY2hlbHQsIGRhcyBha3R1ZWxsZSBKYWhyIGR1cmNoZ2V6b2dlbi48L3NwYW4+PC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9Im1ldHJpYy1ncmlkIGFuYWx5c2lzLW1ldHJpY3MiIGlkPSJhbmFseXNpc01ldHJpY3MiPjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5BVUZURUlMVU5HPC9zcGFuPjxoMj5Xw6RybWVwdW1wZSDCtyBBbHRlbnRlaWwgwrcgU2NobGVlL0tsdXM8L2gyPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImxlZ2VuZCI+PHNwYW4gY2xhc3M9ImhlYXQiPlfDpHJtZXB1bXBlPC9zcGFuPjxzcGFuIGNsYXNzPSJhbm5leCI+QWx0ZW50ZWlsPC9zcGFuPjxzcGFuIGNsYXNzPSJyZXN0Ij5TY2hsZWUvS2x1czwvc3Bhbj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJhbGxvY2F0aW9uQ2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5NRUhSSkFIUkVTVkVSR0xFSUNIPC9zcGFuPjxoMj5HZXNhbXR2ZXJicmF1Y2ggbmFjaCBNb25hdGVuPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGlkPSJ5ZWFyQ29tcGFyaXNvbkxlZ2VuZCIgY2xhc3M9InllYXItY29tcGFyaXNvbi1sZWdlbmQiPjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9InRvdGFsQ2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ib3N0cm9tUHJpY2VTdGF0c1BhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5PU1RST00tUFJFSVNFPC9zcGFuPjxoMj7DmCBrV2gtUHJlaXMgwrcgTW9uYXQgwrcgUXVhcnRhbCDCtyBKYWhyPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJyZWZyZXNoT3N0cm9tUHJpY2VTdGF0c0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPk9zdHJvbS1QcmVpc2UgYWt0dWFsaXNpZXJlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RGVyIEFyYmVpdHNwcmVpcyB3aXJkIGF1cyBkZW4gdm9uIE9zdHJvbSBnZWxpZWZlcnRlbiBTdHVuZGVucHJlaXNlbiB1bmQgZGVpbmVtIHRhdHPDpGNobGljaGVuIE9zdHJvbS1WZXJicmF1Y2ggdmVyYnJhdWNoc2dld2ljaHRldCBiZXJlY2huZXQuIFF1YXJ0YWxzLSB1bmQgSmFocmVzd2VydGUgc2luZCBkYWhlciBrZWluIGVpbmZhY2hlciBNaXR0ZWx3ZXJ0IGRlciBNb25hdGUuPC9wPgogICAgICAgIDxzZWN0aW9uIGNsYXNzPSJtZXRyaWMtZ3JpZCBhbmFseXNpcy1tZXRyaWNzIiBpZD0ib3N0cm9tUHJpY2VTdGF0c01ldHJpY3MiPjwvc2VjdGlvbj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJvc3Ryb21BdmVyYWdlUHJpY2VDaGFydCIgYXJpYS1sYWJlbD0iRHVyY2hzY2huaXR0bGljaGVyIE9zdHJvbS1BcmJlaXRzcHJlaXMgcHJvIE1vbmF0Ij48L2NhbnZhcz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPsOYIEFyYmVpdHNwcmVpczwvdGg+PHRoPkVmZmVrdGl2IGlua2wuIEZpeGtvc3RlbjwvdGg+PHRoPk9zdHJvbS1WZXJicmF1Y2g8L3RoPjx0aD5TdGF0dXM8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9Im9zdHJvbVByaWNlU3RhdHNUYWJsZSI+PC90Ym9keT48L3RhYmxlPjwvZGl2PgogICAgICAgIDxwIGlkPSJvc3Ryb21QcmljZVN0YXRzU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgPC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJjbGltYXRlQW5hbHlzaXNQYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+V0lUVEVSVU5HU0JFUkVJTklHVU5HPC9zcGFuPjxoMj5IZWl6d8Okcm1lICYgV2V0dGVyPC9oMj48L2Rpdj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgaWQ9ImxvYWRDbGltYXRlV2VhdGhlckJ0biIgdHlwZT0iYnV0dG9uIj5XZXR0ZXJkYXRlbiBsYWRlbjwvYnV0dG9uPjwvZGl2PjxwIGNsYXNzPSJtdXRlZCI+SGVpemdyYWR0YWdlIChCYXNpcyAxNSDCsEMpLCBnZXRyZW5udGUgSGVpei0gdW5kIFdhcm13YXNzZXJ3w6RybWUuIFZlcmdsZWljaCBqZSBLYWxlbmRlcm1vbmF0IG1pdCBkZW4gSGVpemdyYWR0YWdlbiB2b24gMjAyNCB1bmQgMjAyNS48L3A+PGRpdiBjbGFzcz0ibWV0cmljLWdyaWQgYW5hbHlzaXMtbWV0cmljcyIgaWQ9ImNsaW1hdGVNZXRyaWNzIj48L2Rpdj48ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPsOYIFdldHRlciDCsEM8L3RoPjx0aD5WYWlsbGFudCBhdcOfZW4gwrBDPC90aD48dGg+UmF1bSDCsEM8L3RoPjx0aD5TcGVpY2hlciDCsEM8L3RoPjx0aD5IR1Q8L3RoPjx0aD5IZWl6d8Okcm1lIGtXaDwvdGg+PHRoPldhcm13YXNzZXIga1doPC90aD48dGg+V2l0dGVydW5nc2JlcmVpbmlndCBrV2g8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImNsaW1hdGVSb3dzIj48L3Rib2R5PjwvdGFibGU+PC9kaXY+PHAgaWQ9ImNsaW1hdGVJbmZvIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD48ZGl2IGlkPSJjbGltYXRlTXVsdGlZZWFyIiBjbGFzcz0iY2xpbWF0ZS15ZWFyLWNvbXBhcmlzb24iPjwvZGl2Pjwvc2VjdGlvbj48c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPktPU1RFTjwvc3Bhbj48aDI+TW9uYXRsaWNoZSBTdHJvbWtvc3RlbjwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBsYXJnZSI+PGNhbnZhcyBpZD0iY29zdENoYXJ0Ij48L2NhbnZhcz48L2Rpdj48L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9ImNvcFBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5Xw4RSTUVQVU1QRTwvc3Bhbj48aDI+QXJiZWl0c3phaGw8L2gyPjwvZGl2PjwvZGl2PjxwIGNsYXNzPSJtdXRlZCI+V2lyZCBudXIgYXVzIE1vbmF0ZW4gbWl0IGRva3VtZW50aWVydGVyIGVyemV1Z3RlciBXw6RybWUgYmVyZWNobmV0LjwvcD48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJjb3BDaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1PTkFURTwvc3Bhbj48aDI+SmFocmVzw7xiZXJzaWNodDwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0idGFibGUtc2Nyb2xsIj48dGFibGU+PHRoZWFkPjx0cj48dGg+TW9uYXQ8L3RoPjx0aD5HZXNhbXQ8L3RoPjx0aD5XUDwvdGg+PHRoPkFsdGVudGVpbDwvdGg+PHRoPlNjaGxlZS9LbHVzPC90aD48dGg+S29zdGVuPC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJhbmFseXNpc1RhYmxlIj48L3Rib2R5PjwvdGFibGU+PC9kaXY+PC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iZGF0YVZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGF0YVRpdGxlIj4KICAgICAgPGRpdiBjbGFzcz0icGFnZS1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5EQVRFTjwvc3Bhbj48aDEgaWQ9ImRhdGFUaXRsZSI+QmFja3VwICYgRWluc3RlbGx1bmdlbjwvaDE+PHA+WsOkaGxlcnN0w6RuZGUsIG15VkFJTExBTlQtSW1wb3J0LCBTaWNoZXJ1bmcgdW5kIE9zdHJvbS48L3A+PC9kaXY+PC9kaXY+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkRBVEVOUVVBTElUw4RUPC9zcGFuPjxoMj5Nb25hdHN3ZXJ0ZSBwcsO8ZmVuPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBjb21wYWN0LW1ldHJpY3MiIGlkPSJxdWFsaXR5TWV0cmljcyI+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0icXVhbGl0eUlzc3VlcyIgY2xhc3M9Imlzc3VlLWxpc3QiPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ibWV0ZXJQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+WsOESExFUlNUw4ROREU8L3NwYW4+PGgyPkdlc2FtdCAmIEFsdGVudGVpbDwvaDI+PC9kaXY+PGJ1dHRvbiBpZD0iYWRkTWV0ZXJCdG4iIGNsYXNzPSJwcmltYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+KyBFaW50cmFnZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkR1IHRyw6Rnc3QgbnVyIGRpZSBiZWlkZW4gYWt0dWVsbGVuIFrDpGhsZXJzdMOkbmRlIGVpbi4gRWxkZWhvZiBiZXJlY2huZXQgZGFyYXVzIGF1dG9tYXRpc2NoIGRlbiBNb25hdHN2ZXJicmF1Y2guIEF1c2dhbmdzcHVua3QgaXN0IGRlciAwMS4xMC4yMDI2IG1pdCBHZXNhbXQgMzQuMjU1IGtXaCB1bmQgQWx0ZW50ZWlsIDkuMDQ1IGtXaC48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQgbWV0ZXItbGF0ZXN0IiBpZD0ibWV0ZXJMYXRlc3QiPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9Im1ldGVySGlzdG9yeSIgY2xhc3M9Im1ldGVyLWhpc3RvcnkiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3cgbWV0ZXItYWN0aW9ucyI+PGJ1dHRvbiBpZD0idW5kb0xhdGVzdE1ldGVyQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkxldHp0ZW4gWsOkaGxlcnN0YW5kIHp1csO8Y2tuZWhtZW48L2J1dHRvbj48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0idmFpbGxhbnRJbXBvcnRQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+V8OEUk1FUFVNUEU8L3NwYW4+PGgyPm15VkFJTExBTlQtRGF0ZW4gaW1wb3J0aWVyZW48L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+V8OkaGxlIGFyb1RIRVJNIHVuZCB1bmlUT1dFUiBnZW1laW5zYW0gb2RlciBkaWUgw6RsdGVyZSBFbGRlaG9mLU1vbmF0c2ltcG9ydC1DU1YuIERpZSBUZW1wZXJhdHVyZGF0ZWllbiBhdXMgU3lzdGVtLCBab25lIDAgdW5kIFdhcm13YXNzZXJzcGVpY2hlciBrw7ZubmVuIHp1c8OkdHpsaWNoIG9kZXIgZWluemVsbiBpbXBvcnRpZXJ0IHdlcmRlbi4gTnVyIE1vbmF0c2FnZ3JlZ2F0ZSB3ZXJkZW4gZ2VzcGVpY2hlcnQuIFrDpGhsZXJzdMOkbmRlIHVuZCBQcmVpc2UgYmxlaWJlbiB1bnZlcsOkbmRlcnQuPC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBwcmltYXJ5Ij5DU1YtRGF0ZWllbiBhdXN3w6RobGVuPGlucHV0IGlkPSJ2YWlsbGFudENzdkZpbGVzSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iLmNzdix0ZXh0L2Nzdix0ZXh0L3BsYWluIiBtdWx0aXBsZSBoaWRkZW4+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0idmFpbGxhbnRJbXBvcnRTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+Tm9jaCBrZWluZSBEYXRlaWVuIGF1c2dld8OkaGx0LjwvcD4KICAgICAgPC9zZWN0aW9uPgoKCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9InN5bmNQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+R0VSw4RURS1TWU5DPC9zcGFuPjxoMj5BdWYgYWxsZW4gR2Vyw6R0ZW4gYWt0dWVsbDwvaDI+PC9kaXY+PHNwYW4gaWQ9InN5bmNCYWRnZSIgY2xhc3M9InN5bmMtYmFkZ2UiPm5pY2h0IGVpbmdlcmljaHRldDwvc3Bhbj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkVsZGVob2Ygc3luY2hyb25pc2llcnQgTW9uYXRzd2VydGUsIFrDpGhsZXJzdMOkbmRlLCBpbXBvcnRpZXJ0ZSBWYWlsbGFudC1XZXJ0ZSB1bmQgYmVyZWNobmV0ZSBPc3Ryb20tS29zdGVuIHZlcnNjaGzDvHNzZWx0IMO8YmVyIGRlbiBiZXN0ZWhlbmRlbiBDbG91ZGZsYXJlLVRyZXNvci4gTmFjaCBlaW5lciDDhG5kZXJ1bmcgd2lyZCBhdXRvbWF0aXNjaCBob2NoZ2VsYWRlbjsgYmVpbSDDlmZmbmVuIG9kZXIgWnVyw7xja2tlaHJlbiBpbiBkaWUgQXBwIHdpcmQgYXV0b21hdGlzY2ggZGVyIG5ldWVzdGUgU3RhbmQgZ2VsYWRlbi48L3A+CiAgICAgICAgPGRpdiBpZD0ic3luY1NldHVwQm94Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5EaWVzZXMgR2Vyw6R0IGJlbmVubmVuPGlucHV0IGlkPSJzeW5jQ3JlYXRlRGV2aWNlTmFtZSIgdHlwZT0idGV4dCIgbWF4bGVuZ3RoPSI2MCIgcGxhY2Vob2xkZXI9InouIEIuIGlQYWQgS8O8Y2hlIj48L2xhYmVsPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzeW5jQ3JlYXRlQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5HZXLDpHRlLVN5bmMgZWlucmljaHRlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRldGFpbHMgY2xhc3M9InN5bmMtam9pbi1ib3giPjxzdW1tYXJ5PkRpZXNlcyBHZXLDpHQgbWl0IGJlc3RlaGVuZGVtIEVsZGVob2Yga29wcGVsbjwvc3VtbWFyeT4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+VHJlc29yLUlEPGlucHV0IGlkPSJzeW5jSm9pblZhdWx0SWQiIHR5cGU9InRleHQiIGF1dG9jb21wbGV0ZT0ib2ZmIj48L2xhYmVsPgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPktvcHBsdW5nc2NvZGU8aW5wdXQgaWQ9InN5bmNKb2luQ29kZSIgdHlwZT0idGV4dCIgYXV0b2NvbXBsZXRlPSJvbmUtdGltZS1jb2RlIiBwbGFjZWhvbGRlcj0iWFhYWC1YWFhYLVhYWFgiPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+V2llZGVyaGVyc3RlbGx1bmdzc2NobMO8c3NlbDx0ZXh0YXJlYSBpZD0ic3luY0pvaW5SZWNvdmVyeSIgcm93cz0iMyIgYXV0b2NvbXBsZXRlPSJvZmYiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5EaWVzZXMgR2Vyw6R0IGJlbmVubmVuPGlucHV0IGlkPSJzeW5jSm9pbkRldmljZU5hbWUiIHR5cGU9InRleHQiIG1heGxlbmd0aD0iNjAiIHBsYWNlaG9sZGVyPSJ6LiBCLiBpUGhvbmUiPjwvbGFiZWw+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8YnV0dG9uIGlkPSJzeW5jSm9pbkJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+R2Vyw6R0IGtvcHBlbG48L2J1dHRvbj4KICAgICAgICAgIDwvZGV0YWlscz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJzeW5jQWN0aXZlQm94IiBjbGFzcz0iaGlkZGVuIj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIHN5bmMtbWV0cmljcyI+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPkdlcsOkdDwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jRGV2aWNlVGV4dCI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJzeW5jUm9sZVRleHQiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgICA8YXJ0aWNsZT48c3Bhbj5UcmVzb3ItVmVyc2lvbjwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jUmV2aXNpb25UZXh0Ij4wPC9zdHJvbmc+PHNtYWxsIGlkPSJzeW5jTGFzdFRleHQiPm5vY2ggbmllPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPkF1dG9tYXRpazwvc3Bhbj48c3Ryb25nPmFrdGl2PC9zdHJvbmc+PHNtYWxsPmJlaSBBcHAtU3RhcnQsIFLDvGNra2VociB1bmQgbmFjaCDDhG5kZXJ1bmdlbjwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzeW5jTm93QnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5KZXR6dCBzeW5jaHJvbmlzaWVyZW48L2J1dHRvbj48YnV0dG9uIGlkPSJzeW5jUGFpckJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5OZXVlcyBHZXLDpHQga29wcGVsbjwvYnV0dG9uPjxidXR0b24gaWQ9InN5bmNEaXNjb25uZWN0QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkRpZXNlcyBHZXLDpHQgdHJlbm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRpdiBpZD0ic3luY1BhaXJSZXN1bHQiIGNsYXNzPSJzeW5jLXBhaXItcmVzdWx0IGhpZGRlbiI+PHN0cm9uZz5Lb3BwbHVuZ3NkYXRlbiBmw7xyIGRhcyBuZXVlIEdlcsOkdDwvc3Ryb25nPjxzcGFuPlRyZXNvci1JRDwvc3Bhbj48Y29kZSBpZD0ic3luY1BhaXJWYXVsdCI+4oCTPC9jb2RlPjxzcGFuPkNvZGUgKDEwIE1pbnV0ZW4pPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpckNvZGUiPuKAkzwvY29kZT48c3Bhbj5XaWVkZXJoZXJzdGVsbHVuZ3NzY2hsw7xzc2VsPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpclJlY292ZXJ5Ij7igJM8L2NvZGU+PHNtYWxsIGlkPSJzeW5jUGFpckV4cGlyeSI+PC9zbWFsbD48L2Rpdj4KICAgICAgICAgIDxwIGlkPSJzeW5jU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgICA8L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5TSUNIRVJVTkc8L3NwYW4+PGgyPlByaXZhdGVzIEJhY2t1cDwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EYXMgcHJpdmF0ZSBCYWNrdXAgZW50aMOkbHQgZGVpbmUgVmVyYnJhdWNoc2RhdGVuIHVuZCDigJMgc29mZXJuIGdlc3BlaWNoZXJ0IOKAkyBhdWNoIGRlbiBPc3Ryb20tQXBwLVNjaGzDvHNzZWwuIE5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbi48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRCYWNrdXBCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkJhY2t1cCBleHBvcnRpZXJlbjwvYnV0dG9uPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBzZWNvbmRhcnkiPkJhY2t1cCBpbXBvcnRpZXJlbjxpbnB1dCBpZD0iaW1wb3J0QmFja3VwSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iYXBwbGljYXRpb24vanNvbiwuanNvbiIgaGlkZGVuPjwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRDc3ZCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+Q1NWIGV4cG9ydGllcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPHAgaWQ9ImJhY2t1cFN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im9zdHJvbVNldHRpbmdzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0IHZlcmJpbmRlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+RWxkZWhvZi1BcHAtU2NobMO8c3NlbDxpbnB1dCBpZD0ib3N0cm9tQXBwS2V5SW5wdXQiIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9Im9mZiIgcGxhY2Vob2xkZXI9IkFwcC1TY2hsw7xzc2VsIj48L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+WmVpdGZlbnN0ZXI8c2VsZWN0IGlkPSJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0Ij48b3B0aW9uIHZhbHVlPSIxIj4xIFN0dW5kZTwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjIiPjIgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjMiPjMgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjQiPjQgU3R1bmRlbjwvb3B0aW9uPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InN3aXRjaC1yb3ciPjxpbnB1dCBpZD0ib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIgdHlwZT0iY2hlY2tib3giPjxzcGFuPkF1dG9tYXRpc2NoIGFsbGUgMTAgTWludXRlbiBha3R1YWxpc2llcmVuPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+PGJ1dHRvbiBpZD0ic2F2ZU9zdHJvbUJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuICYgcHLDvGZlbjwvYnV0dG9uPjxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21IaXN0b3J5QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkhpc3RvcmlzY2hlIFByZWlzZSBsYWRlbjwvYnV0dG9uPjxidXR0b24gaWQ9ImRpc2Nvbm5lY3RPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+VmVyYmluZHVuZyBlbnRmZXJuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBpZD0ib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgICAgPHAgaWQ9Im9zdHJvbUhpc3RvcnlTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+SGlzdG9yaXNjaGUgUHJlaXNlIG5vY2ggbmljaHQgZ2VwcsO8ZnQuPC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPktPU1RFTjwvc3Bhbj48aDI+RmFsbGJhY2stV2VydGU8L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QXJiZWl0c3ByZWlzIOKCrC9rV2g8aW5wdXQgaWQ9ImZhbGxiYWNrUHJpY2VJbnB1dCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+TW9uYXRsaWNoZSBGaXhrb3N0ZW4g4oKsPGlucHV0IGlkPSJkZWZhdWx0QmFzZUZlZUlucHV0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMSI+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJzYXZlQ29zdFNldHRpbmdzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPlNwZWljaGVybjwvYnV0dG9uPgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CiAgPC9tYWluPgoKICA8bmF2IGNsYXNzPSJib3R0b20tbmF2IiBhcmlhLWxhYmVsPSJIYXVwdG5hdmlnYXRpb24iPgogICAgPGJ1dHRvbiBjbGFzcz0iYWN0aXZlIiBkYXRhLW5hdj0iZGFzaGJvYXJkVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7ijII8L3NwYW4+w5xiZXJzaWNodDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iY29uc3VtcHRpb25WaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKWpDwvc3Bhbj5WZXJicmF1Y2g8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS1uYXY9ImFuYWx5c2lzVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7ilqU8L3NwYW4+QXVzd2VydHVuZzwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iZGF0YVZpZXciIHR5cGU9ImJ1dHRvbiI+PHNwYW4+4pqZPC9zcGFuPkRhdGVuPC9idXR0b24+CiAgPC9uYXY+CjwvZGl2PgoKPGRpdiBpZD0icmVjb3JkTW9kYWwiIGNsYXNzPSJtb2RhbCBoaWRkZW4iIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbGxlZGJ5PSJyZWNvcmRNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWw+PC9kaXY+CiAgPGZvcm0gY2xhc3M9Im1vZGFsLWNhcmQiIGlkPSJyZWNvcmRGb3JtIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1PTkFUIEJFQVJCRUlURU48L3NwYW4+PGgyIGlkPSJyZWNvcmRNb2RhbFRpdGxlIj5Nb25hdCBiZWFyYmVpdGVuPC9oMj48L2Rpdj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imljb24tYnV0dG9uIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPGlucHV0IGlkPSJlZGl0aW5nTW9udGhPcmlnaW5hbCIgdHlwZT0iaGlkZGVuIj4KICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPk1vbmF0PGlucHV0IGlkPSJyZWNvcmRNb250aCIgdHlwZT0ibW9udGgiIHJlYWRvbmx5PjwvbGFiZWw+CiAgICAgIDxzcGFuPjwvc3Bhbj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+R2VzYW10dmVyYnJhdWNoIGtXaDxpbnB1dCBpZD0icmVjb3JkVG90YWwiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIj48L2xhYmVsPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BbHRlbnRlaWwga1doPGlucHV0IGlkPSJyZWNvcmRBbm5leCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPlfDpHJtZXB1bXBlIGtXaDxpbnB1dCBpZD0icmVjb3JkSGVhdFB1bXAiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIj48L2xhYmVsPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj7DmCBTdHJvbXByZWlzIGN0L2tXaDxpbnB1dCBpZD0icmVjb3JkUHJpY2VDdCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkZpeGtvc3RlbiDigqw8aW5wdXQgaWQ9InJlY29yZEJhc2VGZWUiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9ImRlcml2ZWRQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5TY2hsZWUvS2x1czog4oCTPC9kaXY+CiAgICA8cCBpZD0icmVjb3JkU291cmNlSGludCIgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+PC9wPgogICAgPGRldGFpbHMgY2xhc3M9ImRldGFpbHMtY2FyZCI+PHN1bW1hcnk+V8Okcm1lcHVtcGVuLURldGFpbHMgKG9wdGlvbmFsKTwvc3VtbWFyeT48ZGl2IGNsYXNzPSJmb3JtLWdyaWQgZGV0YWlsLWdyaWQiPjxsYWJlbCBjbGFzcz0iZmllbGQiPkVyemV1Z3RlIFfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRHZW5lcmF0ZWQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48bGFiZWwgY2xhc3M9ImZpZWxkIj5IZWl6c3Ryb20ga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48bGFiZWwgY2xhc3M9ImZpZWxkIj5XYXJtd2Fzc2Vyc3Ryb20ga1doPGlucHV0IGlkPSJyZWNvcmREaHdFbGVjdHJpY2l0eSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPkhlaXp3w6RybWUga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0aW5nSGVhdCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPldhcm13YXNzZXJ3w6RybWUga1doPGlucHV0IGlkPSJyZWNvcmREaHdIZWF0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PC9kaXY+PC9kZXRhaWxzPgogICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+Tm90aXo8dGV4dGFyZWEgaWQ9InJlY29yZE5vdGUiIHJvd3M9IjMiIG1heGxlbmd0aD0iODAwIj48L3RleHRhcmVhPjwvbGFiZWw+CiAgICA8cCBpZD0icmVjb3JkVmFsaWRhdGlvbiIgY2xhc3M9InZhbGlkYXRpb24tdGV4dCI+PC9wPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+PHNwYW4gY2xhc3M9InNwYWNlciI+PC9zcGFuPjxidXR0b24gY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbD5BYmJyZWNoZW48L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJzdWJtaXQiPsOEbmRlcnVuZ2VuIHNwZWljaGVybjwvYnV0dG9uPjwvZGl2PgogIDwvZm9ybT4KPC9kaXY+Cgo8ZGl2IGlkPSJtZXRlck1vZGFsIiBjbGFzcz0ibW9kYWwgaGlkZGVuIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWxsZWRieT0ibWV0ZXJNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbD48L2Rpdj4KICA8Zm9ybSBjbGFzcz0ibW9kYWwtY2FyZCIgaWQ9Im1ldGVyRm9ybSI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDIgaWQ9Im1ldGVyTW9kYWxUaXRsZSI+TmV1ZSBBYmxlc3VuZzwvaDI+PC9kaXY+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJpY29uLWJ1dHRvbiIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPHAgaWQ9Im1ldGVyUHJldmlvdXMiIGNsYXNzPSJtZXRlci1wcmV2aW91cyI+PC9wPgogICAgPHAgaWQ9Im1ldGVyVGFyZ2V0TW9udGgiIGNsYXNzPSJtdXRlZCI+PC9wPgogICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QWJsZXNlZGF0dW08aW5wdXQgaWQ9Im1ldGVyRGF0ZSIgdHlwZT0iZGF0ZSIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgPHNwYW4+PC9zcGFuPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5HZXNhbXQtWsOkaGxlcnN0YW5kIGtXaDxpbnB1dCBpZD0ibWV0ZXJUb3RhbCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiIHJlcXVpcmVkPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkFsdGVudGVpbC1aw6RobGVyc3RhbmQga1doPGlucHV0IGlkPSJtZXRlckFubmV4IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0ibWV0ZXJQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5Nb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXV0b21hdGlzY2ggYmVyZWNobmV0LjwvZGl2PgogICAgPHAgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+RGllIFfDpHJtZXB1bXBlIHdpcmQgbmljaHQgaGllciBlaW5nZXRyYWdlbi4gU2llIGtvbW10IGF1c3NjaGxpZcOfbGljaCBhdXMgZGVtIG15VkFJTExBTlQtQ1NWLUltcG9ydC48L3A+CiAgICA8cCBpZD0ibWV0ZXJWYWxpZGF0aW9uIiBjbGFzcz0idmFsaWRhdGlvbi10ZXh0Ij48L3A+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj48c3BhbiBjbGFzcz0ic3BhY2VyIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iIGRhdGEtY2xvc2UtbWV0ZXItbW9kYWw+QWJicmVjaGVuPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgdHlwZT0ic3VibWl0Ij5aw6RobGVyc3TDpG5kZSBzcGVpY2hlcm48L2J1dHRvbj48L2Rpdj4KICA8L2Zvcm0+CjwvZGl2PgoKPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJ0b2FzdCBoaWRkZW4iIHJvbGU9InN0YXR1cyIgYXJpYS1saXZlPSJwb2xpdGUiPjwvZGl2Pgo8c2NyaXB0IHNyYz0iYXBwLmpzP3Y9Ni4zLjQiPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K","type":"text/html; charset=utf-8","cache":"no-cache"},"/styles.css":{"body":"OnJvb3R7CiAgY29sb3Itc2NoZW1lOmRhcms7CiAgLS1iZzojMDYxMDFjOwogIC0tcGFuZWw6IzBjMWEyYTsKICAtLXBhbmVsMjojMTAyMjM1OwogIC0tbGluZTpyZ2JhKDE3MSwxOTgsMjIwLC4xNCk7CiAgLS10ZXh0OiNmNGY4ZmI7CiAgLS1tdXRlZDojOTRhOGJhOwogIC0tZ3JlZW46IzcyZGM1NzsKICAtLW9yYW5nZTojZmY5ZjQzOwogIC0tYmx1ZTojNGQ5Y2ZmOwogIC0teWVsbG93OiNmMmQxNWY7CiAgLS1yZWQ6I2ZmNmI2YjsKICAtLXNoYWRvdzowIDE4cHggNTVweCByZ2JhKDAsMCwwLC4yNCk7CiAgLS1yYWRpdXM6MjBweDsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbHtiYWNrZ3JvdW5kOnZhcigtLWJnKTttaW4taGVpZ2h0OjEwMCU7Zm9udC1mYW1pbHk6SW50ZXIsLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixzYW5zLXNlcmlmOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQpib2R5e21hcmdpbjowO2JhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCB0b3AgcmlnaHQscmdiYSg2MCwxMjAsMTcwLC4xMCksdHJhbnNwYXJlbnQgMzUlKSx2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7bWluLWhlaWdodDoxMDB2aH0KYnV0dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXR9CmJ1dHRvbntjdXJzb3I6cG9pbnRlcn0KYnV0dG9uOmRpc2FibGVke29wYWNpdHk6LjQ4O2N1cnNvcjpub3QtYWxsb3dlZH0KLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQouYXBwLXNoZWxse21heC13aWR0aDoxMTgwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjAgMjJweCAxMTJweH0KLnRvcGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6Y2FsYygxNnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKSAwIDE4cHg7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MzA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQodG8gYm90dG9tLHJnYmEoNiwxNiwyOCwuOTgpLHJnYmEoNiwxNiwyOCwuODYpLHJnYmEoNiwxNiwyOCwwKSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCl9Ci5icmFuZHtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0Ojg1MDtsZXR0ZXItc3BhY2luZzotLjAzZW19LmJyYW5kLW1hcmt7ZGlzcGxheTppbmxpbmUtZ3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6MzZweDtoZWlnaHQ6MzZweDtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxZTYzMzMsIzJmOGU0OSk7Ym94LXNoYWRvdzowIDZweCAyNHB4IHJnYmEoNTMsMTkwLDkxLC4xOCl9Ci5zdWJ0aXRsZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWxlZnQ6NDZweDttYXJnaW4tdG9wOi00cHh9LmJ1aWxkLXBpbGx7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4xMik7Y29sb3I6I2I5ZjVhYTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTE0LDIyMCw4NywuMjIpO3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLXJhZGl1czo5OTlweH0KbWFpbntkaXNwbGF5OmJsb2NrfS52aWV3e2Rpc3BsYXk6bm9uZTthbmltYXRpb246ZmFkZSAuMThzIGVhc2V9LnZpZXcuYWN0aXZle2Rpc3BsYXk6YmxvY2t9QGtleWZyYW1lcyBmYWRle2Zyb217b3BhY2l0eTouNTt0cmFuc2Zvcm06dHJhbnNsYXRlWSg0cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5wYWdlLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDoyMnB4O21hcmdpbjoxOHB4IDAgMjRweH0ucGFnZS1oZWFkIGgxe2ZvbnQtc2l6ZTpjbGFtcCgyOHB4LDV2dyw0NHB4KTttYXJnaW46M3B4IDAgN3B4O2xpbmUtaGVpZ2h0OjEuMDU7bGV0dGVyLXNwYWNpbmc6LS4wNGVtfS5wYWdlLWhlYWQgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7bWF4LXdpZHRoOjY4MHB4O2xpbmUtaGVpZ2h0OjEuNX0uZXllYnJvd3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xNmVtO2ZvbnQtd2VpZ2h0Ojg1MDtjb2xvcjojN2Y5ZGI0O21hcmdpbi1ib3R0b206NXB4fQoucGFuZWx7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHJnYmEoMTUsMzEsNDgsLjk2KSxyZ2JhKDEwLDI0LDM5LC45OCkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjE4cHg7Ym94LXNoYWRvdzp2YXIoLS1zaGFkb3cpfQoucGFuZWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE4cHh9LnBhbmVsLWhlYWQgaDJ7bWFyZ2luOjJweCAwIDJweDtmb250LXNpemU6MjFweDtsZXR0ZXItc3BhY2luZzotLjAyNWVtfS5wYW5lbC1oZWFkIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0KLnByaW1hcnksLnNlY29uZGFyeSwuZGFuZ2VyLC5maWxlLWJ1dHRvbnthcHBlYXJhbmNlOm5vbmU7Ym9yZGVyLXJhZGl1czoxM3B4O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnQ7cGFkZGluZzoxMXB4IDE1cHg7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLXRleHQpO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjhweDt0ZXh0LWRlY29yYXRpb246bm9uZTttaW4taGVpZ2h0OjQ0cHh9LnByaW1hcnl7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyZjhlNDksIzFmNmMzOCk7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMjgpO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDQ0LDE2MSw3NywuMTgpfS5wcmltYXJ5OmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMDYpfS5zZWNvbmRhcnksLmZpbGUtYnV0dG9ue2JhY2tncm91bmQ6IzEyMjYzYTtib3JkZXItY29sb3I6cmdiYSgxNzAsMjAwLDIyNCwuMTQpO2NvbG9yOiNkY2U5ZjN9LnNlY29uZGFyeTpob3ZlciwuZmlsZS1idXR0b246aG92ZXJ7YmFja2dyb3VuZDojMTczMDQ5fS5kYW5nZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xMCk7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjI1KTtjb2xvcjojZmZhYWE5fS5jb21wYWN0e21pbi1oZWlnaHQ6MzZweDtwYWRkaW5nOjhweCAxMXB4O2ZvbnQtc2l6ZToxM3B4fS5pY29uLWJ1dHRvbntib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjOWQ3ZTI7Zm9udC1zaXplOjMwcHg7bGluZS1oZWlnaHQ6MTtwYWRkaW5nOjAgNnB4fQoubWV0cmljLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNSxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxNnB4O21pbi13aWR0aDowfS5tZXRyaWMtZ3JpZCBhcnRpY2xlIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbTo3cHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZTpjbGFtcCgxOXB4LDN2dywyNnB4KTtsaW5lLWhlaWdodDoxLjE7ZGlzcGxheTpibG9jazt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Lm1ldHJpYy1ncmlkIGFydGljbGUgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojN2Y5NmFhO2ZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NnB4O2xpbmUtaGVpZ2h0OjEuMzV9LmNvbXBhcmlzb24tbGluZXttYXJnaW46MTVweCAwIDA7Y29sb3I6I2I4YzhkNTtmb250LXNpemU6MTNweH0uY29tcGFyaXNvbi1saW5lLnBvc2l0aXZle2NvbG9yOiNmZmIxYTh9LmNvbXBhcmlzb24tbGluZS5uZWdhdGl2ZXtjb2xvcjojYTVlNjlhfS5jb21wYXJpc29uLWxpbmUubmV1dHJhbHtjb2xvcjojYjhjOGQ1fQoub3N0cm9tLXBhbmVse292ZXJmbG93OmhpZGRlbn0ub3N0cm9tLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ucHJpY2UtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMGIxYjJiO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MThweH0ucHJpY2UtY2FyZDpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowIGF1dG8gMCAwO3dpZHRoOjRweDtiYWNrZ3JvdW5kOiM2ZDg1OTl9LnByaWNlLWNhcmQuYmVzdDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ncmVlbil9LnByaWNlLWNhcmQud29yc3Q6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tcmVkKX0ucHJpY2UtY2FyZC5jdXJyZW50OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLWJsdWUpfS5wcmljZS1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9LnByaWNlLWNhcmQgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjI3cHg7bWFyZ2luOjhweCAwIDRweH0ucHJpY2UtY2FyZCBzbWFsbHtjb2xvcjojOWNiMGMwfS5lbXB0eS1zdGF0ZXtib3JkZXI6MXB4IGRhc2hlZCByZ2JhKDE3MCwyMDAsMjI0LC4yKTtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjAyKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6OXB4IDE0cHg7YWxpZ24taXRlbXM6Y2VudGVyfS5lbXB0eS1zdGF0ZSBzdHJvbmd7d2lkdGg6MTAwJX0uZW1wdHktc3RhdGUgc3Bhbntjb2xvcjp2YXIoLS1tdXRlZCk7ZmxleDoxO21pbi13aWR0aDoyMDBweH0ucHJpY2UtY2hhcnQtd3JhcHttYXJnaW4tdG9wOjE2cHh9Ci5jaGFydC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDoyNjBweDt3aWR0aDoxMDAlO21pbi13aWR0aDowfS5jaGFydC13cmFwLmxhcmdle2hlaWdodDozNDBweH0uY2hhcnQtd3JhcCBjYW52YXN7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtkaXNwbGF5OmJsb2NrfS5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjI2MHB4fS5sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNXB4O21hcmdpbjotNnB4IDAgMTRweDtjb2xvcjojYjhjNmQyO2ZvbnQtc2l6ZToxMnB4fS5sZWdlbmQgc3BhbjpiZWZvcmV7Y29udGVudDoiIjtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjNweDttYXJnaW4tcmlnaHQ6NnB4fS5sZWdlbmQgLmhlYXQ6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tb3JhbmdlKX0ubGVnZW5kIC5hbm5leDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ibHVlKX0ubGVnZW5kIC5yZXN0OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyl9Ci5yZWNvcmQtdG9vbGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MTRweH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0LC5maWx0ZXItcGFuZWwgc2VsZWN0e2JhY2tncm91bmQ6IzBiMWEyYTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEwcHggMTJweH0ucmVjb3JkLWxpc3R7ZGlzcGxheTpncmlkO2dhcDoxMHB4fS5yZWNvcmQtcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6bWlubWF4KDE1MHB4LDEuM2ZyKSByZXBlYXQoNCxtaW5tYXgoOTBweCwuODVmcikpIGF1dG87Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGExOTI4O2JvcmRlci1yYWRpdXM6MTVweDtwYWRkaW5nOjEzcHggMTRweH0ucmVjb3JkLXJvdzpob3ZlcntiYWNrZ3JvdW5kOiMwZTIwMzJ9LnJlY29yZC1tb250aCBzdHJvbmd7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTVweH0ucmVjb3JkLW1vbnRoIHNtYWxse2Rpc3BsYXk6YmxvY2s7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6M3B4fS5yZWNvcmQtdmFsdWUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOiM3Zjk2YWE7Zm9udC1zaXplOjEwcHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wOGVtfS5yZWNvcmQtdmFsdWUgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kfS5yZWNvcmQtcm93LmludmFsaWR7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjMpfQouZmlsdGVyLXBhbmVse2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczplbmR9LmZpbHRlci1wYW5lbCBsYWJlbHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWluLXdpZHRoOjE1MHB4fS5hbmFseXNpcy1tZXRyaWNze21hcmdpbi1ib3R0b206MThweH0uYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDUsbWlubWF4KDAsMWZyKSl9Ci50YWJsZS1zY3JvbGx7b3ZlcmZsb3c6YXV0bztib3JkZXItcmFkaXVzOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzIwcHh9dGgsdGR7cGFkZGluZzoxMnB4IDEzcHg7dGV4dC1hbGlnbjpyaWdodDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmb250LXNpemU6MTNweH10aDpmaXJzdC1jaGlsZCx0ZDpmaXJzdC1jaGlsZHt0ZXh0LWFsaWduOmxlZnR9dGh7Zm9udC1zaXplOjExcHg7Y29sb3I6Izg4YTBiNTtsZXR0ZXItc3BhY2luZzouMDVlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7YmFja2dyb3VuZDojMGExOTI4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MH10Ym9keSB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLmNvbXBhY3QtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSl9Lmlzc3VlLWxpc3R7ZGlzcGxheTpncmlkO2dhcDo4cHg7bWFyZ2luLXRvcDoxNHB4fS5pc3N1ZXtkaXNwbGF5OmZsZXg7Z2FwOjEycHg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTJweCAxM3B4O2JvcmRlci1yYWRpdXM6MTNweDtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0uaXNzdWUud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yMil9Lmlzc3VlLmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4yNSl9Lmlzc3VlIGRpdnttaW4td2lkdGg6MH0uaXNzdWUgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEzcHh9Lmlzc3VlIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6M3B4fS5tdXRlZHtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS41NX0uYWN0aW9uLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5zdGF0dXMtdGV4dHttaW4taGVpZ2h0OjEuNGVtO21hcmdpbjoxMnB4IDAgMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHh9LnN0YXR1cy10ZXh0Lm9re2NvbG9yOiNhNWU2OWF9LnN0YXR1cy10ZXh0LmVycm9ye2NvbG9yOiNmZmFhYTl9LnNldHRpbmdzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTNweDttYXJnaW46MTRweCAwfS5maWVsZHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjojOWRiMGMwO2ZvbnQtc2l6ZToxMnB4fS5maWVsZCBpbnB1dCwuZmllbGQgc2VsZWN0LC5maWVsZCB0ZXh0YXJlYXt3aWR0aDoxMDAlO2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTcxLDE5OCwyMjAsLjE2KTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEycHg7b3V0bGluZTpub25lfS5maWVsZCBpbnB1dDpmb2N1cywuZmllbGQgc2VsZWN0OmZvY3VzLC5maWVsZCB0ZXh0YXJlYTpmb2N1c3tib3JkZXItY29sb3I6cmdiYSg3NywxNTYsMjU1LC41NSk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NywxNTYsMjU1LC4wOCl9LnN3aXRjaC1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjExcHggMTNweDtjb2xvcjojYzdkNWRmfS5zd2l0Y2gtcm93IGlucHV0e3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7YWNjZW50LWNvbG9yOiMzYzlhNTN9Ci5iYW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTZweDttYXJnaW46MTJweCAwIDE4cHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxNXB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGQyMDMyfS5iYW5uZXIud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yOCk7YmFja2dyb3VuZDpyZ2JhKDI0MiwyMDksOTUsLjA2KX0uYmFubmVyIHN0cm9uZywuYmFubmVyIHNwYW57ZGlzcGxheTpibG9ja30uYmFubmVyIHNwYW57Y29sb3I6I2IzYzBjYTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjNweH0KLmJvdHRvbS1uYXZ7cG9zaXRpb246Zml4ZWQ7ei1pbmRleDo0MDtsZWZ0OjUwJTtib3R0b206bWF4KDEycHgsZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7d2lkdGg6bWluKDYyMHB4LGNhbGMoMTAwJSAtIDI0cHgpKTtiYWNrZ3JvdW5kOnJnYmEoOCwyMCwzMywuOTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTYpO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjdweDtib3gtc2hhZG93OjAgMTZweCA1MHB4IHJnYmEoMCwwLDAsLjQyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxNnB4KX0uYm90dG9tLW5hdiBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojODU5OWFhO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjlweCA4cHg7ZGlzcGxheTpncmlkO2dhcDozcHg7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MDttaW4td2lkdGg6MH0uYm90dG9tLW5hdiBidXR0b24gc3Bhbntmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfS5ib3R0b20tbmF2IGJ1dHRvbi5hY3RpdmV7YmFja2dyb3VuZDojMTUzMTQ3O2NvbG9yOiNmNGY4ZmJ9Ci5tb2RhbHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7cGFkZGluZzoxOHB4fS5tb2RhbC1iYWNrZHJvcHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNzIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDVweCl9Lm1vZGFsLWNhcmR7cG9zaXRpb246cmVsYXRpdmU7d2lkdGg6bWluKDc2MHB4LDEwMCUpO21heC1oZWlnaHQ6Y2FsYygxMDB2aCAtIDM2cHgpO292ZXJmbG93OmF1dG87YmFja2dyb3VuZDojMGIxYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTgpO2JvcmRlci1yYWRpdXM6MjJweDtwYWRkaW5nOjIycHg7Ym94LXNoYWRvdzowIDMwcHggOTBweCByZ2JhKDAsMCwwLC41NSl9Lm1vZGFsLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxOHB4fS5tb2RhbC1oZWFkIGgye21hcmdpbjoycHggMCAwfS5mb3JtLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0uZGVyaXZlZC1wcmV2aWV3e21hcmdpbjoxNHB4IDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTJweCAxNHB4O2ZvbnQtd2VpZ2h0OjgwMH0uZGVyaXZlZC1wcmV2aWV3LmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zNSk7Y29sb3I6I2ZmYWFhOX0uZGV0YWlscy1jYXJke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbjoxMnB4IDA7YmFja2dyb3VuZDojMDgxNzI1fS5kZXRhaWxzLWNhcmQgc3VtbWFyeXtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjEycHggMTRweDtjb2xvcjojYzdkNWRmO2ZvbnQtd2VpZ2h0OjcwMH0uZGV0YWlscy1jYXJkIC5kZXRhaWwtZ3JpZHtwYWRkaW5nOjAgMTRweCAxNHB4fS52YWxpZGF0aW9uLXRleHR7bWluLWhlaWdodDoxLjJlbTtjb2xvcjojZmZhYWE5O2ZvbnQtc2l6ZToxMnB4fS5tb2RhbC1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OXB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjE2cHh9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntmbGV4OjF9Ci50b2FzdHtwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjE1MDtsZWZ0OjUwJTtib3R0b206MTAwcHg7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7YmFja2dyb3VuZDojMTkzNjRkO2NvbG9yOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIwMCwyMjAsMjM2LC4xNik7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTFweCAxNXB4O2JveC1zaGFkb3c6MCAxNnB4IDUwcHggcmdiYSgwLDAsMCwuNCk7bWF4LXdpZHRoOm1pbig5MHZ3LDU2MHB4KTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpey5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9LnJlY29yZC1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxNTBweCwxLjJmcikgcmVwZWF0KDIsbWlubWF4KDk1cHgsLjhmcikpIGF1dG99LnJlY29yZC1yb3cgLnJlY29yZC12YWx1ZTpudGgtb2YtdHlwZSg0KSwucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVlOm50aC1vZi10eXBlKDUpe2Rpc3BsYXk6bm9uZX0ub3N0cm9tLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnByaWNlLWNhcmQuY3VycmVudHtncmlkLWNvbHVtbjoxLy0xfS5jb21wYWN0LW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfX0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmFwcC1zaGVsbHtwYWRkaW5nOjAgMTJweCAxMDRweH0udG9wYmFye3BhZGRpbmctbGVmdDo0cHg7cGFkZGluZy1yaWdodDo0cHh9LmJyYW5ke2ZvbnQtc2l6ZToyMXB4fS5icmFuZC1tYXJre3dpZHRoOjMzcHg7aGVpZ2h0OjMzcHh9LnN1YnRpdGxle21hcmdpbi1sZWZ0OjQzcHh9LnBhZ2UtaGVhZHthbGlnbi1pdGVtczpzdHJldGNoO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjttYXJnaW4tdG9wOjlweH0ucGFnZS1oZWFkIC5wcmltYXJ5e3dpZHRoOjEwMCV9LnBhZ2UtaGVhZCBoMXtmb250LXNpemU6MzFweH0ucGFuZWx7cGFkZGluZzoxNnB4O2JvcmRlci1yYWRpdXM6MTdweDttYXJnaW4tYm90dG9tOjEzcHh9LnBhbmVsLWhlYWR7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5wYW5lbC1oZWFkIGgye2ZvbnQtc2l6ZToxOHB4fS5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsbWlubWF4KDAsMWZyKSk7Z2FwOjlweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtwYWRkaW5nOjEzcHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZToyMHB4fS5vc3Ryb20tZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5wcmljZS1jYXJkLmN1cnJlbnR7Z3JpZC1jb2x1bW46YXV0b30ucHJpY2UtY2FyZHtwYWRkaW5nOjE1cHh9LnByaWNlLWNhcmQgc3Ryb25ne2ZvbnQtc2l6ZToyNHB4fS5jaGFydC13cmFwLC5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjIyNXB4fS5jaGFydC13cmFwLmxhcmdle2hlaWdodDoyNzBweH0ucmVjb3JkLXRvb2xiYXJ7YWxpZ24taXRlbXM6c3RyZXRjaH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0e21heC13aWR0aDoxNDVweH0ucmVjb3JkLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjlweH0ucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVle2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9LnJlY29yZC1yb3cgLmVkaXQtcmVjb3Jke2dyaWQtY29sdW1uOjI7Z3JpZC1yb3c6MX0ucmVjb3JkLW1vbnRoIHNtYWxse21heC13aWR0aDoyMzBweH0uZmlsdGVyLXBhbmVse2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtwYWRkaW5nOjE0cHh9LmZpbHRlci1wYW5lbCBsYWJlbHttaW4td2lkdGg6MH0uc2V0dGluZ3MtZ3JpZCwuZm9ybS1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmRldGFpbHMtY2FyZCAuZGV0YWlsLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uYWN0aW9uLXJvdz4qe2ZsZXg6MSAxIDE1MHB4fS5ib3R0b20tbmF2e3dpZHRoOmNhbGMoMTAwJSAtIDE2cHgpO2JvdHRvbTptYXgoOHB4LGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7Ym9yZGVyLXJhZGl1czoxN3B4fS5ib3R0b20tbmF2IGJ1dHRvbntmb250LXNpemU6MTBweDtwYWRkaW5nOjhweCAzcHh9LmJvdHRvbS1uYXYgYnV0dG9uIHNwYW57Zm9udC1zaXplOjE4cHh9Lm1vZGFse3BhZGRpbmc6OHB4fS5tb2RhbC1jYXJke3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE4cHg7bWF4LWhlaWdodDpjYWxjKDEwMHZoIC0gMTZweCl9Lm1vZGFsLWFjdGlvbnN7ZmxleC13cmFwOndyYXB9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntkaXNwbGF5Om5vbmV9Lm1vZGFsLWFjdGlvbnMgYnV0dG9ue2ZsZXg6MSAxIDEyMHB4fS5iYW5uZXJ7YWxpZ24taXRlbXM6c3RyZXRjaDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59LmJhbm5lciBidXR0b257YWxpZ24tc2VsZjpmbGV4LXN0YXJ0fX0KQG1lZGlhKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsqe3Njcm9sbC1iZWhhdmlvcjphdXRvIWltcG9ydGFudDthbmltYXRpb246bm9uZSFpbXBvcnRhbnQ7dHJhbnNpdGlvbjpub25lIWltcG9ydGFudH19CgovKiBFbGRlaG9mIDYuMC4xIOKAkyBsb2thbGVyIG15VkFJTExBTlQtSW1wb3J0ICovCiN2YWlsbGFudEltcG9ydFBhbmVsIC5hY3Rpb24tcm93e21hcmdpbi10b3A6MTRweH0KI3ZhaWxsYW50SW1wb3J0U3RhdHVzLm9re2NvbG9yOiNhNWU2OWF9CiN2YWlsbGFudEltcG9ydFN0YXR1cy5lcnJvcntjb2xvcjojZmZhYWE5fQoKLyogRWxkZWhvZiA2LjEuMCDigJMgWsOkaGxlcnN0w6RuZGUgYWxzIGVpbnppZ2UgbWFudWVsbGUgVmVyYnJhdWNoc2VpbmdhYmUgKi8KLnJlY29yZC1zdGF0dXMtYmFkZ2V7anVzdGlmeS1zZWxmOmVuZDtmb250LXNpemU6MTFweDtjb2xvcjojOWRiMGMwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzo2cHggOHB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDojMDgxNzI1fQoubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfQoubWV0ZXItaGlzdG9yeXtkaXNwbGF5OmdyaWQ7Z2FwOjdweDttYXJnaW46MTRweCAwfS5tZXRlci1oaXN0b3J5LXJvd3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxMDBweCwxZnIpIHJlcGVhdCgyLG1pbm1heCgxMTBweCwxZnIpKSBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjEwcHggMTJweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiMwODE3MjU7Zm9udC1zaXplOjEycHh9Lm1ldGVyLWhpc3Rvcnktcm93IHNwYW4sLm1ldGVyLWhpc3Rvcnktcm93IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0ubWV0ZXItaGlzdG9yeS1yb3cgc3Ryb25ne2ZvbnQtc2l6ZToxMnB4fS5tZXRlci1hY3Rpb25ze21hcmdpbi10b3A6MTJweH0ubWV0ZXItcHJldmlvdXN7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1O2NvbG9yOiNiOWM3ZDI7bGluZS1oZWlnaHQ6MS41fS5jb21wYWN0LW5vdGV7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfS5tZXRlci1sYXRlc3QubWV0cmljLWdyaWQgYXJ0aWNsZTpmaXJzdC1jaGlsZHtncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0ubWV0ZXItaGlzdG9yeS1yb3cgc3BhbntncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvdyBzbWFsbHtkaXNwbGF5Om5vbmV9LnJlY29yZC1zdGF0dXMtYmFkZ2V7Zm9udC1zaXplOjEwcHh9fQoKLyogRWxkZWhvZiA2LjEuMSDigJMgTW9uYXRzd2VydGUgd2llZGVyIGJlYXJiZWl0YmFyICovCi5maWVsZCBpbnB1dFtyZWFkb25seV17b3BhY2l0eTouNzI7Y3Vyc29yOmRlZmF1bHQ7YmFja2dyb3VuZDojMGIxNzIyfS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kO3doaXRlLXNwYWNlOm5vd3JhcH0KCi8qIEVsZGVob2YgNi4yLjAgKi8KLmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e2Rpc3BsYXk6Z3JpZDtnYXA6NXB4O2ZsZXg6MTttaW4td2lkdGg6MjQwcHg7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDojMGIxYTJhfS5hbmFseXNpcy1hbGwteWVhcnMtaGludCBzdHJvbmd7Zm9udC1zaXplOjEzcHh9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50IHNwYW57Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2xpbmUtaGVpZ2h0OjEuNH0ueWVhci1jb21wYXJpc29uLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHggMTZweDttYXJnaW46LTRweCAwIDEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgc3BhbntkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2NvbG9yOiNiOGM2ZDI7Zm9udC1zaXplOjEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgaXtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDoyOHB4O2hlaWdodDowO2JvcmRlci10b3A6M3B4IHNvbGlkIGN1cnJlbnRDb2xvcn0ueWVhci1jb21wYXJpc29uLWxlZ2VuZCAucGFzdCBpe2JvcmRlci10b3Atc3R5bGU6ZGFzaGVkfS5zeW5jLWJhZGdle2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGIxYTJhO2NvbG9yOnZhcigtLW11dGVkKTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6ODAwfS5zeW5jLWJhZGdlLm9re2NvbG9yOiNhNWU2OWE7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMyl9LnN5bmMtYmFkZ2UuYnVzeXtjb2xvcjojOWZkMGZmO2JvcmRlci1jb2xvcjpyZ2JhKDc3LDE1NiwyNTUsLjM1KX0uc3luYy1iYWRnZS5lcnJvcntjb2xvcjojZmZhYWE5O2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zKX0uc3luYy1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfS5zeW5jLWpvaW4tYm94e21hcmdpbi10b3A6MTRweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nLXRvcDoxMnB4fS5zeW5jLWpvaW4tYm94IHN1bW1hcnl7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6I2RjZTlmMztmb250LXdlaWdodDo4MDB9LnN5bmMtcGFpci1yZXN1bHR7ZGlzcGxheTpncmlkO2dhcDo3cHg7bWFyZ2luLXRvcDoxNHB4O3BhZGRpbmc6MTRweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzcsMTU2LDI1NSwuMjgpO2JhY2tncm91bmQ6IzBhMWQzMDtib3JkZXItcmFkaXVzOjE0cHh9LnN5bmMtcGFpci1yZXN1bHQgc3Bhbiwuc3luYy1wYWlyLXJlc3VsdCBzbWFsbHtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjExcHh9LnN5bmMtcGFpci1yZXN1bHQgY29kZXtkaXNwbGF5OmJsb2NrO3dvcmQtYnJlYWs6YnJlYWstYWxsO2NvbG9yOiNkYmVlZmY7YmFja2dyb3VuZDojMDcxNDIxO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6OHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH1AbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsuZmlsdGVyLXBhbmVse2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e21pbi13aWR0aDowfS5zeW5jLW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnN5bmMtbWV0cmljcy5tZXRyaWMtZ3JpZCBhcnRpY2xlOmxhc3QtY2hpbGR7Z3JpZC1jb2x1bW46MS8tMX19CgoucHJpY2UtcnVubmluZ3tkaXNwbGF5OmlubGluZS1ibG9jazttYXJnaW4tbGVmdDo1cHg7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDpyZ2JhKDc3LDE1NiwyNTUsLjEyKTtjb2xvcjojOWZkMGZmO2ZvbnQtc2l6ZTo5cHg7Zm9udC13ZWlnaHQ6ODAwO3ZlcnRpY2FsLWFsaWduOm1pZGRsZX0ucHJpY2Utc3RhdHMtbm90ZXtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9CgovKiBFbGRlaG9mIDYuMy4xIOKAkyBLbGltYS1Db2NrcGl0OiByZXNwb25zaXZlIGFuZCBsZWdpYmxlIGFjcm9zcyBpT1MsIEFuZHJvaWQgYW5kIGRlc2t0b3AuICovCi5kYXNoYm9hcmQtY2xpbWF0ZS1wYW5lbHtvdmVyZmxvdzpoaWRkZW59Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzLm1ldHJpYy1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSk7bWFyZ2luLWJvdHRvbToxOHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtY2hhcnQtdG9we2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7bWFyZ2luOjEwcHggMH0KLmRhc2hib2FyZC1jbGltYXRlLWNoYXJ0LXRvcD5zdHJvbmd7Zm9udC1zaXplOjE0cHg7Y29sb3I6I2NjZGFlNX0KLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaHtkaXNwbGF5OmlubGluZS1mbGV4O2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTNweDtwYWRkaW5nOjRweDtnYXA6M3B4fQouZGFzaGJvYXJkLWNsaW1hdGUtc3dpdGNoIGJ1dHRvbntib3JkZXI6MDtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojOWViMmM0O2ZvbnQ6aW5oZXJpdDtmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7cGFkZGluZzo5cHggMTNweDtjdXJzb3I6cG9pbnRlcn0KLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6IzFiM2I1MTtjb2xvcjojZWVmYWZmfQouZGFzaGJvYXJkLWNsaW1hdGUtc3dpdGNoIGJ1dHRvbjpmb2N1cy12aXNpYmxle291dGxpbmU6MnB4IHNvbGlkICM4M2M3ZWM7b3V0bGluZS1vZmZzZXQ6MnB4fQouZGFzaGJvYXJkLWNsaW1hdGUtY2hhcnQtd3JhcC5jaGFydC13cmFwe2hlaWdodDoyMzVweH0KLmRhc2hib2FyZC1jbGltYXRlLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjlweCAxNXB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiNiNWM3ZDU7bWFyZ2luLXRvcDoxMHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtbGVnZW5kIHNwYW46OmJlZm9yZXtjb250ZW50OiIiO3dpZHRoOjEwcHg7aGVpZ2h0OjEwcHg7Ym9yZGVyLXJhZGl1czozcHg7ZGlzcGxheTppbmxpbmUtYmxvY2s7YmFja2dyb3VuZDp2YXIoLS1sZWdlbmQtY29sb3IpO21hcmdpbi1yaWdodDo2cHg7dmVydGljYWwtYWxpZ246YmFzZWxpbmV9Ci5kYXNoYm9hcmQtY2xpbWF0ZS10cmVuZHtjb2xvcjojYjhjYmQ4O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNDU7bWFyZ2luOjEwcHggMCAwO21pbi1oZWlnaHQ6MThweH0KLmRhc2hib2FyZC1jbGltYXRlLWZvb3RlcntkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2dhcDoxMnB4O2ZsZXgtd3JhcDp3cmFwO21hcmdpbi10b3A6OHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtZm9vdGVyIC5zdGF0dXMtdGV4dHtmbGV4OjEgMSAxNjBweDttYXJnaW46MDtmb250LXNpemU6MTJweH0KI2NsaW1hdGVBbmFseXNpc1BhbmVse3Njcm9sbC1tYXJnaW4tdG9wOjEwMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsKIC5kYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0KIC5kYXNoYm9hcmQtY2xpbWF0ZS1jaGFydC13cmFwLmNoYXJ0LXdyYXB7aGVpZ2h0OjIxNXB4fQogLmRhc2hib2FyZC1jbGltYXRlLXBhbmVsIC5wYW5lbC1oZWFke2FsaWduLWl0ZW1zOmZsZXgtc3RhcnR9CiAuZGFzaGJvYXJkLWNsaW1hdGUtcGFuZWwgLnBhbmVsLWhlYWQgYnV0dG9ue21heC13aWR0aDo0MCU7d2hpdGUtc3BhY2U6bm9ybWFsfQogLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCBidXR0b257cGFkZGluZzo5cHggMTBweDtmb250LXNpemU6MTJweH0KIC5kYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIgYnV0dG9ue3dpZHRoOjEwMCV9Cn0KCi8qIDYuMy4zOiBsZWdpYmxlIGFubnVhbCBlbmVyZ3kvdGVtcGVyYXR1cmUgY29tcGFyaXNvbnMgKi8KLmNsaW1hdGUtZGFzaGJvYXJkLWhlYWR7YWxpZ24taXRlbXM6Y2VudGVyfQouZGFzaGJvYXJkLWNsaW1hdGUteWVhci1maWVsZHtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo0cHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxMnB4O21pbi13aWR0aDoxMDJweH0KLmRhc2hib2FyZC1jbGltYXRlLXllYXItZmllbGQgc2VsZWN0e3dpZHRoOjEwMCU7YmFja2dyb3VuZDojMGIyMTMyO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzEsMTk4LDIyMCwuMyk7Ym9yZGVyLXJhZGl1czoxMXB4O2NvbG9yOnZhcigtLXRleHQpO3BhZGRpbmc6OXB4IDExcHg7Zm9udDppbmhlcml0O2ZvbnQtc2l6ZToxNXB4O2ZvbnQtd2VpZ2h0OjcwMDttaW4taGVpZ2h0OjQycHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1pbnRyb3ttYXJnaW46MCAwIDE2cHg7Zm9udC1zaXplOjEzcHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1jaGFydC13cmFwLmNoYXJ0LXdyYXB7aGVpZ2h0OjI3MHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtZXhwbGFuYXRpb257Y29sb3I6I2I5Y2NkYztmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjU7bWFyZ2luOjdweCAwIDE5cHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC10aXRsZXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6YmFzZWxpbmU7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo3MDA7bWFyZ2luOjEwcHggMCA5cHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC10aXRsZSBzbWFsbHtmb250LXdlaWdodDo0MDA7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0ZWQpfQouZGFzaGJvYXJkLWNsaW1hdGUtbW9udGhze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDEyLG1pbm1heCgwLDFmcikpO2dhcDo1cHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aHMgYnV0dG9ue21pbi13aWR0aDowO3BhZGRpbmc6OXB4IDFweDtib3JkZXItcmFkaXVzOjlweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTYxLDE5NiwyMjMsLjIpO2JhY2tncm91bmQ6IzBiMWMyYztjb2xvcjojYWVjMWQyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjcwMDtjdXJzb3I6cG9pbnRlcn0KLmRhc2hib2FyZC1jbGltYXRlLW1vbnRocyBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6IzI0NDk1ZTtib3JkZXItY29sb3I6Izc4YjVkNztjb2xvcjojZmZmfQouZGFzaGJvYXJkLWNsaW1hdGUtbW9udGhzIGJ1dHRvbjpmb2N1cy12aXNpYmxle291dGxpbmU6MnB4IHNvbGlkICNhNGQ0ZWY7b3V0bGluZS1vZmZzZXQ6MnB4fQouZGFzaGJvYXJkLWNsaW1hdGUtbW9udGgtZGV0YWlse2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzEsMTk4LDIyMCwuMTgpO2JhY2tncm91bmQ6cmdiYSgxNiwzOCw1NiwuNyk7Ym9yZGVyLXJhZGl1czoxNXB4O3BhZGRpbmc6MTZweDttYXJnaW46MTJweCAwIDB9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC1kZXRhaWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6YmFzZWxpbmU7ZmxleC13cmFwOndyYXA7Z2FwOjVweCAxMnB4O21hcmdpbi1ib3R0b206MTJweH0KLmRhc2hib2FyZC1jbGltYXRlLW1vbnRoLWRldGFpbC1oZWFkIHN0cm9uZ3tmb250LXNpemU6MThweH0uZGFzaGJvYXJkLWNsaW1hdGUtbW9udGgtZGV0YWlsLWhlYWQgc21hbGx7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlmZDFlNn0KLmRhc2hib2FyZC1jbGltYXRlLW1vbnRoLWRldGFpbC1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSk7Z2FwOjEycHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC1kZXRhaWwtZ3JpZCBkaXZ7bWluLXdpZHRoOjB9LmRhc2hib2FyZC1jbGltYXRlLW1vbnRoLWRldGFpbC1ncmlkIHNwYW57ZGlzcGxheTpibG9jaztmb250LXNpemU6MTFweDtjb2xvcjojOTJhZGMwO21hcmdpbi1ib3R0b206NHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtbW9udGgtZGV0YWlsLWdyaWQgc3Ryb25ne2ZvbnQtc2l6ZToxN3B4O2xpbmUtaGVpZ2h0OjEuMzt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tb250aC1kZXRhaWw+cHtmb250LXNpemU6MTJweDtjb2xvcjojYjFjOGQ2O21hcmdpbjoxM3B4IDAgMDtsaW5lLWhlaWdodDoxLjV9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwfQpAbWVkaWEobWF4LXdpZHRoOjY1MHB4KXsKLmRhc2hib2FyZC1jbGltYXRlLW1vbnRoc3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDYsbWlubWF4KDAsMWZyKSk7Z2FwOjZweH0KLmRhc2hib2FyZC1jbGltYXRlLW1vbnRoLWRldGFpbC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0KLmRhc2hib2FyZC1jbGltYXRlLWNoYXJ0LXdyYXAuY2hhcnQtd3JhcHtoZWlnaHQ6MjQwcHh9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIgLmRhc2hib2FyZC1jbGltYXRlLWFjdGlvbnN7d2lkdGg6MTAwJTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9Ci5kYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIgLmRhc2hib2FyZC1jbGltYXRlLWFjdGlvbnMgYnV0dG9ue3dpZHRoOjEwMCU7Zm9udC1zaXplOjEycHg7cGFkZGluZzoxMHB4IDVweH0KfQoKLyogNi4zLjQ6IHdlYXRoZXIgYW5kIGhlYXQtcHVtcCBwb3dlciBhbGlnbmVkIG1vbnRobHkgY29tcGFyaXNvbiAqLwouY2xpbWF0ZS1jb3VwbGVkLWludHJve2ZvbnQtc2l6ZToxM3B4O21hcmdpbjotMnB4IDAgMTJweH0KLmNsaW1hdGUtY291cGxlZC1sZWdlbmR7ZGlzcGxheTpmbGV4O2dhcDoxNnB4O2ZsZXgtd3JhcDp3cmFwO21hcmdpbjowIDAgMTNweDtjb2xvcjojZDdlNmVmO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTRweH0KLmNsaW1hdGUtY291cGxlZC1sZWdlbmQgc3BhbntkaXNwbGF5OmZsZXg7Z2FwOjdweDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5jbGltYXRlLWNvdXBsZWQtbGVnZW5kIGksLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgdGggaXt3aWR0aDoxMnB4O2hlaWdodDoxMnB4O2JvcmRlci1yYWRpdXM6NHB4O2Rpc3BsYXk6aW5saW5lLWJsb2NrO2ZsZXg6bm9uZX0KLmNsaW1hdGUtY291cGxlZC1yYW5nZXtkaXNwbGF5OmlubGluZS1mbGV4O2dhcDozcHg7cGFkZGluZzo0cHg7YmFja2dyb3VuZDojMDgxNzI1O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4fQouY2xpbWF0ZS1jb3VwbGVkLXJhbmdlIGJ1dHRvbntwYWRkaW5nOjlweCAxM3B4O2JvcmRlci1yYWRpdXM6OXB4O2ZvbnQtd2VpZ2h0OjYwMDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjowO2NvbG9yOiNiNWM1ZDY7Y3Vyc29yOnBvaW50ZXI7Zm9udC1zaXplOjEzcHh9Ci5jbGltYXRlLWNvdXBsZWQtcmFuZ2UgYnV0dG9uLmFjdGl2ZXtiYWNrZ3JvdW5kOiMxYjNiNTE7Y29sb3I6I2ZmZn0KLmNsaW1hdGUtY291cGxlZC10aW1lZnJhbWV7Zm9udC1zaXplOjEycHg7Y29sb3I6Izk5YWZiZTttYXJnaW46OXB4IDAgMThweH0KLmNsaW1hdGUtY291cGxlZC1wbG90e21hcmdpbjowIDAgMThweH0KLmNsaW1hdGUtY291cGxlZC10aXRsZXtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjVweCAxMnB4O2FsaWduLWl0ZW1zOmJhc2VsaW5lO21hcmdpbi1ib3R0b206NXB4fQouY2xpbWF0ZS1jb3VwbGVkLXRpdGxlIHN0cm9uZ3tmb250LXNpemU6MTZweH0KLmNsaW1hdGUtY291cGxlZC10aXRsZSBzcGFue2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5NGFiYmF9Ci5jbGltYXRlLWNvdXBsZWQtY2hhcnQuY2hhcnQtd3JhcHtoZWlnaHQ6MjA4cHh9Ci5jbGltYXRlLWNvdXBsZWQtbm90aWNle2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTtjb2xvcjojYThiZWQwO21hcmdpbjo1cHggMCAxNXB4fQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnl7cGFkZGluZzoxNHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSgxMjUsMTg2LDIxNiwuMjUpO2JhY2tncm91bmQ6IzEwMjczYTtib3JkZXItcmFkaXVzOjE1cHg7bWFyZ2luOjEwcHggMCAyMHB4fQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnk+c3Ryb25ne2ZvbnQtc2l6ZToxNHB4O2Rpc3BsYXk6YmxvY2t9Ci5jbGltYXRlLWNvdXBsZWQtc3VtbWFyeT5we2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTtjb2xvcjojYWRjMmQzO21hcmdpbjo5cHggMCAwfQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnktbWV0cmljc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgzLG1pbm1heCgwLDFmcikpO2dhcDo4cHg7bWFyZ2luLXRvcDoxMnB4fQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnktbWV0cmljcz5kaXZ7YmFja2dyb3VuZDojMGExYzJjO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEwcHg7bWluLXdpZHRoOjB9Ci5jbGltYXRlLWNvdXBsZWQtc3VtbWFyeS1tZXRyaWNzIHNwYW4sLmNsaW1hdGUtY291cGxlZC1zdW1tYXJ5LW1ldHJpY3Mgc21hbGx7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTFweDtjb2xvcjojYTFiYmNhO2xpbmUtaGVpZ2h0OjEuNDV9Ci5jbGltYXRlLWNvdXBsZWQtc3VtbWFyeS1tZXRyaWNzIHN0cm9uZ3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxOHB4O21hcmdpbjo1cHggMDt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Ci5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlse2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzEsMTk4LDIyMCwuMik7YmFja2dyb3VuZDpyZ2JhKDEwLDI3LDQyLC42KTtib3JkZXItcmFkaXVzOjE1cHg7cGFkZGluZzoxM3B4O21hcmdpbi10b3A6MTNweH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1oZWFkZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmJhc2VsaW5lO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2ZsZXgtd3JhcDp3cmFwO2dhcDo1cHggMTRweDttYXJnaW46MnB4IDAgMTBweH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1oZWFkZXIgc3Ryb25ne2ZvbnQtc2l6ZToxNXB4fS5jbGltYXRlLWNvdXBsZWQtbW9udGgtaGVhZGVyIHNwYW57Zm9udC1zaXplOjEycHg7Y29sb3I6I2EzYmFjZH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgLnRhYmxlLXNjcm9sbHtvdmVyZmxvdy14OmF1dG99Ci5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlsIHRhYmxle3dpZHRoOjEwMCU7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlO3doaXRlLXNwYWNlOm5vd3JhcDtmb250LXNpemU6MTJweH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgdGgsLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgdGR7cGFkZGluZzoxMHB4IDExcHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSgxNzEsMTk4LDIyMCwuMTIpO3RleHQtYWxpZ246bGVmdH0KLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWwgdGh7Y29sb3I6I2I5ZDFkZn0uY2xpbWF0ZS1jb3VwbGVkLW1vbnRoLWRldGFpbCB0Ym9keSB0aHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo3cHh9Ci5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlsIHB7Zm9udC1zaXplOjEycHg7bGluZS1oZWlnaHQ6MS42O2NvbG9yOiNjM2Q0ZGU7bWFyZ2luOjExcHggMCAycHh9CkBtZWRpYShtYXgtd2lkdGg6NjUwcHgpewouY2xpbWF0ZS1jb3VwbGVkLWNoYXJ0LmNoYXJ0LXdyYXB7aGVpZ2h0OjE5MHB4fQouY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnktbWV0cmljc3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0KLmNsaW1hdGUtY291cGxlZC1zdW1tYXJ5LW1ldHJpY3M+ZGl2Omxhc3QtY2hpbGR7Z3JpZC1jb2x1bW46MS8tMX0KLmNsaW1hdGUtY291cGxlZC1tb250aC1kZXRhaWx7cGFkZGluZzo5cHh9Ci5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlsIHRkLC5jbGltYXRlLWNvdXBsZWQtbW9udGgtZGV0YWlsIHRoe3BhZGRpbmc6OXB4IDhweH0KfQo=","type":"text/css; charset=utf-8","cache":"no-cache"},"/app.js":{"body":"KCgpID0+IHsKICAidXNlIHN0cmljdCI7CgogIGNvbnN0IEFQUF9CVUlMRCA9ICI2LjMuNC1XRUFUSEVSLUhFQVQtUE9XRVItQ09NUEFSSVNPTi0yMDI2MTAzMSI7CiAgY29uc3QgREFUQV9LRVkgPSAiZWxkZWhvZi12My1yZWNvcmRzIjsKICBjb25zdCBTRVRUSU5HU19LRVkgPSAiZWxkZWhvZi12My1zZXR0aW5ncyI7CiAgY29uc3QgVkFJTExBTlRfTU9OVEhTX0tFWSA9ICJlbGRlaG9mLXYzLXZhaWxsYW50LW1vbnRocy12MzgwIjsKICBjb25zdCBPU1RST01fQ0FDSEVfS0VZID0gImVsZGVob2YtdjMtb3N0cm9tLWxpdmUtY2FjaGUiOwogIGNvbnN0IE9TVFJPTV9DT05UUk9MX0tFWSA9ICJlbGRlaG9mLXY1LW9zdHJvbS1jb250cm9sLXY1NDEiOwogIGNvbnN0IFNIQURPV19LRVkgPSAiZWxkZWhvZi12Ni1yZWNvcmRzLXNoYWRvdyI7CiAgY29uc3QgU0hBRE9XX01FVEFfS0VZID0gImVsZGVob2YtdjYtcmVjb3Jkcy1zaGFkb3ctbWV0YSI7CiAgY29uc3QgTEFTVF9CQUNLVVBfS0VZID0gImVsZGVob2YtdjYtbGFzdC1iYWNrdXAtYXQiOwogIGNvbnN0IE1FVEVSX0tFWSA9ICJlbGRlaG9mLXY2LW1ldGVyLXJlYWRpbmdzLXY2MTAiOwogIGNvbnN0IE1FVEVSX01FVEFfS0VZID0gImVsZGVob2YtdjYtbWV0ZXItcmVhZGluZ3MtdXBkYXRlZC12NjIwIjsKICBjb25zdCBISVNUT1JZX1NFRURfS0VZID0gImVsZGVob2YtdjYtaGlzdG9yeS1zZWVkLXY2MTAiOwogIGNvbnN0IFNZTkNfU1RBVEVfS0VZID0gImVsZGVob2YtdjYtc3luYy1zdGF0ZS12NjIwIjsKICBjb25zdCBTWU5DX1NFQ1JFVF9MRUdBQ1lfS0VZID0gImVsZGVob2YtdjYtc3luYy1zZWNyZXQtdjYyMCI7CiAgY29uc3QgU1lOQ19QQVlMT0FEX1NDSEVNQSA9ICJlbGRlaG9mLXN5bmMtcGF5bG9hZC12NjIwIjsKICBjb25zdCBTWU5DX0VOVkVMT1BFX1NDSEVNQSA9ICJlbGRlaG9mLWVuY3J5cHRlZC1zeW5jLXYxIjsKICBjb25zdCBPU1RST01fSElTVE9SWV9LRVkgPSAiZWxkZWhvZi12Ni1vc3Ryb20taGlzdG9yeS1zdGF0dXMtdjYyMCI7CiAgY29uc3QgT1NUUk9NX1BSSUNFX1NUQVRTX0tFWSA9ICJlbGRlaG9mLXY2LW9zdHJvbS1wcmljZS1zdGF0cy12NjIxIjsKICBjb25zdCBNT05USFMgPSBbIkphbiIsIkZlYiIsIk3DpHIiLCJBcHIiLCJNYWkiLCJKdW4iLCJKdWwiLCJBdWciLCJTZXAiLCJPa3QiLCJOb3YiLCJEZXoiXTsKICBjb25zdCBDT0xPUlMgPSB7IHRvdGFsOiIjNzJkYzU3IiwgaGVhdDoiI2ZmOWY0MyIsIGFubmV4OiIjNGQ5Y2ZmIiwgcmVzdDoiI2YyZDE1ZiIsIGNvbXBhcmU6IiM5YzdkZmYiLCBjb3N0OiIjNWZjN2MyIiwgZ3JpZDoicmdiYSgxNzEsMTk4LDIyMCwuMTQpIiwgdGV4dDoiIzk0YThiYSIgfTsKICBjb25zdCBZRUFSX0NPTE9SUyA9IFsiIzcyZGM1NyIsIiM0ZDljZmYiLCIjOWM3ZGZmIiwiI2ZmOWY0MyIsIiNmMmQxNWYiLCIjNWZjN2MyIiwiI2ZmN2I4YSJdOwogIGNvbnN0IEhJU1RPUklDQUxfU0VFRCA9IHsiaGVhdFB1bXAiOnsiMjAyMy0xMiI6MTU1MCwiMjAyNC0wMSI6MTk4MCwiMjAyNC0wMiI6MTExMywiMjAyNC0wMyI6OTA3LCIyMDI0LTA0Ijo1MzUsIjIwMjQtMDUiOjE1NiwiMjAyNC0wNiI6MTEwLCIyMDI0LTA3IjoxMTAsIjIwMjQtMDgiOjEwOCwiMjAyNC0wOSI6MTk4LCIyMDI0LTEwIjo0OTAsIjIwMjQtMTEiOjEwMDMsIjIwMjQtMTIiOjEzMDUsIjIwMjUtMDEiOjE2OTQsIjIwMjUtMDIiOjE0NzgsIjIwMjUtMDMiOjEwMDUsIjIwMjUtMDQiOjQ5OCwiMjAyNS0wNSI6MzY3LCIyMDI1LTA2IjoxMzcsIjIwMjUtMDciOjEwNiwiMjAyNS0wOCI6MTI4LCIyMDI1LTA5IjoxODUsIjIwMjUtMTAiOjYwNywiMjAyNS0xMSI6MTA0MCwiMjAyNS0xMiI6MTI2NSwiMjAyNi0wMSI6MTg1NSwiMjAyNi0wMiI6MTQ4OCwiMjAyNi0wMyI6ODk1LCIyMDI2LTA0Ijo2NTYsIjIwMjYtMDUiOjMwMCwiMjAyNi0wNiI6MTI2LCIyMDI2LTA3IjoxMjgsIjIwMjYtMDgiOjEyMSwiMjAyNi0wOSI6MTM3fSwiYW5uZXgiOnsiMjAyNC0wMSI6MjEwLCIyMDI0LTAyIjoyMTAsIjIwMjQtMDMiOjIxOSwiMjAyNC0wNCI6MjAwLCIyMDI0LTA1IjoyMjIsIjIwMjQtMDYiOjE2NCwiMjAyNC0wNyI6MjE5LCIyMDI0LTA4IjoyMDEsIjIwMjQtMDkiOjE5MiwiMjAyNC0xMCI6MjM3LCIyMDI0LTExIjoyMjcsIjIwMjQtMTIiOjI2NiwiMjAyNS0wMSI6MjYxLCIyMDI1LTAyIjoyMzUsIjIwMjUtMDMiOjIyMSwiMjAyNS0wNCI6MjM4LCIyMDI1LTA1IjoyMjEsIjIwMjUtMDYiOjIzNywiMjAyNS0wNyI6MjQwLCIyMDI1LTA4IjoyMzIsIjIwMjUtMDkiOjMwOCwiMjAyNS0xMCI6MjIwLCIyMDI1LTExIjoyMzcsIjIwMjUtMTIiOjI3MywiMjAyNi0wMSI6MjQwLCIyMDI2LTAyIjoyMjUsIjIwMjYtMDMiOjI3MCwiMjAyNi0wNCI6MjE1LCIyMDI2LTA1IjoyMjAsIjIwMjYtMDYiOjI1MCwiMjAyNi0wNyI6MjEwLCIyMDI2LTA4IjoyNDAsIjIwMjYtMDkiOjI2NX0sInRvdGFsIjp7IjIwMjQtMDEiOjI0NTAsIjIwMjQtMDIiOjE2MTUsIjIwMjQtMDMiOjEzMjAsIjIwMjQtMDQiOjkzMywiMjAyNC0wNSI6NzMxLCIyMDI0LTA2Ijo1ODcsIjIwMjQtMDciOjYyMCwiMjAyNC0wOCI6NTQwLCIyMDI0LTA5Ijo2MTIsIjIwMjQtMTAiOjEwMTksIjIwMjQtMTEiOjE1MjEsIjIwMjQtMTIiOjE4NTcsIjIwMjUtMDEiOjIyODIsIjIwMjUtMDIiOjIwMjMsIjIwMjUtMDMiOjE0MTQsIjIwMjUtMDQiOjk2MCwiMjAyNS0wNSI6OTMzLCIyMDI1LTA2Ijo3NTEsIjIwMjUtMDciOjY4MCwiMjAyNS0wOCI6Njc2LCIyMDI1LTA5Ijo4MTQsIjIwMjUtMTAiOjExMDUsIjIwMjUtMTEiOjE2MTUsIjIwMjUtMTIiOjE4NTAsIjIwMjYtMDEiOjI0NTAsIjIwMjYtMDIiOjIwNjAsIjIwMjYtMDMiOjE1OTcsIjIwMjYtMDQiOjEwNTEsIjIwMjYtMDUiOjc2NywiMjAyNi0wNiI6NjYyLCIyMDI2LTA3Ijo2MDgsIjIwMjYtMDgiOjY4NSwiMjAyNi0wOSI6NjU1fX07CiAgY29uc3QgQkFTRUxJTkVfTUVURVJfUkVBRElORyA9IHtkYXRlOiIyMDI2LTEwLTAxIix0b3RhbDozNDI1NSxhbm5leDo5MDQ1LG5vdGU6IlN0YXJ0d2VydCBmw7xyIGRpZSBhdXRvbWF0aXNjaGUgQmVyZWNobnVuZyBhYiBPa3RvYmVyIDIwMjYifTsKICBjb25zdCAkID0gaWQgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwoKICBsZXQgc2V0dGluZ3MgPSBsb2FkU2V0dGluZ3MoKTsKICBsZXQgcmVjb3JkcyA9IGxvYWRSZWNvcmRzKCk7CiAgbGV0IHZhaWxsYW50TW9udGhzID0gbG9hZFZhaWxsYW50TW9udGhzKCk7CiAgbGV0IG9zdHJvbUxpdmUgPSBsb2FkT3N0cm9tQ2FjaGUoKTsKICBsZXQgb3N0cm9tQnVzeSA9IGZhbHNlOwogIGxldCBvc3Ryb21UaW1lciA9IG51bGw7CiAgbGV0IHRvYXN0VGltZXIgPSBudWxsOwogIGxldCByZXNpemVUaW1lciA9IG51bGw7CiAgbGV0IGN1cnJlbnRWaWV3ID0gImRhc2hib2FyZFZpZXciOwogIGxldCBtZXRlclJlYWRpbmdzID0gbG9hZE1ldGVyUmVhZGluZ3MoKTsKICBsZXQgc3luY1N0YXRlID0gbG9hZFN5bmNTdGF0ZSgpOwogIGxldCBzeW5jQnVzeSA9IGZhbHNlOwogIGxldCBzeW5jQXBwbHlpbmcgPSBmYWxzZTsKICBsZXQgc3luY0RlYm91bmNlVGltZXIgPSBudWxsOwogIGxldCBzeW5jUG9sbFRpbWVyID0gbnVsbDsKICBsZXQgb3N0cm9tSGlzdG9yeUJ1c3kgPSBmYWxzZTsKICBsZXQgb3N0cm9tUHJpY2VTdGF0cyA9IGxvYWRPc3Ryb21QcmljZVN0YXRzKCk7CiAgbGV0IG9zdHJvbVByaWNlU3RhdHNCdXN5ID0gZmFsc2U7CgogIC8qIENsaW1hdGUgNi4zOiBWYWlsbGFudCBob3VybHkgZGF0YSBhcmUgcmVkdWNlZCB0byBwcml2YWN5LXByZXNlcnZpbmcgbW9udGhseSBhZ2dyZWdhdGVzLiAqLwogIGNvbnN0IENMSU1BVEVfTU9OVEhfS0VZPSJlbGRlaG9mLXY2LWNsaW1hdGUtbW9udGhzLXY2MzAiOwogIGNvbnN0IENMSU1BVEVfV0VBVEhFUl9LRVk9ImVsZGVob2YtdjYtY2xpbWF0ZS13ZWF0aGVyLXY2MzAiOwogIGxldCBjbGltYXRlTW9udGhzPWxvYWRDbGltYXRlTW9udGhzKCk7CiAgZnVuY3Rpb24gY2xpbWF0ZVdlYXRoZXJPYmplY3QodmFsdWUpewogICAgcmV0dXJuIHZhbHVlICYmIHR5cGVvZiB2YWx1ZT09PSJvYmplY3QiICYmICFBcnJheS5pc0FycmF5KHZhbHVlKT92YWx1ZTp7fTsKICB9CiAgbGV0IGNsaW1hdGVXZWF0aGVyPWNsaW1hdGVXZWF0aGVyT2JqZWN0KHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oQ0xJTUFURV9XRUFUSEVSX0tFWSkse30pKTsKICBsZXQgY2xpbWF0ZUJ1c3k9ZmFsc2U7CiAgZnVuY3Rpb24gY2xpbWF0ZU51bWJlcihyYXcpe3JldHVybiByYXc9PW51bGx8fHJhdz09PSIiP251bGw6KE51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3KSk/TnVtYmVyKHJhdyk6bnVsbCk7fQogIGZ1bmN0aW9uIGNsaW1hdGVTYW5pdGl6ZShpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHggb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pewogICAgICBjb25zdCBtb250aD1TdHJpbmcoeD8ubW9udGh8fCIiKTsKICAgICAgaWYoIS9eXGR7NH0tKDBbMS05XXwxWzAtMl0pJC8udGVzdChtb250aCkpY29udGludWU7CiAgICAgIGNvbnN0IHJvdz17bW9udGgsdXBkYXRlZEF0OlN0cmluZyh4LnVwZGF0ZWRBdHx8IiIpfTsKICAgICAgZm9yKGNvbnN0IGsgb2YgWyJvdXRkb29yTWVhbiIsIm91dGRvb3JNaW4iLCJvdXRkb29yTWF4Iiwib3V0ZG9vckhvdXJzIiwicm9vbU1lYW4iLCJyb29tSG91cnMiLCJzZXRwb2ludE1lYW4iLCJzZXRwb2ludEhvdXJzIiwiZGh3TWVhbiIsImRod0hvdXJzIl0pcm93W2tdPWNsaW1hdGVOdW1iZXIoeFtrXSk7CiAgICAgIG1hcC5zZXQobW9udGgscm93KTsKICAgIH0KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOwogIH0KICBmdW5jdGlvbiBsb2FkQ2xpbWF0ZU1vbnRocygpe3JldHVybiBjbGltYXRlU2FuaXRpemUoc2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShDTElNQVRFX01PTlRIX0tFWSksW10pKTt9CiAgZnVuY3Rpb24gc2F2ZUNsaW1hdGVNb250aHMoaXRlbXMpewogICAgY2xpbWF0ZU1vbnRocz1jbGltYXRlU2FuaXRpemUoaXRlbXMpOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oQ0xJTUFURV9NT05USF9LRVksSlNPTi5zdHJpbmdpZnkoY2xpbWF0ZU1vbnRocykpOwogICAgaWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygxMjAwKTsKICB9CiAgZnVuY3Rpb24gY2xpbWF0ZVByZXZpZXcoZmlsZXMpewogICAgY29uc3QgY29scz17InN5c3RlbS10ZW1wZXJhdHVyZSI6W1siT3V0ZG9vclRlbXBlcmF0dXJlIiwib3V0ZG9vciJdXSwiem9uZS10ZW1wZXJhdHVyZSI6W1siQ3VycmVudFJvb21UZW1wZXJhdHVyZSIsInJvb20iXSxbIk1hbnVhbE1vZGVTZXRwb2ludEhlYXRpbmciLCJzZXRwb2ludCJdXSwiZGh3LXRlbXBlcmF0dXJlIjpbWyJEaHdUYW5rVGVtcGVyYXR1cmUiLCJkaHciXV19OwogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCBmaWxlIG9mIGZpbGVzLmZpbHRlcihmPT5jb2xzW2YudHlwZV0pKXsKICAgICAgZm9yKGNvbnN0IHIgb2YgZmlsZS5yb3dzKXsKICAgICAgICBpZighbWFwLmhhcyhyLm1vbnRoS2V5KSltYXAuc2V0KHIubW9udGhLZXkse21vbnRoOnIubW9udGhLZXksc2VyaWVzOnt9fSk7CiAgICAgICAgY29uc3QgYnVja2V0PW1hcC5nZXQoci5tb250aEtleSk7CiAgICAgICAgZm9yKGNvbnN0IFtjb2x1bW4sa2luZF0gb2YgY29sc1tmaWxlLnR5cGVdKXsKICAgICAgICAgIGNvbnN0IHZhbHVlPXIudmFsdWVzW2NvbHVtbl07CiAgICAgICAgICBpZighTnVtYmVyLmlzRmluaXRlKHZhbHVlKSljb250aW51ZTsKICAgICAgICAgIGlmKCFidWNrZXQuc2VyaWVzW2tpbmRdKWJ1Y2tldC5zZXJpZXNba2luZF09bmV3IE1hcCgpOwogICAgICAgICAgY29uc3Qgb2xkPWJ1Y2tldC5zZXJpZXNba2luZF0uZ2V0KHIuZGF0ZVRpbWUpOwogICAgICAgICAgaWYob2xkIT09dW5kZWZpbmVkJiZNYXRoLmFicyhvbGQtdmFsdWUpPi4wNSl0aHJvdyBFcnJvcigiQWJ3ZWljaGVuZGUgZG9wcGVsdGUgVGVtcGVyYXR1cm1lc3N1bmdlbiBpbiAiK3IubW9udGhLZXkpOwogICAgICAgICAgYnVja2V0LnNlcmllc1traW5kXS5zZXQoci5kYXRlVGltZSx2YWx1ZSk7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0ubWFwKGI9PnsKICAgICAgY29uc3Qgcm93PXttb250aDpiLm1vbnRoLHVwZGF0ZWRBdDpzdGFtcH07CiAgICAgIGZvcihjb25zdCBraW5kIG9mIFsib3V0ZG9vciIsInJvb20iLCJzZXRwb2ludCIsImRodyJdKXsKICAgICAgICBjb25zdCB2PVsuLi4oYi5zZXJpZXNba2luZF0/LnZhbHVlcygpfHxbXSldOwogICAgICAgIGlmKCF2Lmxlbmd0aCljb250aW51ZTsKICAgICAgICByb3dba2luZCsiTWVhbiJdPU1hdGgucm91bmQodi5yZWR1Y2UoKGEseCk9PmEreCwwKS92Lmxlbmd0aCoxMDApLzEwMDsKICAgICAgICByb3dba2luZCsiSG91cnMiXT12Lmxlbmd0aDsKICAgICAgICBpZihraW5kPT09Im91dGRvb3IiKXtyb3cub3V0ZG9vck1pbj1NYXRoLm1pbiguLi52KTtyb3cub3V0ZG9vck1heD1NYXRoLm1heCguLi52KTt9CiAgICAgIH0KICAgICAgcmV0dXJuIHJvdzsKICAgIH0pOwogIH0KICBmdW5jdGlvbiBjbGltYXRlSW1wb3J0KGl0ZW1zKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKGNsaW1hdGVNb250aHMubWFwKHI9PltyLm1vbnRoLHJdKSk7CiAgICBmb3IoY29uc3Qgcm93IG9mIGl0ZW1zKW1hcC5zZXQocm93Lm1vbnRoLHsuLi5tYXAuZ2V0KHJvdy5tb250aCksLi4ucm93fSk7CiAgICBzYXZlQ2xpbWF0ZU1vbnRocyhbLi4ubWFwLnZhbHVlcygpXSk7CiAgfQogIGZ1bmN0aW9uIG1vbnRobHlWYWlsbGFudEltcG9ydHMoZmlsZXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCBmaWxlIG9mIGZpbGVzLmZpbHRlcihmPT5mLnR5cGU9PT0ibW9udGhseS1lbmVyZ3kiKSl7CiAgICAgIGZvcihjb25zdCByb3cgb2YgZmlsZS5yb3dzKXsKICAgICAgICBjb25zdCByYXc9cm93LnZhbHVlcyxtPXJvdy5tb250aEtleTsKICAgICAgICBpZihyYXcuY29tcGxldGUhPT10cnVlfHxyYXcuZXN0aW1hdGVkPT09dHJ1ZXx8bT5jdXJyZW50TW9udGhLZXkoKSljb250aW51ZTsKICAgICAgICBjb25zdCBmaWVsZHM9WyJlbGVjdHJpY2l0eUtXaCIsImhlYXRHZW5lcmF0ZWRLV2giLCJoZWF0aW5nRWxlY3RyaWNpdHlLV2giLCJkaHdFbGVjdHJpY2l0eUtXaCIsImhlYXRpbmdIZWF0S1doIiwiZGh3SGVhdEtXaCJdOwogICAgICAgIGlmKGZpZWxkcy5zb21lKGs9PiFOdW1iZXIuaXNGaW5pdGUocmF3W2tdKXx8cmF3W2tdPDApKWNvbnRpbnVlOwogICAgICAgIGNvbnN0IHllYXI9TnVtYmVyKG0uc2xpY2UoMCw0KSksbW9udGg9TnVtYmVyKG0uc2xpY2UoNSkpOwogICAgICAgIG1hcC5zZXQobSx7bW9udGg6bSxlbGVjdHJpY2l0eUtXaDpyYXcuZWxlY3RyaWNpdHlLV2gsaGVhdEdlbmVyYXRlZEtXaDpyYXcuaGVhdEdlbmVyYXRlZEtXaCxoZWF0aW5nRWxlY3RyaWNpdHlLV2g6cmF3LmhlYXRpbmdFbGVjdHJpY2l0eUtXaCxkaHdFbGVjdHJpY2l0eUtXaDpyYXcuZGh3RWxlY3RyaWNpdHlLV2gsaGVhdGluZ0hlYXRLV2g6cmF3LmhlYXRpbmdIZWF0S1doLGRod0hlYXRLV2g6cmF3LmRod0hlYXRLV2gsY29tcGxldGU6dHJ1ZSxjb3ZlcmFnZVN0YXJ0Om0rIi0wMSIsY292ZXJhZ2VFbmQ6bSsiLSIrU3RyaW5nKG5ldyBEYXRlKHllYXIsbW9udGgsMCkuZ2V0RGF0ZSgpKS5wYWRTdGFydCgyLCIwIiksYmxvY2tlZDpmYWxzZX0pOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV07CiAgfQogIGNvbnN0IGNsaW1hdGVGbXQ9KHYsZD0wKT0+TnVtYmVyLmlzRmluaXRlKHYpP251bSh2LGQpOiLigJMiOwogIGZ1bmN0aW9uIGNsaW1hdGVXZWF0aGVyRm9yKG1vbnRoKXtyZXR1cm4gY2xpbWF0ZVdlYXRoZXI/Llttb250aC5zbGljZSgwLDQpXT8ubW9udGhzPy5maW5kKHg9PngubW9udGg9PT1tb250aCl8fG51bGw7fQogIGZ1bmN0aW9uIGNsaW1hdGVSb3dzRm9yKHllYXIpewogICAgY29uc3QgcmVmZXJlbmNlPW5ldyBNYXAoKTsKICAgIGZvcihsZXQgaT0xO2k8PTEyO2krKyl7CiAgICAgIGNvbnN0IG1tPVN0cmluZyhpKS5wYWRTdGFydCgyLCIwIik7CiAgICAgIGNvbnN0IGhpc3Q9WzIwMjQsMjAyNV0ubWFwKHk9PmNsaW1hdGVXZWF0aGVyRm9yKHkrIi0iK21tKSkuZmlsdGVyKHc9Pnc/LmNvbXBsZXRlJiZOdW1iZXIuaXNGaW5pdGUody5oZGQxNSkpOwogICAgICBpZihoaXN0Lmxlbmd0aD09PTIpcmVmZXJlbmNlLnNldChtbSwoaGlzdFswXS5oZGQxNStoaXN0WzFdLmhkZDE1KS8yKTsKICAgIH0KICAgIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6MTJ9LChfLGkpPT57CiAgICAgIGNvbnN0IG1vbnRoPXllYXIrIi0iK1N0cmluZyhpKzEpLnBhZFN0YXJ0KDIsIjAiKTsKICAgICAgY29uc3Qgcj1yZWNvcmRGb3JNb250aChtb250aCksdz1jbGltYXRlV2VhdGhlckZvcihtb250aCksc2Vuc29yPWNsaW1hdGVNb250aHMuZmluZCh4PT54Lm1vbnRoPT09bW9udGgpLHZhbGlkPXc/LmNvbXBsZXRlJiZOdW1iZXIuaXNGaW5pdGUody5oZGQxNSk7CiAgICAgIGNvbnN0IGhlYXQ9TnVtYmVyLmlzRmluaXRlKHI/LmhlYXRpbmdIZWF0KT9yLmhlYXRpbmdIZWF0Om51bGw7CiAgICAgIGNvbnN0IGRodz1OdW1iZXIuaXNGaW5pdGUocj8uZGh3SGVhdCk/ci5kaHdIZWF0Om51bGw7CiAgICAgIGNvbnN0IGJhc2VsaW5lPXJlZmVyZW5jZS5nZXQobW9udGguc2xpY2UoNSkpOwogICAgICAvLyBCZWxvdyAxNSBkZWdyZWUtZGF5cywgbm9ybWFsaXphdGlvbiBpcyBudW1lcmljYWxseSB1bnN0YWJsZSAoc3VtbWVyIGhlYXRpbmcgbmVhcmx5IG9mZikuCiAgICAgIGNvbnN0IG5vcm1hbGl6ZWQ9aGVhdCE9PW51bGwmJnZhbGlkJiZ3LmhkZDE1Pj0xNSYmTnVtYmVyLmlzRmluaXRlKGJhc2VsaW5lKSYmYmFzZWxpbmU+PTE1P2hlYXQqYmFzZWxpbmUvdy5oZGQxNTpudWxsOwogICAgICByZXR1cm4ge21vbnRoLHcsc2Vuc29yLGhlYXQsZGh3LHZhbGlkLG5vcm1hbGl6ZWR9OwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJDbGltYXRlTXVsdGlZZWFyKCl7CiAgICBjb25zdCBlbD0kKCJjbGltYXRlTXVsdGlZZWFyIik7aWYoIWVsKXJldHVybjsKICAgIGNvbnN0IGF2YWlsYWJsZT1bLi4ubmV3IFNldChyZWNvcmRzLm1hcChyPT5OdW1iZXIoci5tb250aD8uc2xpY2UoMCw0KSkpKV0uZmlsdGVyKHk9Pnk+PTIwMjQmJnk8PW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSkuc29ydCgpOwogICAgY29uc3QgY2FuZGlkYXRlcz1hdmFpbGFibGUubWFwKHk9Pih7eWVhcjp5LHJvd3M6Y2xpbWF0ZVJvd3NGb3IoeSl9KSkuZmlsdGVyKHg9Pngucm93cy5maWx0ZXIocj0+ci5ub3JtYWxpemVkIT09bnVsbCkubGVuZ3RoPj0zKTsKICAgIGlmKGNhbmRpZGF0ZXMubGVuZ3RoPDIpe2VsLnRleHRDb250ZW50PSJEZXIgZGlyZWt0ZSBKYWhyZXN2ZXJnbGVpY2ggZXJzY2hlaW50LCBzb2JhbGQgbWluZGVzdGVucyB6d2VpIEphaHJlIGpld2VpbHMgZHJlaSB2b2xsc3TDpG5kaWdlIHZlcmdsZWljaGJhcmUgTW9uYXRlIG1pdCBIZWl6d8Okcm1lIHVuZCBXZXR0ZXJkYXRlbiBiZXNpdHplbi4iO3JldHVybjt9CiAgICBjb25zdCBtb250aHM9QXJyYXkuZnJvbSh7bGVuZ3RoOjEyfSwoXyxpKT0+aSsxKS5maWx0ZXIobT0+Y2FuZGlkYXRlcy5ldmVyeShjPT5jLnJvd3NbbS0xXT8ubm9ybWFsaXplZCE9PW51bGwpKTsKICAgIGlmKG1vbnRocy5sZW5ndGg8Myl7ZWwudGV4dENvbnRlbnQ9IkbDvHIgZGllc2UgSmFocmUgZ2lidCBlcyBub2NoIG5pY2h0IGdlbsO8Z2VuZCBnZW1laW5zYW1lIE1vbmF0ZS4gRmVobGVuZGUgVmFpbGxhbnQtV8Okcm1lLSBvZGVyIFdldHRlcndlcnRlIGVyZ8Okbnplbi4iO3JldHVybjt9CiAgICBjb25zdCBiYXNlWWVhcj1jYW5kaWRhdGVzWzBdLnllYXIsYmFzZUhlYXQ9bW9udGhzLnJlZHVjZSgocyxtKT0+cytjYW5kaWRhdGVzWzBdLnJvd3NbbS0xXS5ub3JtYWxpemVkLDApOwogICAgY29uc3QgaGVhZGVyPSc8cCBjbGFzcz0ibXV0ZWQiPkRpcmVrdHZlcmdsZWljaCBudXIgZ2xlaWNoZXIsIHZvbGxzdMOkbmRpZyBlcmZhc3N0ZXIgTW9uYXRlOiAnK21vbnRocy5tYXAobT0+TU9OVEhTW20tMV0pLmpvaW4oIiwgIikrJy4gV2FybXdhc3NlciBpc3QgYXVzZ2VzY2hsb3NzZW4uPC9wPic7CiAgICBjb25zdCB0YWJsZT0nPGRpdiBjbGFzcz0idGFibGUtc2Nyb2xsIj48dGFibGU+PHRoZWFkPjx0cj48dGg+SmFocjwvdGg+PHRoPkhlaXp3w6RybWUgZ2VtZXNzZW4ga1doPC90aD48dGg+V2l0dGVydW5nc2JlcmVpbmlndCBrV2g8L3RoPjx0aD5HZWdlbsO8YmVyICcrYmFzZVllYXIrJzwvdGg+PC90cj48L3RoZWFkPjx0Ym9keT4nKwogICAgICBjYW5kaWRhdGVzLm1hcChjPT57CiAgICAgICAgY29uc3Qgb3JpZ2luYWw9bW9udGhzLnJlZHVjZSgocyxtKT0+cytjLnJvd3NbbS0xXS5oZWF0LDApOwogICAgICAgIGNvbnN0IGFkanVzdGVkPW1vbnRocy5yZWR1Y2UoKHMsbSk9PnMrYy5yb3dzW20tMV0ubm9ybWFsaXplZCwwKTsKICAgICAgICBjb25zdCBkZWx0YT1iYXNlSGVhdD4wPyhhZGp1c3RlZC9iYXNlSGVhdC0xKSoxMDA6bnVsbDsKICAgICAgICByZXR1cm4gJzx0cj48dGQ+JytjLnllYXIrJzwvdGQ+PHRkPicrbnVtKG9yaWdpbmFsKSsnPC90ZD48dGQ+JytudW0oYWRqdXN0ZWQpKyc8L3RkPjx0ZD4nKyhkZWx0YT09PW51bGw/IuKAkyI6cGN0KGRlbHRhKSkrJzwvdGQ+PC90cj4nOwogICAgICB9KS5qb2luKCIiKSsnPC90Ym9keT48L3RhYmxlPjwvZGl2Pic7CiAgICBlbC5pbm5lckhUTUw9aGVhZGVyK3RhYmxlOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQ2xpbWF0ZUFuYWx5c2lzKCl7CiAgICBpZighJCgiY2xpbWF0ZU1ldHJpY3MiKSlyZXR1cm47CiAgICBjb25zdCB5ZWFyPU51bWJlcigkKCJhbmFseXNpc1llYXIiKS52YWx1ZSl8fG5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSxyb3dzPWNsaW1hdGVSb3dzRm9yKHllYXIpOwogICAgY29uc3QgaD1yb3dzLmZpbHRlcih4PT54LmhlYXQhPT1udWxsKSx3PXJvd3MuZmlsdGVyKHg9PnguZGh3IT09bnVsbCksbj1yb3dzLmZpbHRlcih4PT54Lm5vcm1hbGl6ZWQhPT1udWxsKSx3ZWF0aGVyPXJvd3MuZmlsdGVyKHg9PngudmFsaWQpOwogICAgY29uc3QgbWV0cmljcz1bCiAgICAgIFsiSGVpenfDpHJtZSIsaC5sZW5ndGg/Y2xpbWF0ZUZtdChoLnJlZHVjZSgocyx4KT0+cyt4LmhlYXQsMCkpKyIga1doIjoi4oCTIixoLmxlbmd0aCsiIE1vbmF0ZSJdLAogICAgICBbIldhcm13YXNzZXJ3w6RybWUiLHcubGVuZ3RoP2NsaW1hdGVGbXQody5yZWR1Y2UoKHMseCk9PnMreC5kaHcsMCkpKyIga1doIjoi4oCTIiwib2huZSBXaXR0ZXJ1bmdzYmVyZWluaWd1bmciXSwKICAgICAgWyJIZWl6Z3JhZHRhZ2UiLHdlYXRoZXIubGVuZ3RoP2NsaW1hdGVGbXQod2VhdGhlci5yZWR1Y2UoKHMseCk9PnMreC53LmhkZDE1LDApKSsiIEvCt2QiOiLigJMiLCJCYXNpcyAxNSDCsEM7IHZvbGxzdMOkbmRpZ2UgTW9uYXRlIl0sCiAgICAgIFsiQmVyZWluaWd0ZSBIZWl6d8Okcm1lIixuLmxlbmd0aD9jbGltYXRlRm10KG4ucmVkdWNlKChzLHgpPT5zK3gubm9ybWFsaXplZCwwKSkrIiBrV2giOiLigJMiLG4ubGVuZ3RoKyIgdmVyZ2xlaWNoYmFyZSBNb25hdGUiXQogICAgXTsKICAgICQoImNsaW1hdGVNZXRyaWNzIikuaW5uZXJIVE1MPW1ldHJpY3MubWFwKChbYSxiLGNdKT0+JzxhcnRpY2xlPjxzcGFuPicrZXNjYXBlSHRtbChhKSsnPC9zcGFuPjxzdHJvbmc+Jytlc2NhcGVIdG1sKGIpKyc8L3N0cm9uZz48c21hbGw+Jytlc2NhcGVIdG1sKGMpKyc8L3NtYWxsPjwvYXJ0aWNsZT4nKS5qb2luKCIiKTsKICAgICQoImNsaW1hdGVSb3dzIikuaW5uZXJIVE1MPXJvd3MubWFwKHg9Pic8dHI+PHRkPicrZXNjYXBlSHRtbChtb250aExhYmVsKHgubW9udGgsZmFsc2UpKSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHgudz8ubWVhblRlbXAsMSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LnNlbnNvcj8ub3V0ZG9vck1lYW4sMSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LnNlbnNvcj8ucm9vbU1lYW4sMSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LnNlbnNvcj8uZGh3TWVhbiwxKSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHgudmFsaWQ/eC53LmhkZDE1Om51bGwpKyc8L3RkPjx0ZD4nK2NsaW1hdGVGbXQoeC5oZWF0KSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHguZGh3KSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHgubm9ybWFsaXplZCkrJzwvdGQ+PC90cj4nKS5qb2luKCIiKTsKICAgIHJlbmRlckNsaW1hdGVNdWx0aVllYXIoKTsKICAgICQoImNsaW1hdGVJbmZvIikudGV4dENvbnRlbnQ9KGNsaW1hdGVCdXN5PyJIaXN0b3Jpc2NoZSBXZXR0ZXJkYXRlbiB3ZXJkZW4gZ2VsYWRlbiDigKYgIjoiIikrKG4ubGVuZ3RoP24ubGVuZ3RoKyIgd2l0dGVydW5nc2JlcmVpbmlndGUgTW9uYXRlLiI6IkJpdHRlIGhpc3RvcmlzY2hlIFdldHRlcmRhdGVuIGxhZGVuLiAiKSsiUmVmZXJlbnogamUgS2FsZW5kZXJtb25hdDogSGVpemdyYWR0YWdlIDIwMjQvMjAyNS4gTnVyIGdsZWljaGUgWmVpdHLDpHVtZSB2ZXJnbGVpY2hlbiwgV2FybXdhc3NlciBnZXRyZW5udC4iOwogIH0KICBhc3luYyBmdW5jdGlvbiBsb2FkQ2xpbWF0ZVdlYXRoZXIoKXsKICAgIGlmKGNsaW1hdGVCdXN5KXJldHVybjsKICAgIGlmKCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe3RvYXN0KCJFbGRlaG9mLUFwcC1TY2hsw7xzc2VsIHVudGVyIERhdGVuIOKGkiBPc3Ryb20gc3BlaWNoZXJuIik7cmV0dXJuO30KICAgIC8vIEpTT04ucGFyc2UobnVsbCkgcmV0dXJucyBudWxsOyBhbHdheXMgcmVzdG9yZSBhIG11dGFibGUgb2JqZWN0IHdpdGhvdXQgY2xlYXJpbmcgYW55IG90aGVyIGFwcCBkYXRhLgogICAgY2xpbWF0ZVdlYXRoZXI9Y2xpbWF0ZVdlYXRoZXJPYmplY3QoY2xpbWF0ZVdlYXRoZXIpOwogICAgY2xpbWF0ZUJ1c3k9dHJ1ZTtjbGltYXRlV2VhdGhlckVycm9yPSIiO3JlbmRlckNsaW1hdGVBbmFseXNpcygpO3JlbmRlckRhc2hib2FyZENsaW1hdGUoKTsKICAgIHRyeXsKICAgICAgY29uc3QgeWVhcnM9Wy4uLm5ldyBTZXQoWy4uLnJlY29yZHMubWFwKHI9Pk51bWJlcihyLm1vbnRoLnNsaWNlKDAsNCkpKSwyMDI0LDIwMjVdKV0uZmlsdGVyKHk9Pnk+PTIwMjMmJnk8PW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSkuc29ydCgpOwogICAgICBmb3IoY29uc3QgeWVhciBvZiB5ZWFycyl7CiAgICAgICAgaWYoY2xpbWF0ZVdlYXRoZXI/Llt5ZWFyXT8uY29tcGxldGUmJkRhdGUubm93KCktRGF0ZS5wYXJzZShjbGltYXRlV2VhdGhlclt5ZWFyXS5jYWNoZWRBdHx8IiIpPDkwKjg2NDAwZTMpY29udGludWU7CiAgICAgICAgY29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2goIi9hcGkvd2VhdGhlci9hcmNoaXZlP3llYXI9Iit5ZWFyLHtoZWFkZXJzOnsieC1lbGRlaG9mLWtleSI6c2V0dGluZ3Mub3N0cm9tQXBwS2V5fSxjYWNoZToibm8tc3RvcmUifSk7CiAgICAgICAgY29uc3QgcGF5bG9hZD1hd2FpdCByZXNwb25zZS5qc29uKCk7CiAgICAgICAgaWYoIXJlc3BvbnNlLm9rKXRocm93IEVycm9yKHBheWxvYWQuZXJyb3J8fCJIaXN0b3Jpc2NoZSBXZXR0ZXJkYXRlbiBmZWhsZW4iKTsKICAgICAgICBpZighcGF5bG9hZHx8IUFycmF5LmlzQXJyYXkocGF5bG9hZC5tb250aHMpfHxwYXlsb2FkLnllYXIhPT15ZWFyKXsKICAgICAgICAgIHRocm93IEVycm9yKCJEYXMgV2V0dGVyYXJjaGl2IGxpZWZlcnRlIGtlaW5lIGfDvGx0aWdlbiBNb25hdHN3ZXJ0ZSBmw7xyICIreWVhcisiLiIpOwogICAgICAgIH0KICAgICAgICBjbGltYXRlV2VhdGhlclt5ZWFyXT1wYXlsb2FkOwogICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKENMSU1BVEVfV0VBVEhFUl9LRVksSlNPTi5zdHJpbmdpZnkoY2xpbWF0ZVdlYXRoZXIpKTsKICAgICAgICByZW5kZXJDbGltYXRlQW5hbHlzaXMoKTtyZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7CiAgICAgIH0KICAgICAgdG9hc3QoIldldHRlcmhpc3RvcmllIGFrdHVhbGlzaWVydCIpOwogICAgfWNhdGNoKGUpe2NsaW1hdGVXZWF0aGVyRXJyb3I9ZS5tZXNzYWdlO3RvYXN0KCJXZXR0ZXI6ICIrZS5tZXNzYWdlKTt9CiAgICBmaW5hbGx5e2NsaW1hdGVCdXN5PWZhbHNlO3JlbmRlckNsaW1hdGVBbmFseXNpcygpO3JlbmRlckRhc2hib2FyZENsaW1hdGUoKTt9CiAgfQoKICBmdW5jdGlvbiBzYWZlSnNvblBhcnNlKHZhbHVlLCBmYWxsYmFjaz1udWxsKXsgdHJ5e3JldHVybiBKU09OLnBhcnNlKHZhbHVlKTt9Y2F0Y2h7cmV0dXJuIGZhbGxiYWNrO30gfQogIGZ1bmN0aW9uIG51bGxhYmxlTnVtYmVyKHZhbHVlKXsgaWYodmFsdWU9PT0iInx8dmFsdWU9PT1udWxsfHx2YWx1ZT09PXVuZGVmaW5lZClyZXR1cm4gbnVsbDsgY29uc3Qgbj1OdW1iZXIodmFsdWUpOyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pP246bnVsbDsgfQogIGZ1bmN0aW9uIHNvcnRlZChpdGVtcz1yZWNvcmRzKXsgcmV0dXJuIFsuLi5pdGVtc10uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsgfQogIGZ1bmN0aW9uIGN1cnJlbnRNb250aEtleSgpeyBjb25zdCBkPW5ldyBEYXRlKCk7IHJldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9YDsgfQogIGZ1bmN0aW9uIG1vbnRoTGFiZWwobW9udGgsbG9uZz10cnVlKXsgY29uc3QgW3ksbV09U3RyaW5nKG1vbnRoKS5zcGxpdCgiLSIpLm1hcChOdW1iZXIpOyBpZigheXx8IW0pcmV0dXJuIG1vbnRoOyByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIixsb25nP3ttb250aDoibG9uZyIseWVhcjoibnVtZXJpYyJ9Onttb250aDoic2hvcnQiLHllYXI6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHksbS0xLDEpKTsgfQogIGZ1bmN0aW9uIG51bSh2YWx1ZSxkaWdpdHM9MCl7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHZhbHVlKSk/bmV3IEludGwuTnVtYmVyRm9ybWF0KCJkZS1ERSIse21pbmltdW1GcmFjdGlvbkRpZ2l0czpkaWdpdHMsbWF4aW11bUZyYWN0aW9uRGlnaXRzOmRpZ2l0c30pLmZvcm1hdChOdW1iZXIodmFsdWUpKToi4oCTIjsgfQogIGZ1bmN0aW9uIGV1cm8odmFsdWUpeyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcih2YWx1ZSkpP25ldyBJbnRsLk51bWJlckZvcm1hdCgiZGUtREUiLHtzdHlsZToiY3VycmVuY3kiLGN1cnJlbmN5OiJFVVIifSkuZm9ybWF0KE51bWJlcih2YWx1ZSkpOiLigJMiOyB9CiAgZnVuY3Rpb24gcGN0KHZhbHVlKXsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIodmFsdWUpKT9gJHt2YWx1ZT4wPyIrIjoiIn0ke251bSh2YWx1ZSwxKX0gJWA6IuKAkyI7IH0KICBmdW5jdGlvbiBlc2NhcGVIdG1sKHZhbHVlKXsgcmV0dXJuIFN0cmluZyh2YWx1ZT8/IiIpLnJlcGxhY2UoL1smPD4iJ10vZyxjaD0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsIlwiIjoiJnF1b3Q7IiwiJyI6IiYjMzk7In1bY2hdKSk7IH0KICBmdW5jdGlvbiBjc3ZDZWxsKHZhbHVlKXsgY29uc3Qgcz1TdHJpbmcodmFsdWU/PyIiKTsgcmV0dXJuIGAiJHtzLnJlcGxhY2UoLyIvZywnIiInKX0iYDsgfQogIGZ1bmN0aW9uIGRhdGVTdGFtcCgpeyBjb25zdCBkPW5ldyBEYXRlKCk7IHJldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKGQuZ2V0RGF0ZSgpKS5wYWRTdGFydCgyLCIwIil9YDsgfQoKICBmdW5jdGlvbiBzYW5pdGl6ZVJlY29yZChyYXcpewogICAgY29uc3QgbW9udGg9U3RyaW5nKHJhdz8ubW9udGh8fCIiKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChtb250aCkpcmV0dXJuIG51bGw7CiAgICByZXR1cm4gewogICAgICBtb250aCwKICAgICAgaGVhdFB1bXA6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRQdW1wKSwKICAgICAgYW5uZXg6bnVsbGFibGVOdW1iZXIocmF3LmFubmV4KSwKICAgICAgdG90YWw6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsKSwKICAgICAgcHJpY2VDdDpudWxsYWJsZU51bWJlcihyYXcucHJpY2VDdCA/PyByYXcuYXZlcmFnZVByaWNlQ3QpLAogICAgICBiYXNlRmVlOm51bGxhYmxlTnVtYmVyKHJhdy5iYXNlRmVlKSwKICAgICAgbm90ZTpTdHJpbmcocmF3Lm5vdGV8fCIiKS50cmltKCkuc2xpY2UoMCw4MDApLAogICAgICBoZWF0R2VuZXJhdGVkOm51bGxhYmxlTnVtYmVyKHJhdy5oZWF0R2VuZXJhdGVkKSwKICAgICAgaGVhdGluZ0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKHJhdy5oZWF0aW5nRWxlY3RyaWNpdHkpLAogICAgICBkaHdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcihyYXcuZGh3RWxlY3RyaWNpdHkpLAogICAgICBoZWF0aW5nSGVhdDpudWxsYWJsZU51bWJlcihyYXcuaGVhdGluZ0hlYXQpLAogICAgICBkaHdIZWF0Om51bGxhYmxlTnVtYmVyKHJhdy5kaHdIZWF0KSwKICAgICAgaGVhdFB1bXBTb3VyY2U6U3RyaW5nKHJhdy5oZWF0UHVtcFNvdXJjZXx8IiIpLnNsaWNlKDAsNjApLAogICAgICBoZWF0UHVtcFVwZGF0ZWRBdDpyYXcuaGVhdFB1bXBVcGRhdGVkQXQ/U3RyaW5nKHJhdy5oZWF0UHVtcFVwZGF0ZWRBdCk6bnVsbCwKICAgICAgbWV0ZXJSZWFkaW5nRGF0ZTpyYXcubWV0ZXJSZWFkaW5nRGF0ZT9TdHJpbmcocmF3Lm1ldGVyUmVhZGluZ0RhdGUpOm51bGwsCiAgICAgIHByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZTpyYXcucHJldmlvdXNNZXRlclJlYWRpbmdEYXRlP1N0cmluZyhyYXcucHJldmlvdXNNZXRlclJlYWRpbmdEYXRlKTpudWxsLAogICAgICB0b3RhbE1ldGVyUmVhZGluZzpudWxsYWJsZU51bWJlcihyYXcudG90YWxNZXRlclJlYWRpbmcpLAogICAgICBhbm5leE1ldGVyUmVhZGluZzpudWxsYWJsZU51bWJlcihyYXcuYW5uZXhNZXRlclJlYWRpbmcpLAogICAgICBtZXRlclNvdXJjZTpTdHJpbmcocmF3Lm1ldGVyU291cmNlfHwiIikuc2xpY2UoMCw2MCksCiAgICAgIHByaWNlU291cmNlOlN0cmluZyhyYXcucHJpY2VTb3VyY2V8fCIiKS5zbGljZSgwLDgwKSwKICAgICAgcHJpY2VVcGRhdGVkQXQ6cmF3LnByaWNlVXBkYXRlZEF0P1N0cmluZyhyYXcucHJpY2VVcGRhdGVkQXQpOm51bGwsCiAgICAgIG9zdHJvbVZhcmlhYmxlQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tVmFyaWFibGVDb3N0RXVyKSwKICAgICAgb3N0cm9tVG90YWxDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy5vc3Ryb21Ub3RhbENvc3RFdXIpLAogICAgICBvc3Ryb21Db25zdW1wdGlvbktXaDpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tQ29uc3VtcHRpb25LV2gpLAogICAgICBvc3Ryb21QcmljZUNvbXBsZXRlOkJvb2xlYW4ocmF3Lm9zdHJvbVByaWNlQ29tcGxldGUpLAogICAgICB1cGRhdGVkQXQ6cmF3LnVwZGF0ZWRBdD9TdHJpbmcocmF3LnVwZGF0ZWRBdCk6bnVsbCwKICAgICAgY2xvc2VkOkJvb2xlYW4ocmF3LmNsb3NlZCksCiAgICAgIGNsb3NlZEF0OnJhdy5jbG9zZWRBdD9TdHJpbmcocmF3LmNsb3NlZEF0KTpudWxsCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZVJlY29yZHMoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10peyBjb25zdCByPXNhbml0aXplUmVjb3JkKHJhdyk7IGlmKHIpbWFwLnNldChyLm1vbnRoLHIpOyB9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gZGVyaXZlZChyKXsgaWYoIVtyPy5oZWF0UHVtcCxyPy5hbm5leCxyPy50b3RhbF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSlyZXR1cm4gbnVsbDsgcmV0dXJuIHIudG90YWwtci5oZWF0UHVtcC1yLmFubmV4OyB9CiAgZnVuY3Rpb24gY29tcGxldGUocil7IGNvbnN0IHJlc3Q9ZGVyaXZlZChyKTsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdD49MDsgfQogIGZ1bmN0aW9uIHJlY29yZENvc3Qocil7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUocj8ub3N0cm9tVG90YWxDb3N0RXVyKSYmcj8ub3N0cm9tUHJpY2VDb21wbGV0ZSlyZXR1cm4gTnVtYmVyKHIub3N0cm9tVG90YWxDb3N0RXVyKTsKICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUocj8udG90YWwpKXJldHVybiBudWxsOwogICAgY29uc3QgcHJpY2U9TnVtYmVyLmlzRmluaXRlKHIucHJpY2VDdCk/ci5wcmljZUN0LzEwMDpOdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMik7CiAgICBjb25zdCBiYXNlPU51bWJlci5pc0Zpbml0ZShyLmJhc2VGZWUpP3IuYmFzZUZlZTpOdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApOwogICAgcmV0dXJuIHIudG90YWwqcHJpY2UrYmFzZTsKICB9CiAgZnVuY3Rpb24gcmVjb3JkQ29wKHIpeyByZXR1cm4gTnVtYmVyKHI/LmhlYXRQdW1wKT4wJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHI/LmhlYXRHZW5lcmF0ZWQpKT9OdW1iZXIoci5oZWF0R2VuZXJhdGVkKS9OdW1iZXIoci5oZWF0UHVtcCk6bnVsbDsgfQoKICBmdW5jdGlvbiByYXdTZXR0aW5ncygpeyBjb25zdCB2PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU0VUVElOR1NfS0VZKSx7fSk7IHJldHVybiB2JiZ0eXBlb2Ygdj09PSJvYmplY3QiJiYhQXJyYXkuaXNBcnJheSh2KT92Ont9OyB9CiAgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCl7CiAgICBjb25zdCByYXc9cmF3U2V0dGluZ3MoKTsKICAgIHJldHVybiB7CiAgICAgIC4uLnJhdywKICAgICAgZmFsbGJhY2tQcmljZTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5mYWxsYmFja1ByaWNlKSk/TnVtYmVyKHJhdy5mYWxsYmFja1ByaWNlKTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5wcmljZSkpP051bWJlcihyYXcucHJpY2UpOjAuMzIsCiAgICAgIGRlZmF1bHRCYXNlRmVlOk51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3LmRlZmF1bHRCYXNlRmVlKSk/TnVtYmVyKHJhdy5kZWZhdWx0QmFzZUZlZSk6MCwKICAgICAgb3N0cm9tQXBwS2V5OlN0cmluZyhyYXcub3N0cm9tQXBwS2V5fHwiIiksCiAgICAgIG9zdHJvbUF1dG9SZWZyZXNoOnJhdy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlLAogICAgICBwcmVmZXJyZWRXaW5kb3dIb3VyczpbMSwyLDMsNF0uaW5jbHVkZXMoTnVtYmVyKHJhdy5wcmVmZXJyZWRXaW5kb3dIb3VycykpP051bWJlcihyYXcucHJlZmVycmVkV2luZG93SG91cnMpOjMKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncygpewogICAgY29uc3QgcHJldmlvdXM9cmF3U2V0dGluZ3MoKTsKICAgIGNvbnN0IG1lcmdlZD17Li4ucHJldmlvdXMsCiAgICAgIGZhbGxiYWNrUHJpY2U6TnVtYmVyKHNldHRpbmdzLmZhbGxiYWNrUHJpY2UpfHwwLAogICAgICBkZWZhdWx0QmFzZUZlZTpOdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWUpfHwwLAogICAgICBvc3Ryb21BcHBLZXk6U3RyaW5nKHNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiIpLAogICAgICBvc3Ryb21BdXRvUmVmcmVzaDpzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlLAogICAgICBwcmVmZXJyZWRXaW5kb3dIb3VyczpbMSwyLDMsNF0uaW5jbHVkZXMoTnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKSk/TnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKTozCiAgICB9OwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0VUVElOR1NfS0VZLEpTT04uc3RyaW5naWZ5KG1lcmdlZCkpOwogICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLm1lcmdlZH07CiAgfQoKICBmdW5jdGlvbiByZWFkUHJpbWFyeVJlY29yZHMoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oREFUQV9LRVkpLG51bGwpOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3Nhbml0aXplUmVjb3JkcyhyYXcpOm51bGw7IH0KICBmdW5jdGlvbiByZWFkU2hhZG93UmVjb3JkcygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTSEFET1dfS0VZKSxudWxsKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9zYW5pdGl6ZVJlY29yZHMocmF3KTpbXTsgfQogIGZ1bmN0aW9uIGxvYWRSZWNvcmRzKCl7CiAgICBjb25zdCBwcmltYXJ5PXJlYWRQcmltYXJ5UmVjb3JkcygpOwogICAgaWYocHJpbWFyeSE9PW51bGwpcmV0dXJuIHByaW1hcnk7CiAgICBmb3IoY29uc3Qga2V5IG9mIFsiZWxkZWhvZi12MS1kYXRhIiwiZW5lcmhhdXMtdjEtZGF0YSJdKXsKICAgICAgY29uc3QgbGVnYWN5PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSxudWxsKTsKICAgICAgaWYoQXJyYXkuaXNBcnJheShsZWdhY3kpKXsKICAgICAgICBjb25zdCBtaWdyYXRlZD1zYW5pdGl6ZVJlY29yZHMobGVnYWN5KTsKICAgICAgICBpZihtaWdyYXRlZC5sZW5ndGgpbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkobWlncmF0ZWQpKTsKICAgICAgICByZXR1cm4gbWlncmF0ZWQ7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBbXTsKICB9CiAgZnVuY3Rpb24gc2F2ZVJlY29yZHMobmV4dCx7cmVhc29uPSLDhG5kZXJ1bmciLGFsbG93RW1wdHk9ZmFsc2V9PXt9KXsKICAgIGNvbnN0IGNsZWFuPXNhbml0aXplUmVjb3JkcyhuZXh0KTsKICAgIGNvbnN0IHByZXZpb3VzPXJlYWRQcmltYXJ5UmVjb3JkcygpfHxbXTsKICAgIGlmKCFhbGxvd0VtcHR5ICYmIHByZXZpb3VzLmxlbmd0aD4wICYmIGNsZWFuLmxlbmd0aD09PTApdGhyb3cgbmV3IEVycm9yKCJMZWVyZXIgTW9uYXRzYmVzdGFuZCB3aXJkIGF1cyBTaWNoZXJoZWl0c2dyw7xuZGVuIG5pY2h0IGF1dG9tYXRpc2NoIGdlc3BlaWNoZXJ0LiIpOwogICAgaWYocHJldmlvdXMubGVuZ3RoKXsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0hBRE9XX0tFWSxKU09OLnN0cmluZ2lmeShwcmV2aW91cykpOwogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTSEFET1dfTUVUQV9LRVksSlNPTi5zdHJpbmdpZnkoe3NhdmVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHJlYXNvbixyZWNvcmRzOnByZXZpb3VzLmxlbmd0aH0pKTsKICAgIH0KICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKERBVEFfS0VZLEpTT04uc3RyaW5naWZ5KGNsZWFuKSk7CiAgICByZWNvcmRzPWNsZWFuOwogICAgdXBkYXRlUmVjb3ZlcnlCYW5uZXIoKTsKICAgIGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoKTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVNZXRlclJlYWRpbmcocmF3KXsKICAgIGNvbnN0IGRhdGU9U3RyaW5nKHJhdz8uZGF0ZXx8IiIpOwogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIocmF3Py50b3RhbCksYW5uZXg9bnVsbGFibGVOdW1iZXIocmF3Py5hbm5leCk7CiAgICBpZighL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoZGF0ZSl8fCFOdW1iZXIuaXNGaW5pdGUodG90YWwpfHwhTnVtYmVyLmlzRmluaXRlKGFubmV4KXx8dG90YWw8MHx8YW5uZXg8MClyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7ZGF0ZSx0b3RhbCxhbm5leCxub3RlOlN0cmluZyhyYXc/Lm5vdGV8fCIiKS5zbGljZSgwLDE4MCksdXBkYXRlZEF0OnJhdz8udXBkYXRlZEF0P1N0cmluZyhyYXcudXBkYXRlZEF0KTpudWxsfTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVNZXRlclJlYWRpbmdzKGl0ZW1zKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgcmF3IG9mIEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKXtjb25zdCByPXNhbml0aXplTWV0ZXJSZWFkaW5nKHJhdyk7aWYociltYXAuc2V0KHIuZGF0ZSxyKTt9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5kYXRlLmxvY2FsZUNvbXBhcmUoYi5kYXRlKSk7CiAgfQogIGZ1bmN0aW9uIGxvYWRNZXRlclJlYWRpbmdzKCl7cmV0dXJuIHNhbml0aXplTWV0ZXJSZWFkaW5ncyhzYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE1FVEVSX0tFWSksW10pKTt9CiAgZnVuY3Rpb24gc2F2ZU1ldGVyUmVhZGluZ3MobmV4dCx7dG91Y2g9dHJ1ZSx0aW1lc3RhbXA9bnVsbH09e30pe21ldGVyUmVhZGluZ3M9c2FuaXRpemVNZXRlclJlYWRpbmdzKG5leHQpO2xvY2FsU3RvcmFnZS5zZXRJdGVtKE1FVEVSX0tFWSxKU09OLnN0cmluZ2lmeShtZXRlclJlYWRpbmdzKSk7aWYodG91Y2gpbG9jYWxTdG9yYWdlLnNldEl0ZW0oTUVURVJfTUVUQV9LRVksdGltZXN0YW1wfHxuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO2lmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoKTt9CiAgZnVuY3Rpb24gbGF0ZXN0TWV0ZXJSZWFkaW5nKCl7cmV0dXJuIG1ldGVyUmVhZGluZ3MuYXQoLTEpfHxudWxsO30KICBmdW5jdGlvbiBkYXRlTGFiZWwodmFsdWUpe2NvbnN0IGQ9bmV3IERhdGUoYCR7dmFsdWV9VDEyOjAwOjAwYCk7cmV0dXJuIE51bWJlci5pc05hTihkLnZhbHVlT2YoKSk/dmFsdWU6bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7ZGF5OiIyLWRpZ2l0Iixtb250aDoiMi1kaWdpdCIseWVhcjoibnVtZXJpYyJ9KS5mb3JtYXQoZCk7fQogIGZ1bmN0aW9uIG5leHRNb250aEZpcnN0KGRhdGUpe2NvbnN0IFt5LG1dPVN0cmluZyhkYXRlKS5zcGxpdCgiLSIpLm1hcChOdW1iZXIpO2NvbnN0IGQ9bmV3IERhdGUoeSxtLDEpO3JldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9LTAxYDt9CiAgZnVuY3Rpb24gYXBwbHlIaXN0b3JpY2FsU2VlZCgpewogICAgaWYobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWV9TRUVEX0tFWSkpcmV0dXJuOwogICAgY29uc3QgbWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgY29uc3QgbW9udGhzPVsuLi5uZXcgU2V0KFsuLi5PYmplY3Qua2V5cyhISVNUT1JJQ0FMX1NFRUQudG90YWwpLC4uLk9iamVjdC5rZXlzKEhJU1RPUklDQUxfU0VFRC5hbm5leCksLi4uT2JqZWN0LmtleXMoSElTVE9SSUNBTF9TRUVELmhlYXRQdW1wKV0pXS5zb3J0KCk7CiAgICBmb3IoY29uc3QgbW9udGggb2YgbW9udGhzKXsKICAgICAgY29uc3Qgcj1tYXAuZ2V0KG1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRofSk7CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELnRvdGFsLG1vbnRoKSlyLnRvdGFsPUhJU1RPUklDQUxfU0VFRC50b3RhbFttb250aF07CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELmFubmV4LG1vbnRoKSlyLmFubmV4PUhJU1RPUklDQUxfU0VFRC5hbm5leFttb250aF07CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELmhlYXRQdW1wLG1vbnRoKSl7CiAgICAgICAgY29uc3Qgc2VlZD1ISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXBbbW9udGhdOwogICAgICAgIGNvbnN0IGtlZXBFeGlzdGluZz1OdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCkmJk1hdGguYWJzKHIuaGVhdFB1bXAtc2VlZCk8PTI7CiAgICAgICAgaWYoIWtlZXBFeGlzdGluZylyLmhlYXRQdW1wPXNlZWQ7CiAgICAgICAgaWYoIXIuaGVhdFB1bXBTb3VyY2Upci5oZWF0UHVtcFNvdXJjZT0iaGlzdG9yaWNhbC11c2VyLWRhdGEiOwogICAgICB9CiAgICAgIGlmKG1vbnRoPT09IjIwMjQtMDMiKXsKICAgICAgICBjb25zdCBub3RlPSJaw6RobGVyd2VjaHNlbCBHZXNhbXRzdHJvbSBhbSAwMS4wNC4yMDI0OiBhbHRlciBaw6RobGVyIDYyLjI5NiBrV2gsIG5ldWVyIFrDpGhsZXIgMTk3IGtXaDsgTW9uYXRzdmVyYnJhdWNoIGtvcnJla3QgbWl0IDEuMzIwIGtXaCBiZXLDvGNrc2ljaHRpZ3QuIjsKICAgICAgICBpZighU3RyaW5nKHIubm90ZXx8IiIpLmluY2x1ZGVzKCJaw6RobGVyd2VjaHNlbCBHZXNhbXRzdHJvbSIpKXIubm90ZT1yLm5vdGU/YCR7ci5ub3RlfSDigKIgJHtub3RlfWA6bm90ZTsKICAgICAgfQogICAgICBpZihtb250aD09PSIyMDIzLTEyIiYmIXIubm90ZSlyLm5vdGU9Ikhpc3RvcmlzY2ggaXN0IGbDvHIgRGV6ZW1iZXIgMjAyMyBudXIgZGVyIFfDpHJtZXB1bXBlbnZlcmJyYXVjaCBkb2t1bWVudGllcnQuIjsKICAgICAgbWFwLnNldChtb250aCxyKTsKICAgIH0KICAgIHNhdmVSZWNvcmRzKFsuLi5tYXAudmFsdWVzKCldLHtyZWFzb246Ikhpc3RvcmlzY2hlIFZlcmJyYXVjaHNkYXRlbiAyMDI04oCTMDkvMjAyNiDDvGJlcm5vbW1lbiJ9KTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUllfU0VFRF9LRVksbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTsKICB9CiAgZnVuY3Rpb24gZW5zdXJlTWV0ZXJCYXNlbGluZSgpewogICAgaWYobWV0ZXJSZWFkaW5ncy5zb21lKHI9PnIuZGF0ZT09PUJBU0VMSU5FX01FVEVSX1JFQURJTkcuZGF0ZSkpcmV0dXJuOwogICAgaWYobWV0ZXJSZWFkaW5ncy5sZW5ndGg9PT0wKXNhdmVNZXRlclJlYWRpbmdzKFtCQVNFTElORV9NRVRFUl9SRUFESU5HXSx7dG91Y2g6ZmFsc2V9KTsKICB9CiAgZnVuY3Rpb24gbG9hZFZhaWxsYW50TW9udGhzKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFZBSUxMQU5UX01PTlRIU19LRVkpLFtdKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9yYXc6W107IH0KICBmdW5jdGlvbiBzYXZlVmFpbGxhbnRNb250aHMoKXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oVkFJTExBTlRfTU9OVEhTX0tFWSxKU09OLnN0cmluZ2lmeShBcnJheS5pc0FycmF5KHZhaWxsYW50TW9udGhzKT92YWlsbGFudE1vbnRoczpbXSkpOyBpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKCk7IH0KICBmdW5jdGlvbiBsb2FkT3N0cm9tQ2FjaGUoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oT1NUUk9NX0NBQ0hFX0tFWSksbnVsbCk7IHJldHVybiByYXcmJnJhdy5nZW5lcmF0ZWRBdD9yYXc6bnVsbDsgfQogIGZ1bmN0aW9uIHNhdmVPc3Ryb21DYWNoZShwYXlsb2FkKXsgb3N0cm9tTGl2ZT1wYXlsb2FkfHxudWxsOyBpZihwYXlsb2FkKWxvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9DQUNIRV9LRVksSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpOyBlbHNlIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKE9TVFJPTV9DQUNIRV9LRVkpOyBpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKDE4MDApOyB9CiAgZnVuY3Rpb24gc2FuaXRpemVPc3Ryb21QcmljZVN0YXQocmF3KXsKICAgIGNvbnN0IG1vbnRoPVN0cmluZyhyYXc/Lm1vbnRofHwiIik7CiAgICBpZighL15cZHs0fS1cZHsyfSQvLnRlc3QobW9udGgpKXJldHVybiBudWxsOwogICAgcmV0dXJuIHsKICAgICAgbW9udGgsCiAgICAgIHdlaWdodGVkQXZlcmFnZUN0UGVyS1doOm51bGxhYmxlTnVtYmVyKHJhdy53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCA/PyByYXcucHJpY2VDdCksCiAgICAgIHRvdGFsS1doOm51bGxhYmxlTnVtYmVyKHJhdy50b3RhbEtXaCA/PyByYXcub3N0cm9tQ29uc3VtcHRpb25LV2gpLAogICAgICB2YXJpYWJsZUNvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3LnZhcmlhYmxlQ29zdEV1ciA/PyByYXcub3N0cm9tVmFyaWFibGVDb3N0RXVyKSwKICAgICAgZml4ZWRDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy5maXhlZENvc3RFdXIgPz8gcmF3LmJhc2VGZWUpLAogICAgICB0b3RhbENvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsQ29zdEV1ciA/PyByYXcub3N0cm9tVG90YWxDb3N0RXVyKSwKICAgICAgY29tcGxldGU6Qm9vbGVhbihyYXcuY29tcGxldGUgPz8gcmF3Lm9zdHJvbVByaWNlQ29tcGxldGUpLAogICAgICBwYXJ0aWFsOkJvb2xlYW4ocmF3LnBhcnRpYWwpLAogICAgICB1cGRhdGVkQXQ6U3RyaW5nKHJhdy51cGRhdGVkQXR8fHJhdy5wcmljZVVwZGF0ZWRBdHx8IiIpCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdHMoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pe2NvbnN0IGl0ZW09c2FuaXRpemVPc3Ryb21QcmljZVN0YXQocmF3KTtpZihpdGVtKW1hcC5zZXQoaXRlbS5tb250aCxpdGVtKTt9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gbG9hZE9zdHJvbVByaWNlU3RhdHMoKXsgcmV0dXJuIHNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhzYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE9TVFJPTV9QUklDRV9TVEFUU19LRVkpLFtdKSk7IH0KICBmdW5jdGlvbiBzYXZlT3N0cm9tUHJpY2VTdGF0cyhpdGVtcyl7IG9zdHJvbVByaWNlU3RhdHM9c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKGl0ZW1zKTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShPU1RST01fUFJJQ0VfU1RBVFNfS0VZLEpTT04uc3RyaW5naWZ5KG9zdHJvbVByaWNlU3RhdHMpKTtpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKDEyMDApOyB9CiAgZnVuY3Rpb24gdXBzZXJ0T3N0cm9tUHJpY2VTdGF0KG1vbnRoLGRhdGEse3BhcnRpYWw9ZmFsc2V9PXt9KXsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChTdHJpbmcobW9udGh8fCIiKSkpcmV0dXJuOwogICAgY29uc3QgbWFwPW5ldyBNYXAob3N0cm9tUHJpY2VTdGF0cy5tYXAoaXRlbT0+W2l0ZW0ubW9udGgsaXRlbV0pKTsKICAgIG1hcC5zZXQobW9udGgsc2FuaXRpemVPc3Ryb21QcmljZVN0YXQoewogICAgICBtb250aCx3ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaDpOdW1iZXIoZGF0YT8ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpLHRvdGFsS1doOk51bWJlcihkYXRhPy50b3RhbEtXaCksdmFyaWFibGVDb3N0RXVyOk51bWJlcihkYXRhPy52YXJpYWJsZUNvc3RFdXIpLGZpeGVkQ29zdEV1cjpOdW1iZXIoZGF0YT8uZml4ZWRDb3N0RXVyKSx0b3RhbENvc3RFdXI6TnVtYmVyKGRhdGE/LnRvdGFsQ29zdEV1ciksY29tcGxldGU6Qm9vbGVhbihkYXRhPy5jb21wbGV0ZSkscGFydGlhbCx1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpCiAgICB9KSk7CiAgICBzYXZlT3N0cm9tUHJpY2VTdGF0cyhbLi4ubWFwLnZhbHVlcygpXSk7CiAgfQoKICBmdW5jdGlvbiB1cGRhdGVSZWNvdmVyeUJhbm5lcigpewogICAgY29uc3QgcHJpbWFyeT1yZWFkUHJpbWFyeVJlY29yZHMoKTsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgY29uc3Qgc2hvdz0oIXByaW1hcnl8fHByaW1hcnkubGVuZ3RoPT09MCkmJnNoYWRvdy5sZW5ndGg+MDsKICAgICQoInJlY292ZXJ5QmFubmVyIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIHJlc3RvcmVTaGFkb3coKXsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgaWYoIXNoYWRvdy5sZW5ndGgpcmV0dXJuOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkoc2hhZG93KSk7CiAgICByZWNvcmRzPXNoYWRvdzsKICAgIHRvYXN0KGAke3NoYWRvdy5sZW5ndGh9IE1vbmF0c3dlcnRlIHdpZWRlcmhlcmdlc3RlbGx0YCk7CiAgICByZW5kZXJBbGwoKTsKICB9CgogIGZ1bmN0aW9uIHRvYXN0KG1lc3NhZ2UpeyBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7ICQoInRvYXN0IikudGV4dENvbnRlbnQ9bWVzc2FnZTsgJCgidG9hc3QiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsgdG9hc3RUaW1lcj1zZXRUaW1lb3V0KCgpPT4kKCJ0b2FzdCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpLDI2MDApOyB9CiAgZnVuY3Rpb24gc2V0U3RhdHVzKGlkLHRleHQsa2luZD0iIil7IGNvbnN0IGVsPSQoaWQpOyBlbC50ZXh0Q29udGVudD10ZXh0fHwiIjsgZWwuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke2tpbmR9YC50cmltKCk7IH0KCiAgZnVuY3Rpb24gc3dpdGNoVmlldyhpZCl7CiAgICBjdXJyZW50Vmlldz1pZDsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi52aWV3IikuZm9yRWFjaCh2PT52LmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsdi5pZD09PWlkKSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIuYm90dG9tLW5hdiBbZGF0YS1uYXZdIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsYi5kYXRhc2V0Lm5hdj09PWlkKSk7CiAgICB3aW5kb3cuc2Nyb2xsVG8oe3RvcDowLGJlaGF2aW9yOiJpbnN0YW50In0pOwogICAgaWYoaWQ9PT0iYW5hbHlzaXNWaWV3IilyZW5kZXJBbmFseXNpcygpOwogICAgaWYoaWQ9PT0iY29uc3VtcHRpb25WaWV3IilyZW5kZXJSZWNvcmRzKCk7CiAgICBpZihpZD09PSJkYXRhVmlldyIpcmVuZGVyRGF0YSgpOwogICAgaWYoaWQ9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7CiAgfQoKICBmdW5jdGlvbiB5ZWFycygpeyByZXR1cm4gWy4uLm5ldyBTZXQocmVjb3Jkcy5tYXAocj0+TnVtYmVyKHIubW9udGguc2xpY2UoMCw0KSkpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKV0uc29ydCgoYSxiKT0+Yi1hKTsgfQogIGZ1bmN0aW9uIGxhdGVzdFJlY29yZCgpeyByZXR1cm4gc29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkuYXQoLTEpfHxzb3J0ZWQoKS5hdCgtMSl8fG51bGw7IH0KICBmdW5jdGlvbiByZWNvcmRGb3JNb250aChtb250aCl7IHJldHVybiByZWNvcmRzLmZpbmQocj0+ci5tb250aD09PW1vbnRoKXx8bnVsbDsgfQoKCgogIC8qIDYuMy40OiBhbGlnbmVkIHdlYXRoZXIgLyBoZWF0aW5nLW9ubHkgZWxlY3RyaWNhbCBjb25zdW1wdGlvbiBtdWx0aS15ZWFyIGNvbXBhcmlzb25zLiAqLwogIGxldCBkYXNoYm9hcmRDbGltYXRlUGVyaW9kPSJoZWF0aW5nIjsKICBsZXQgZGFzaGJvYXJkQ2xpbWF0ZVNlbGVjdGVkTW9udGg9bnVsbDsKICBsZXQgY2xpbWF0ZVdlYXRoZXJFcnJvcj0iIjsKICBjb25zdCBDTElNQVRFX0NPTVBBUklTT05fQ09MT1JTPXsyMDI0OiIjNGQ5Y2ZmIiwyMDI1OiIjZmY5ZjQzIiwyMDI2OiIjNzJkYzU3In07CiAgZnVuY3Rpb24gZGFzaGJvYXJkQ29tcGFyaXNvblllYXJzKCl7CiAgICBjb25zdCB5ZWFycz1uZXcgU2V0KHJlY29yZHMuZmlsdGVyKHg9Pk51bWJlci5pc0Zpbml0ZSh4LmhlYXRpbmdFbGVjdHJpY2l0eSl8fE51bWJlci5pc0Zpbml0ZSh4LmhlYXRpbmdIZWF0KSkKICAgICAgLm1hcCh4PT5OdW1iZXIoeC5tb250aC5zbGljZSgwLDQpKSkpOwogICAgZm9yKGNvbnN0IHYgb2YgY2xpbWF0ZU1vbnRocyl5ZWFycy5hZGQoTnVtYmVyKHYubW9udGguc2xpY2UoMCw0KSkpOwogICAgcmV0dXJuIFsuLi55ZWFyc10uZmlsdGVyKHg9Pk51bWJlci5pc0ludGVnZXIoeCkmJng+PTIwMjQmJng8PW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSkKICAgICAgLnNvcnQoKGEsYik9PmEtYikuc2xpY2UoLTMpOwogIH0KICBmdW5jdGlvbiBkYXNoYm9hcmRDb21wYXJpc29uTW9udGhzKCl7CiAgICByZXR1cm4gZGFzaGJvYXJkQ2xpbWF0ZVBlcmlvZD09PSJoZWF0aW5nIj9bMSwyLDMsNCwxMCwxMSwxMl06WzEsMiwzLDQsNSw2LDcsOCw5LDEwLDExLDEyXTsKICB9CiAgZnVuY3Rpb24gZGFzaGJvYXJkQ29tcGFyaXNvblJvd3MoeWVhcil7CiAgICBjb25zdCBjdXJyZW50PWN1cnJlbnRNb250aEtleSgpOwogICAgcmV0dXJuIEFycmF5LmZyb20oe2xlbmd0aDoxMn0sKF8saSk9PnsKICAgICAgY29uc3QgbW9udGg9eWVhcisiLSIrU3RyaW5nKGkrMSkucGFkU3RhcnQoMiwiMCIpOwogICAgICBjb25zdCByPXJlY29yZEZvck1vbnRoKG1vbnRoKSx3PWNsaW1hdGVXZWF0aGVyRm9yKG1vbnRoKTsKICAgICAgY29uc3QgaW5jb21wbGV0ZT1tb250aD49Y3VycmVudHx8U3RyaW5nKHI/LmhlYXRQdW1wU291cmNlfHwiIikuaW5jbHVkZXMoInBhcnRpYWwiKTsKICAgICAgY29uc3Qgd2VhdGhlclZhbGlkPW1vbnRoPGN1cnJlbnQmJnc/LmNvbXBsZXRlPT09dHJ1ZSYmTnVtYmVyLmlzRmluaXRlKHcubWVhblRlbXApOwogICAgICBjb25zdCBlbmVyZ3lWYWxpZD0haW5jb21wbGV0ZSYmciYmCiAgICAgICAgKHIuaGVhdFB1bXBTb3VyY2UhPT0ibXl2YWlsbGFudC1jc3YtaW1wb3J0LXBhcnRpYWwiKTsKICAgICAgY29uc3QgZWxlY3RyaWM9ZW5lcmd5VmFsaWQmJk51bWJlci5pc0Zpbml0ZShyLmhlYXRpbmdFbGVjdHJpY2l0eSkmJnIuaGVhdGluZ0VsZWN0cmljaXR5Pj0wP3IuaGVhdGluZ0VsZWN0cmljaXR5Om51bGw7CiAgICAgIGNvbnN0IGhlYXQ9ZW5lcmd5VmFsaWQmJk51bWJlci5pc0Zpbml0ZShyLmhlYXRpbmdIZWF0KSYmci5oZWF0aW5nSGVhdD49MD9yLmhlYXRpbmdIZWF0Om51bGw7CiAgICAgIGNvbnN0IGhkZD13ZWF0aGVyVmFsaWQmJk51bWJlci5pc0Zpbml0ZSh3LmhkZDE1KT93LmhkZDE1Om51bGw7CiAgICAgIGNvbnN0IGNvcD1OdW1iZXIuaXNGaW5pdGUoaGVhdCkmJk51bWJlci5pc0Zpbml0ZShlbGVjdHJpYykmJmVsZWN0cmljPjA/aGVhdC9lbGVjdHJpYzpudWxsOwogICAgICByZXR1cm4ge3llYXIsbW9udGgsbW9udGhOdW1iZXI6aSsxLGVsZWN0cmljLGhlYXQsdGVtcDp3ZWF0aGVyVmFsaWQ/dy5tZWFuVGVtcDpudWxsLAogICAgICAgIGhkZCxjb3AscGFydGlhbDppbmNvbXBsZXRlJiZCb29sZWFuKHIpLGhhc1NlbnNvcjpjbGltYXRlTW9udGhzLnNvbWUoeD0+eC5tb250aD09PW1vbnRoKX07CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gZGFzaGJvYXJkQ29tcGFyaXNvbk1hdHJpeCgpewogICAgcmV0dXJuIG5ldyBNYXAoZGFzaGJvYXJkQ29tcGFyaXNvblllYXJzKCkubWFwKHk9Plt5LGRhc2hib2FyZENvbXBhcmlzb25Sb3dzKHkpXSkpOwogIH0KICBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmRDbGltYXRlKCl7CiAgICBpZighJCgiZGFzaGJvYXJkQ2xpbWF0ZVBhbmVsIikpcmV0dXJuOwogICAgY29uc3QgeWVhcnM9ZGFzaGJvYXJkQ29tcGFyaXNvblllYXJzKCksbW9udGhzPWRhc2hib2FyZENvbXBhcmlzb25Nb250aHMoKSxtYXRyaXg9ZGFzaGJvYXJkQ29tcGFyaXNvbk1hdHJpeCgpOwogICAgLy8gVGhlIHBhbGV0dGUgY29udGFpbnMgc3RhYmxlIGNvbG9ycyBmb3IgMjAyNOKAkzIwMjY7IGxhdGVyIHllYXJzIHJlY2VpdmUgYSBkZXRlcm1pbmlzdGljIGZhbGxiYWNrLgogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZUxlZ2VuZCIpLmlubmVySFRNTD15ZWFycy5tYXAoKHksaSk9PnsKICAgICAgY29uc3QgY29sb3I9ZGFzaGJvYXJkQ29tcGFyaXNvbkNvbG9yKHksaSk7CiAgICAgIHJldHVybiAnPHNwYW4+PGkgc3R5bGU9ImJhY2tncm91bmQ6Jytjb2xvcisnIj48L2k+Jyt5Kyc8L3NwYW4+JzsKICAgIH0pLmpvaW4oIiIpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtY2xpbWF0ZS1wZXJpb2RdIikuZm9yRWFjaChidG49PnsKICAgICAgY29uc3QgYWN0aXZlPWJ0bi5kYXRhc2V0LmNsaW1hdGVQZXJpb2Q9PT1kYXNoYm9hcmRDbGltYXRlUGVyaW9kOwogICAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIixhY3RpdmUpO2J0bi5zZXRBdHRyaWJ1dGUoImFyaWEtcHJlc3NlZCIsU3RyaW5nKGFjdGl2ZSkpOwogICAgfSk7CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlWWVhciIpLnRleHRDb250ZW50PWRhc2hib2FyZENsaW1hdGVQZXJpb2Q9PT0iaGVhdGluZyI/CiAgICAgICJIZWl6bW9uYXRlIEphbnVhcuKAk0FwcmlsIHVuZCBPa3RvYmVy4oCTRGV6ZW1iZXIgwrcgamUgS2FsZW5kZXJqYWhyIjoKICAgICAgIkFsbGUgenfDtmxmIEthbGVuZGVybW9uYXRlIMK3IGplIEthbGVuZGVyamFociI7CiAgICBpZighbW9udGhzLmluY2x1ZGVzKE51bWJlcihTdHJpbmcoZGFzaGJvYXJkQ2xpbWF0ZVNlbGVjdGVkTW9udGh8fCIiKS5zbGljZSg1LDcpKSkpewogICAgICBjb25zdCBjYW5kaWRhdGU9bW9udGhzLmZpbmQobT0+eWVhcnMuZmlsdGVyKHk9Pk51bWJlci5pc0Zpbml0ZShtYXRyaXguZ2V0KHkpPy5bbS0xXT8uZWxlY3RyaWMpKS5sZW5ndGg+PTIpCiAgICAgICAgfHxtb250aHMuZmluZChtPT55ZWFycy5zb21lKHk9Pk51bWJlci5pc0Zpbml0ZShtYXRyaXguZ2V0KHkpPy5bbS0xXT8uZWxlY3RyaWMpKSl8fG1vbnRoc1swXTsKICAgICAgZGFzaGJvYXJkQ2xpbWF0ZVNlbGVjdGVkTW9udGg9Im1vbnRoLSIrU3RyaW5nKGNhbmRpZGF0ZSkucGFkU3RhcnQoMiwiMCIpOwogICAgfQogICAgY29uc3Qgc2VsZWN0ZWROdW1iZXI9TnVtYmVyKFN0cmluZyhkYXNoYm9hcmRDbGltYXRlU2VsZWN0ZWRNb250aCkuc2xpY2UoLTIpKTsKICAgICQoImRhc2hib2FyZENsaW1hdGVNb250aEJ1dHRvbnMiKS5pbm5lckhUTUw9bW9udGhzLm1hcChtPT4KICAgICAgJzxidXR0b24gdHlwZT0iYnV0dG9uIiBkYXRhLWNsaW1hdGUtbW9udGg9IicrbSsnIiBjbGFzcz0iJysoc2VsZWN0ZWROdW1iZXI9PT1tPyJhY3RpdmUiOiIiKSsnIiBhcmlhLXByZXNzZWQ9IicrKHNlbGVjdGVkTnVtYmVyPT09bSkrJyI+JytNT05USFNbbS0xXSsnPC9idXR0b24+JwogICAgKS5qb2luKCIiKTsKICAgIHJlbmRlckNsaW1hdGVDb3VwbGVkTW9udGhEZXRhaWwobWF0cml4LHllYXJzLHNlbGVjdGVkTnVtYmVyKTsKICAgIHJlbmRlckNsaW1hdGVDb3VwbGVkU3VtbWFyeShtYXRyaXgseWVhcnMsbW9udGhzKTsKICAgIGRyYXdDbGltYXRlQ291cGxlZENoYXJ0KCJkYXNoYm9hcmRDbGltYXRlVGVtcGVyYXR1cmVDaGFydCIsbWF0cml4LHllYXJzLG1vbnRocywidGVtcCIpOwogICAgZHJhd0NsaW1hdGVDb3VwbGVkQ2hhcnQoImRhc2hib2FyZENsaW1hdGVFbGVjdHJpY0NoYXJ0IixtYXRyaXgseWVhcnMsbW9udGhzLCJlbGVjdHJpYyIpOwogICAgY29uc3Qgd2VhdGhlclJlYWR5PXllYXJzLmV2ZXJ5KHk9Pntjb25zdCBkPWNsaW1hdGVXZWF0aGVyPy5beV07cmV0dXJuIHk9PT1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk/CiAgICAgIEFycmF5LmlzQXJyYXkoZD8ubW9udGhzKSYmZC5tb250aHMubGVuZ3RoPjA6ZD8uY29tcGxldGU9PT10cnVlO30pOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVdlYXRoZXJCdG4iKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHdlYXRoZXJSZWFkeSYmIWNsaW1hdGVXZWF0aGVyRXJyb3IpOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVdlYXRoZXJCdG4iKS5kaXNhYmxlZD1jbGltYXRlQnVzeTsKICAgICQoImRhc2hib2FyZENsaW1hdGVXZWF0aGVyQnRuIikudGV4dENvbnRlbnQ9Y2xpbWF0ZUJ1c3k/IldldHRlciB3aXJkIGdlbGFkZW4g4oCmIjoiV2V0dGVyaGlzdG9yaWUgbGFkZW4iOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVN0YXR1cyIpLnRleHRDb250ZW50PWNsaW1hdGVXZWF0aGVyRXJyb3I/IldldHRlcjogIitjbGltYXRlV2VhdGhlckVycm9yOgogICAgICAhd2VhdGhlclJlYWR5PyJGw7xyIGRlbiBUZW1wZXJhdHVydmVyZ2xlaWNoIGZlaGxlbiBub2NoIGhpc3RvcmlzY2hlIFdldHRlcmRhdGVuLiI6IldldHRlcnZlcmdsZWljaCB2ZXJmw7xnYmFyIMK3IGVpbmhlaXRsaWNoZSBPcGVuLU1ldGVvLUFyY2hpdmRhdGVuLiI7CiAgfQogIGZ1bmN0aW9uIGRhc2hib2FyZENvbXBhcmlzb25Db2xvcih5ZWFyLGluZGV4KXsKICAgIHJldHVybiBDTElNQVRFX0NPTVBBUklTT05fQ09MT1JTW3llYXJdfHxZRUFSX0NPTE9SU1soaW5kZXgrMSklWUVBUl9DT0xPUlMubGVuZ3RoXTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyQ2xpbWF0ZUNvdXBsZWRTdW1tYXJ5KG1hdHJpeCx5ZWFycyxtb250aHMpewogICAgY29uc3QgZWw9JCgiZGFzaGJvYXJkQ2xpbWF0ZVRyZW5kIik7CiAgICBpZih5ZWFycy5sZW5ndGg8Mil7ZWwudGV4dENvbnRlbnQ9IldlaXRlcmUgVmFpbGxhbnQtSmFocmVzZGF0ZW4gZXJnw6RuemVuLCB1bSBkaWUgSmFocmUgbWl0ZWluYW5kZXIgenUgdmVyZ2xlaWNoZW4uIjtyZXR1cm47fQogICAgY29uc3Qgb2xkZXI9eWVhcnNbeWVhcnMubGVuZ3RoLTJdLG5ld2VyPXllYXJzW3llYXJzLmxlbmd0aC0xXTsKICAgIGNvbnN0IGFsaWduZWQ9bW9udGhzLm1hcChtPT5bbWF0cml4LmdldChvbGRlcik/LlttLTFdLG1hdHJpeC5nZXQobmV3ZXIpPy5bbS0xXV0pCiAgICAgIC5maWx0ZXIoKFthLGJdKT0+YSYmYiYmW2EuZWxlY3RyaWMsYi5lbGVjdHJpYyxhLmhkZCxiLmhkZF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSYmYS5oZGQ+PTE1JiZiLmhkZD49MTUpOwogICAgaWYoYWxpZ25lZC5sZW5ndGg8Mil7CiAgICAgIGVsLmlubmVySFRNTD0nPHN0cm9uZz5XaXR0ZXJ1bmdzLSB1bmQgSGVpenN0cm9tdmVyZ2xlaWNoPC9zdHJvbmc+PHA+RsO8ciAnK29sZGVyKycgdW5kICcrbmV3ZXIrCiAgICAgICAgJyBmZWhsZW4gbm9jaCBtaW5kZXN0ZW5zIHp3ZWkgdm9sbHN0w6RuZGlnIHZlcmdsZWljaGJhcmUgSGVpem1vbmF0ZSBtaXQgV2V0dGVyZGF0ZW4uIEZlaGxlbmRlIFdlcnRlIHdlcmRlbiBuaWNodCBnZXNjaMOkdHp0LjwvcD4nOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBzdW09KGl4LGtleSk9PmFsaWduZWQucmVkdWNlKChzLHApPT5zK3BbaXhdW2tleV0sMCk7CiAgICBjb25zdCBlYT1zdW0oMCwiZWxlY3RyaWMiKSxlYj1zdW0oMSwiZWxlY3RyaWMiKSxoYT1zdW0oMCwiaGRkIiksaGI9c3VtKDEsImhkZCIpOwogICAgY29uc3QgZGVsdGE9KHgseSk9Png+MD8oeS94LTEpKjEwMDpudWxsOwogICAgY29uc3QgZj14PT54PjA/IisiK251bSh4LDEpKyIgJSI6bnVtKHgsMSkrIiAlIjsKICAgIGNvbnN0IGVsZWN0cmljUGN0PWRlbHRhKGVhLGViKSx3ZWF0aGVyUGN0PWRlbHRhKGhhLGhiKTsKICAgIGNvbnN0IGVmZmljaWVuY3lBPWhhPjA/ZWEvaGE6bnVsbCxlZmZpY2llbmN5Qj1oYj4wP2ViL2hiOm51bGw7CiAgICBjb25zdCByYXRpb1BjdD1OdW1iZXIuaXNGaW5pdGUoZWZmaWNpZW5jeUEpJiZlZmZpY2llbmN5QT4wP2RlbHRhKGVmZmljaWVuY3lBLGVmZmljaWVuY3lCKTpudWxsOwogICAgZWwuaW5uZXJIVE1MPSc8c3Ryb25nPkRpcmVrdHZlcmdsZWljaCAnK25ld2VyKycgenUgJytvbGRlcisnIMK3ICcrYWxpZ25lZC5sZW5ndGgrJyBnbGVpY2hlIEhlaXptb25hdGU8L3N0cm9uZz4nKwogICAgICAnPGRpdiBjbGFzcz0iY2xpbWF0ZS1jb3VwbGVkLXN1bW1hcnktbWV0cmljcyI+JysKICAgICAgJzxkaXY+PHNwYW4+SGVpenN0cm9tPC9zcGFuPjxzdHJvbmc+JytmKGVsZWN0cmljUGN0KSsnPC9zdHJvbmc+PHNtYWxsPicrbnVtKGVhKSsnIOKGkiAnK251bShlYikrJyBrV2g8L3NtYWxsPjwvZGl2PicrCiAgICAgICc8ZGl2PjxzcGFuPldpdHRlcnVuZyAoSGVpemdyYWR0YWdlKTwvc3Bhbj48c3Ryb25nPicrZih3ZWF0aGVyUGN0KSsnPC9zdHJvbmc+PHNtYWxsPicrbnVtKGhhKSsnIOKGkiAnK251bShoYikrJyBLwrdkPC9zbWFsbD48L2Rpdj4nKwogICAgICAnPGRpdj48c3Bhbj5IZWl6c3Ryb20gamUgSGVpemdyYWR0YWc8L3NwYW4+PHN0cm9uZz4nKyhOdW1iZXIuaXNGaW5pdGUocmF0aW9QY3QpP2YocmF0aW9QY3QpOiLigJMiKSsnPC9zdHJvbmc+PHNtYWxsPk9yaWVudGllcnVuZ3N3ZXJ0LCBrZWluZSBFZmZpemllbnptZXNzdW5nPC9zbWFsbD48L2Rpdj48L2Rpdj4nKwogICAgICAnPHA+R2xlaWNoZSBNb25hdGUsIG9obmUgV2FybXdhc3NlcnN0cm9tLiBIZWl6Z3JhZHRhZ2UgYmVzY2hyZWliZW4gZGVuIHdpdHRlcnVuZ3NiZWRpbmd0ZW4gSGVpemJlZGFyZi4gRGllIFdlcnRlIHplaWdlbiBlaW5lbiBadXNhbW1lbmhhbmcsIGJld2Vpc2VuIGFiZXIga2VpbmUgVXJzYWNoZS48L3A+JzsKICB9CiAgZnVuY3Rpb24gcmVuZGVyQ2xpbWF0ZUNvdXBsZWRNb250aERldGFpbChtYXRyaXgseWVhcnMsbW9udGhOdW1iZXIpewogICAgY29uc3QgZWw9JCgiZGFzaGJvYXJkQ2xpbWF0ZU1vbnRoRGV0YWlsIik7CiAgICBjb25zdCBudW1iZXI9TnVtYmVyKG1vbnRoTnVtYmVyKTsKICAgIGlmKCFOdW1iZXIuaXNJbnRlZ2VyKG51bWJlcil8fG51bWJlcjwxfHxudW1iZXI+MTIpe2VsLnRleHRDb250ZW50PSJCaXR0ZSBlaW5lbiBNb25hdCBhdXN3w6RobGVuLiI7cmV0dXJuO30KICAgIGNvbnN0IG51bU9yRGFzaD0odix1bml0LGQ9MCk9Pk51bWJlci5pc0Zpbml0ZSh2KT9udW0odixkKSsodW5pdD8iICIrdW5pdDoiIik6IuKAkyI7CiAgICBjb25zdCBoZWFkPSc8ZGl2IGNsYXNzPSJjbGltYXRlLWNvdXBsZWQtbW9udGgtaGVhZGVyIj48c3Ryb25nPicrTU9OVEhTW251bWJlci0xXSsnIOKAkyBkcmVpIEphaHJlIGRpcmVrdCB2ZXJnbGljaGVuPC9zdHJvbmc+JysKICAgICAgJzxzcGFuPkhlaXpzdHJvbSBhdXNzY2hsaWXDn2xpY2ggZsO8cnMgSGVpemVuPC9zcGFuPjwvZGl2Pic7CiAgICBjb25zdCBib2R5PXllYXJzLm1hcCh5PT57CiAgICAgIGNvbnN0IHI9bWF0cml4LmdldCh5KT8uW251bWJlci0xXTsKICAgICAgY29uc3QgYz1kYXNoYm9hcmRDb21wYXJpc29uQ29sb3IoeSx5ZWFycy5pbmRleE9mKHkpKTsKICAgICAgY29uc3QgcmF0aW89TnVtYmVyLmlzRmluaXRlKHI/LmVsZWN0cmljKSYmTnVtYmVyLmlzRmluaXRlKHI/LmhkZCkmJnIuaGRkPj0xNT9yLmVsZWN0cmljL3IuaGRkOm51bGw7CiAgICAgIHJldHVybiAnPHRyPjx0aD48aSBzdHlsZT0iYmFja2dyb3VuZDonK2MrJyI+PC9pPicreSsnPC90aD4nKwogICAgICAgICc8dGQ+JytudW1PckRhc2gocj8udGVtcCwnwrBDJywxKSsnPC90ZD4nKwogICAgICAgICc8dGQ+JytudW1PckRhc2gocj8uZWxlY3RyaWMsJ2tXaCcpKyc8L3RkPicrCiAgICAgICAgJzx0ZD4nK251bU9yRGFzaChyPy5oZWF0LCdrV2gnKSsnPC90ZD4nKwogICAgICAgICc8dGQ+JytudW1PckRhc2gocj8uY29wLCcnLDIpKyc8L3RkPicrCiAgICAgICAgJzx0ZD4nK251bU9yRGFzaChyPy5oZGQsJ0vCt2QnKSsnPC90ZD4nKwogICAgICAgICc8dGQ+JytudW1PckRhc2gocmF0aW8sJ2tXaC9LwrdkJywyKSsnPC90ZD48L3RyPic7CiAgICB9KS5qb2luKCIiKTsKICAgIGNvbnN0IHRhYmxlPSc8ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwgY2xpbWF0ZS1jb3VwbGVkLWRldGFpbC1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPicrCiAgICAgICc8dGg+SmFocjwvdGg+PHRoPkF1w59lbiDDmDwvdGg+PHRoPkhlaXpzdHJvbTwvdGg+PHRoPkhlaXp3w6RybWU8L3RoPjx0aD5IZWl6LUNPUDwvdGg+PHRoPkhHVDwvdGg+PHRoPlN0cm9tL0hHVDwvdGg+JysKICAgICAgJzwvdHI+PC90aGVhZD48dGJvZHk+Jytib2R5Kyc8L3Rib2R5PjwvdGFibGU+PC9kaXY+JzsKICAgIGxldCBpbmZvPSJGZWhsZW5kZSBXZXJ0ZSBiZWRldXRlbjoga2VpbiB2b2xsc3TDpG5kaWcgdmVyZ2xlaWNoYmFyZXIgTW9uYXRzd2VydC4gSEdUID0gSGVpemdyYWR0YWdlICgxNSDCsEMpOyBIZWl6LUNPUCA9IGVyemV1Z3RlIEhlaXp3w6RybWUgLyBIZWl6c3Ryb20uIjsKICAgIGNvbnN0IHByZXNlbnQ9eWVhcnMubWFwKHk9Pm1hdHJpeC5nZXQoeSk/LltudW1iZXItMV0pLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUocj8udGVtcCkmJk51bWJlci5pc0Zpbml0ZShyPy5lbGVjdHJpYykpOwogICAgaWYocHJlc2VudC5sZW5ndGg+PTIpewogICAgICBjb25zdCBhPXByZXNlbnQuYXQoLTIpLGI9cHJlc2VudC5hdCgtMSk7CiAgICAgIGNvbnN0IHQ9Yi50ZW1wLWEudGVtcCxlPWIuZWxlY3RyaWMtYS5lbGVjdHJpYzsKICAgICAgY29uc3QgdGVtcFdvcmRzPXQ+MC4wNT9udW0odCwxKSsiIMKwQyB3w6RybWVyIjp0PC0uMDU/bnVtKC10LDEpKyIgwrBDIGvDpGx0ZXIiOiJuYWhlenUgZ2xlaWNoIHdhcm0iOwogICAgICBjb25zdCBlbmVyZ3lXb3Jkcz1lPjA/InVtICIrbnVtKGUpKyIga1doIG1laHIiOmU8MD8idW0gIitudW0oLWUpKyIga1doIHdlbmlnZXIiOiJnbGVpY2ggdmllbCI7CiAgICAgIGluZm89Yi55ZWFyKyIgd2FyIGdlZ2Vuw7xiZXIgIithLnllYXIrIiAiK3RlbXBXb3JkcysiOyBkaWUgV8Okcm1lcHVtcGUgYnJhdWNodGUgIitlbmVyZ3lXb3JkcysKICAgICAgICAiIEhlaXpzdHJvbS4gRWluIGdlcmluZ2VyZXIgU3Ryb21iZWRhcmYga2FubiBuZWJlbiBkZW0gV2V0dGVyIHdlaXRlcmUgVXJzYWNoZW4gaGFiZW4uIjsKICAgIH0KICAgIGVsLmlubmVySFRNTD1oZWFkK3RhYmxlKyc8cD4nK2VzY2FwZUh0bWwoaW5mbykrJzwvcD4nOwogIH0KICBmdW5jdGlvbiBkcmF3Q2xpbWF0ZUNvdXBsZWRDaGFydChjYW52YXNJZCxtYXRyaXgseWVhcnMsbW9udGhzLG1ldHJpYyl7CiAgICBjb25zdCBjYW52YXM9JChjYW52YXNJZCksYz1jYW52YXNTZXR1cChjYW52YXMpO2lmKCFjKXJldHVybjsKICAgIGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jLGxlZnQ9NDcscmlnaHQ9MTAsdG9wPTE1LGJvdHRvbT0zNSxwbG90Vz13aWR0aC1sZWZ0LXJpZ2h0LHBsb3RIPWhlaWdodC10b3AtYm90dG9tOwogICAgY29uc3QgcG9zPWk9PmxlZnQrcGxvdFcqKGkrLjUpL21vbnRocy5sZW5ndGg7CiAgICBjb25zdCB2YWxzPXllYXJzLmZsYXRNYXAoeT0+bW9udGhzLm1hcChtPT5tYXRyaXguZ2V0KHkpPy5bbS0xXT8uW21ldHJpY10pKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTsKICAgIGNhbnZhcy5zZXRBdHRyaWJ1dGUoImFyaWEtbGFiZWwiLChtZXRyaWM9PT0idGVtcCI/IkF1w59lbnRlbXBlcmF0dXIgaW4gR3JhZCBDZWxzaXVzIjoiSGVpenN0cm9tIGRlciBXw6RybWVwdW1wZSBpbiBLaWxvd2F0dHN0dW5kZW4iKSsKICAgICAgIiBmw7xyICIreWVhcnMuam9pbigiLCAiKSsiIGltIGdsZWljaGVuIEphaHJlc21vbmF0c3Jhc3RlciIpOwogICAgaWYoIXZhbHMubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCxtZXRyaWM9PT0idGVtcCI/IldldHRlcmhpc3RvcmllIG5vY2ggbmljaHQgZ2VsYWRlbiI6IktlaW5lIEhlaXpzdHJvbS1Nb25hdHN3ZXJ0ZSIpO3JldHVybjt9CiAgICBjb25zdCBsb3c9bWV0cmljPT09InRlbXAiP01hdGguZmxvb3IoTWF0aC5taW4oLi4udmFscyktMyk6MDsKICAgIGNvbnN0IGhpPW1ldHJpYz09PSJ0ZW1wIj9NYXRoLmNlaWwoTWF0aC5tYXgoLi4udmFscykrMyk6TWF0aC5tYXgoMSxNYXRoLmNlaWwoTWF0aC5tYXgoLi4udmFscykqMS4xMikpOwogICAgY29uc3QgcmFuZ2U9TWF0aC5tYXgoMSxoaS1sb3cpLHk9dmFsdWU9PnRvcCtwbG90SCooMS0odmFsdWUtbG93KS9yYW5nZSk7CiAgICBjdHguZm9udD0nMTFweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmJztjdHgudGV4dEFsaWduPSJsZWZ0IjtjdHgubGluZVdpZHRoPTE7CiAgICBmb3IobGV0IGk9MDtpPD00O2krKyl7CiAgICAgIGNvbnN0IHl5PXRvcCtwbG90SCppLzQsdj1sb3crcmFuZ2UqKDEtaS80KTsKICAgICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkO2N0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKGxlZnQseXkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseXkpO2N0eC5zdHJva2UoKTsKICAgICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZmlsbFRleHQobWV0cmljPT09ImVsZWN0cmljIiYmdj49MTAwMD9udW0odi8xMDAwLDEpKyJrIjpudW0odiwwKSwzLHl5KzMpOwogICAgfQogICAgY3R4LnRleHRBbGlnbj0iY2VudGVyIjtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5mb250PScxMXB4IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LFNlZ29lIFVJLHNhbnMtc2VyaWYnOwogICAgbW9udGhzLmZvckVhY2goKG0saSk9PmN0eC5maWxsVGV4dChNT05USFNbbS0xXSxwb3MoaSksaGVpZ2h0LTEwKSk7CiAgICB5ZWFycy5mb3JFYWNoKCh5ZWFyLGopPT57CiAgICAgIGNvbnN0IGNvbG9yPWRhc2hib2FyZENvbXBhcmlzb25Db2xvcih5ZWFyLGopLGRhdGE9bWF0cml4LmdldCh5ZWFyKTsKICAgICAgY3R4LnN0cm9rZVN0eWxlPWNvbG9yO2N0eC5maWxsU3R5bGU9Y29sb3I7Y3R4LmxpbmVXaWR0aD0yLjg7Y3R4LmJlZ2luUGF0aCgpOwogICAgICBsZXQgc3RhcnRlZD1mYWxzZTsKICAgICAgbW9udGhzLmZvckVhY2goKG1vbnRoLGkpPT57CiAgICAgICAgY29uc3Qgdj1kYXRhPy5bbW9udGgtMV0/LlttZXRyaWNdOwogICAgICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUodikpe3N0YXJ0ZWQ9ZmFsc2U7cmV0dXJuO30KICAgICAgICBpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyhwb3MoaSkseSh2KSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8ocG9zKGkpLHkodikpOwogICAgICB9KTsKICAgICAgY3R4LnN0cm9rZSgpOwogICAgICBtb250aHMuZm9yRWFjaCgobW9udGgsaSk9PnsKICAgICAgICBjb25zdCB2PWRhdGE/Llttb250aC0xXT8uW21ldHJpY107aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47CiAgICAgICAgY3R4LmJlZ2luUGF0aCgpO2N0eC5hcmMocG9zKGkpLHkodiksMy4yLDAsMipNYXRoLlBJKTtjdHguZmlsbCgpOwogICAgICB9KTsKICAgIH0pOwogICAgY29uc3Qgc2VsZWN0ZWQ9TnVtYmVyKFN0cmluZyhkYXNoYm9hcmRDbGltYXRlU2VsZWN0ZWRNb250aHx8IiIpLnNsaWNlKC0yKSksaXg9bW9udGhzLmluZGV4T2Yoc2VsZWN0ZWQpOwogICAgaWYoaXg+PTApe2N0eC5zZXRMaW5lRGFzaChbMyw0XSk7Y3R4LnN0cm9rZVN0eWxlPSJyZ2JhKDIxMiwyMzYsMjUxLC43KSI7Y3R4LmxpbmVXaWR0aD0xOwogICAgICBjdHguYmVnaW5QYXRoKCk7Y3R4Lm1vdmVUbyhwb3MoaXgpLHRvcCk7Y3R4LmxpbmVUbyhwb3MoaXgpLHRvcCtwbG90SCk7Y3R4LnN0cm9rZSgpO2N0eC5zZXRMaW5lRGFzaChbXSk7fQogICAgY3R4LnRleHRBbGlnbj0ibGVmdCI7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckRhc2hib2FyZCgpewogICAgY29uc3QgbGF0ZXN0PWxhdGVzdFJlY29yZCgpOwogICAgJCgibGF0ZXN0TW9udGhUaXRsZSIpLnRleHRDb250ZW50PWxhdGVzdD9tb250aExhYmVsKGxhdGVzdC5tb250aCk6Ik5vY2gga2VpbmUgTW9uYXRzd2VydGUiOwogICAgJCgiZWRpdExhdGVzdEJ0biIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIWxhdGVzdCk7CiAgICBpZihsYXRlc3QpJCgiZWRpdExhdGVzdEJ0biIpLmRhdGFzZXQubW9udGg9bGF0ZXN0Lm1vbnRoOwogICAgY29uc3QgcmVzdD1sYXRlc3Q/ZGVyaXZlZChsYXRlc3QpOm51bGw7CiAgICBjb25zdCBtZXRyaWNzPWxhdGVzdD9bCiAgICAgIFsiR2VzYW10IixgJHtudW0obGF0ZXN0LnRvdGFsLDEpfSBrV2hgLGxhdGVzdC5tZXRlclJlYWRpbmdEYXRlP2BhdXMgWsOkaGxlcnN0YW5kICR7ZGF0ZUxhYmVsKGxhdGVzdC5tZXRlclJlYWRpbmdEYXRlKX1gOiJkb2t1bWVudGllcnQiXSwKICAgICAgWyJXw6RybWVwdW1wZSIsYCR7bnVtKGxhdGVzdC5oZWF0UHVtcCwxKX0ga1doYCxOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmbGF0ZXN0LnRvdGFsPjAmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QuaGVhdFB1bXApP2Ake251bShsYXRlc3QuaGVhdFB1bXAvbGF0ZXN0LnRvdGFsKjEwMCwxKX0gJSBBbnRlaWxgOiLigJMiXSwKICAgICAgWyJBbHRlbnRlaWwiLGAke251bShsYXRlc3QuYW5uZXgsMSl9IGtXaGAsbGF0ZXN0Lm1ldGVyUmVhZGluZ0RhdGU/YFrDpGhsZXIgJHtudW0obGF0ZXN0LmFubmV4TWV0ZXJSZWFkaW5nLDApfSBrV2hgOk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZsYXRlc3QudG90YWw+MCYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC5hbm5leCk/YCR7bnVtKGxhdGVzdC5hbm5leC9sYXRlc3QudG90YWwqMTAwLDEpfSAlIEFudGVpbGA6IuKAkyJdLAogICAgICBbIlNjaGxlZS9LbHVzIixgJHtudW0ocmVzdCwxKX0ga1doYCxOdW1iZXIuaXNGaW5pdGUocmVzdCkmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZsYXRlc3QudG90YWw+MD9gJHtudW0ocmVzdC9sYXRlc3QudG90YWwqMTAwLDEpfSAlIEFudGVpbGA6ImF1dG9tYXRpc2NoIl0sCiAgICAgIFsiS29zdGVuIixldXJvKHJlY29yZENvc3QobGF0ZXN0KSksbGF0ZXN0Lm9zdHJvbVByaWNlQ29tcGxldGU/YE9zdHJvbSBleGFrdCDCtyAke251bShsYXRlc3QucHJpY2VDdCwyKX0gY3Qva1doYDpOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnByaWNlQ3QpP2Ake251bShsYXRlc3QucHJpY2VDdCwyKX0gY3Qva1doYDoiRmFsbGJhY2stUHJlaXMiXQogICAgXTpbWyJHZXNhbXQiLCLigJMiLCJNb25hdCBlaW50cmFnZW4iXSxbIlfDpHJtZXB1bXBlIiwi4oCTIiwiIl0sWyJBbHRlbnRlaWwiLCLigJMiLCIiXSxbIlNjaGxlZS9LbHVzIiwi4oCTIiwiIl0sWyJLb3N0ZW4iLCLigJMiLCIiXV07CiAgICAkKCJsYXRlc3RNZXRyaWNzIikuaW5uZXJIVE1MPW1ldHJpY3MubWFwKChbbGFiZWwsdmFsdWUsc21hbGxdKT0+YDxhcnRpY2xlPjxzcGFuPiR7bGFiZWx9PC9zcGFuPjxzdHJvbmc+JHt2YWx1ZX08L3N0cm9uZz48c21hbGw+JHtzbWFsbH08L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCIiKTsKICAgIGNvbnN0IGNvbXBhcmU9bGF0ZXN0P3JlY29yZEZvck1vbnRoKGAke051bWJlcihsYXRlc3QubW9udGguc2xpY2UoMCw0KSktMX0tJHtsYXRlc3QubW9udGguc2xpY2UoNSw3KX1gKTpudWxsOwogICAgY29uc3QgZGVsdGE9bGF0ZXN0JiZjb21wYXJlJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmTnVtYmVyLmlzRmluaXRlKGNvbXBhcmUudG90YWwpJiZjb21wYXJlLnRvdGFsIT09MD8obGF0ZXN0LnRvdGFsLWNvbXBhcmUudG90YWwpL2NvbXBhcmUudG90YWwqMTAwOm51bGw7CiAgICBjb25zdCBjb21wPSQoImxhdGVzdENvbXBhcmlzb24iKTsKICAgIGNvbXAuY2xhc3NOYW1lPSJjb21wYXJpc29uLWxpbmUgbmV1dHJhbCI7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUoZGVsdGEpKXsKICAgICAgY29tcC50ZXh0Q29udGVudD1gWnVtIGdsZWljaGVuIE1vbmF0IGRlcyBWb3JqYWhyZXM6ICR7cGN0KGRlbHRhKX0gKCR7bnVtKGxhdGVzdC50b3RhbC1jb21wYXJlLnRvdGFsLDEpfSBrV2gpLmA7CiAgICAgIGNvbXAuY2xhc3NOYW1lPWBjb21wYXJpc29uLWxpbmUgJHtkZWx0YT4wPyJwb3NpdGl2ZSI6ZGVsdGE8MD8ibmVnYXRpdmUiOiJuZXV0cmFsIn1gOwogICAgfWVsc2UgY29tcC50ZXh0Q29udGVudD1sYXRlc3Q/IkbDvHIgZGllc2VuIE1vbmF0IGlzdCBub2NoIGtlaW4gdm9sbHN0w6RuZGlnZXIgVm9yamFocmVzdmVyZ2xlaWNoIHZvcmhhbmRlbi4iOiJUcmFnZSBkZW4gZXJzdGVuIE1vbmF0c3dlcnQgZWluLiI7CiAgICBkcmF3RGFzaGJvYXJkQ29uc3VtcHRpb24oKTsKICAgIHJlbmRlck9zdHJvbURhc2hib2FyZCgpOwogICAgcmVuZGVyRGFzaGJvYXJkQ2xpbWF0ZSgpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyUmVjb3JkcygpewogICAgY29uc3QgeXM9eWVhcnMoKTsKICAgIGNvbnN0IHNlbGVjdD0kKCJyZWNvcmRZZWFyRmlsdGVyIik7CiAgICBjb25zdCBjdXJyZW50PXNlbGVjdC52YWx1ZXx8ImFsbCI7CiAgICBzZWxlY3QuaW5uZXJIVE1MPSc8b3B0aW9uIHZhbHVlPSJhbGwiPkFsbGUgSmFocmU8L29wdGlvbj4nK3lzLm1hcCh5PT5gPG9wdGlvbiB2YWx1ZT0iJHt5fSI+JHt5fTwvb3B0aW9uPmApLmpvaW4oIiIpOwogICAgc2VsZWN0LnZhbHVlPXlzLmluY2x1ZGVzKE51bWJlcihjdXJyZW50KSk/Y3VycmVudDoiYWxsIjsKICAgIGNvbnN0IGZpbHRlcmVkPXNvcnRlZCgpLnJldmVyc2UoKS5maWx0ZXIocj0+c2VsZWN0LnZhbHVlPT09ImFsbCJ8fHIubW9udGguc3RhcnRzV2l0aChgJHtzZWxlY3QudmFsdWV9LWApKTsKICAgICQoInJlY29yZENvdW50IikudGV4dENvbnRlbnQ9YCR7ZmlsdGVyZWQubGVuZ3RofSAke2ZpbHRlcmVkLmxlbmd0aD09PTE/Ik1vbmF0IjoiTW9uYXRlIn1gOwogICAgaWYoIWZpbHRlcmVkLmxlbmd0aCl7ICQoInJlY29yZExpc3QiKS5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImVtcHR5LXN0YXRlIj48c3Ryb25nPk5vY2gga2VpbmUgTW9uYXRzd2VydGUgaW4gZGllc2VyIEF1c3dhaGwuPC9zdHJvbmc+PHNwYW4+WsOkaGxlcnN0w6RuZGUgdW5kIG15VkFJTExBTlQtQ1NWIGVyemV1Z2VuIGRpZSBNb25hdHN3ZXJ0ZSBhdXRvbWF0aXNjaC48L3NwYW4+PC9kaXY+JzsgcmV0dXJuOyB9CiAgICAkKCJyZWNvcmRMaXN0IikuaW5uZXJIVE1MPWZpbHRlcmVkLm1hcChyPT57CiAgICAgIGNvbnN0IHJlc3Q9ZGVyaXZlZChyKSwgaW52YWxpZD1OdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8MDsKICAgICAgY29uc3Qgc3RhdHVzPWludmFsaWQ/IlVucGxhdXNpYmVsIjpjb21wbGV0ZShyKT8idm9sbHN0w6RuZGlnIjoidW52b2xsc3TDpG5kaWciOwogICAgICBjb25zdCBzb3VyY2U9KHIubWV0ZXJSZWFkaW5nRGF0ZT9gIOKAoiBaw6RobGVyIGJpcyAke2RhdGVMYWJlbChyLm1ldGVyUmVhZGluZ0RhdGUpfWA6ci5oZWF0UHVtcFNvdXJjZT8uc3RhcnRzV2l0aCgibXl2YWlsbGFudCIpPyIg4oCiIFfDpHJtZXB1bXBlIGF1cyBDU1YiOiIiKSsoci5vc3Ryb21QcmljZUNvbXBsZXRlPyIg4oCiIE9zdHJvbS1QcmVpcyBleGFrdCI6IiIpOwogICAgICByZXR1cm4gYDxhcnRpY2xlIGNsYXNzPSJyZWNvcmQtcm93ICR7aW52YWxpZD8iaW52YWxpZCI6IiJ9Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtbW9udGgiPjxzdHJvbmc+JHtlc2NhcGVIdG1sKG1vbnRoTGFiZWwoci5tb250aCkpfTwvc3Ryb25nPjxzbWFsbD4ke3N0YXR1c30ke3NvdXJjZX0ke3Iubm90ZT9gIOKAoiAke2VzY2FwZUh0bWwoci5ub3RlLnNsaWNlKDAsNzApKX1gOiIifTwvc21hbGw+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5HZXNhbXQ8L3NwYW4+PHN0cm9uZz4ke251bShyLnRvdGFsLDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPlfDpHJtZXB1bXBlPC9zcGFuPjxzdHJvbmc+JHtudW0oci5oZWF0UHVtcCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5BbHRlbnRlaWw8L3NwYW4+PHN0cm9uZz4ke251bShyLmFubmV4LDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPlNjaGxlZS9LbHVzPC9zcGFuPjxzdHJvbmc+JHtudW0ocmVzdCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QgZWRpdC1yZWNvcmQiIHR5cGU9ImJ1dHRvbiIgZGF0YS1lZGl0LW1vbnRoPSIke3IubW9udGh9Ij5CZWFyYmVpdGVuPC9idXR0b24+CiAgICAgIDwvYXJ0aWNsZT5gOwogICAgfSkuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiBvcGVuUmVjb3JkTW9kYWwobW9udGgpewogICAgY29uc3Qgcj1yZWNvcmRGb3JNb250aChtb250aCk7CiAgICBpZighcil7dG9hc3QoIk1vbmF0IG5pY2h0IGdlZnVuZGVuIik7cmV0dXJuO30KICAgICQoInJlY29yZE1vZGFsVGl0bGUiKS50ZXh0Q29udGVudD1tb250aExhYmVsKHIubW9udGgpOwogICAgJCgiZWRpdGluZ01vbnRoT3JpZ2luYWwiKS52YWx1ZT1yLm1vbnRoOwogICAgJCgicmVjb3JkTW9udGgiKS52YWx1ZT1yLm1vbnRoOwogICAgJCgicmVjb3JkVG90YWwiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci50b3RhbCk/ci50b3RhbDoiIjsKICAgICQoInJlY29yZEhlYXRQdW1wIikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApP3IuaGVhdFB1bXA6IiI7CiAgICAkKCJyZWNvcmRBbm5leCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmFubmV4KT9yLmFubmV4OiIiOwogICAgJCgicmVjb3JkUHJpY2VDdCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLnByaWNlQ3QpP3IucHJpY2VDdDoiIjsKICAgICQoInJlY29yZEJhc2VGZWUiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5iYXNlRmVlKT9yLmJhc2VGZWU6IiI7CiAgICAkKCJyZWNvcmRIZWF0R2VuZXJhdGVkIikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdEdlbmVyYXRlZCk/ci5oZWF0R2VuZXJhdGVkOiIiOwogICAgJCgicmVjb3JkSGVhdGluZ0VsZWN0cmljaXR5IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdGluZ0VsZWN0cmljaXR5KT9yLmhlYXRpbmdFbGVjdHJpY2l0eToiIjsKICAgICQoInJlY29yZERod0VsZWN0cmljaXR5IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuZGh3RWxlY3RyaWNpdHkpP3IuZGh3RWxlY3RyaWNpdHk6IiI7CiAgICAkKCJyZWNvcmRIZWF0aW5nSGVhdCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmhlYXRpbmdIZWF0KT9yLmhlYXRpbmdIZWF0OiIiOwogICAgJCgicmVjb3JkRGh3SGVhdCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmRod0hlYXQpP3IuZGh3SGVhdDoiIjsKICAgICQoInJlY29yZE5vdGUiKS52YWx1ZT1yLm5vdGV8fCIiOwogICAgJCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSIiOwogICAgJCgicmVjb3JkU291cmNlSGludCIpLnRleHRDb250ZW50PXIubWV0ZXJSZWFkaW5nRGF0ZQogICAgICA/IGBEaWVzZXIgTW9uYXQgd3VyZGUgYXVzIFrDpGhsZXJzdMOkbmRlbiBiZXJlY2huZXQuIEVpbmUgS29ycmVrdHVyIGhpZXIgw6RuZGVydCBudXIgZGVuIE1vbmF0c3dlcnQ7IGRpZSBnZXNwZWljaGVydGVuIFrDpGhsZXJzdMOkbmRlIGJpcyAke2RhdGVMYWJlbChyLm1ldGVyUmVhZGluZ0RhdGUpfSBibGVpYmVuIGVyaGFsdGVuLmAKICAgICAgOiByLmhlYXRQdW1wU291cmNlPy5zdGFydHNXaXRoKCJteXZhaWxsYW50IikKICAgICAgICA/ICJEaWUgV8Okcm1lcHVtcGVud2VydGUgc3RhbW1lbiBhdXMgZWluZXIgbXlWQUlMTEFOVC1DU1YuIE1hbnVlbGxlIMOEbmRlcnVuZ2VuIGvDtm5uZW4gYmVpIGVpbmVtIHNww6R0ZXJlbiBlcm5ldXRlbiBDU1YtSW1wb3J0IHdpZWRlciBlcnNldHp0IHdlcmRlbi4iCiAgICAgICAgOiAiTWFudWVsbGUgS29ycmVrdHVyIGVpbmVzIGdlc3BlaWNoZXJ0ZW4gTW9uYXRzd2VydGVzLiI7CiAgICB1cGRhdGVEZXJpdmVkUHJldmlldygpOwogICAgJCgicmVjb3JkTW9kYWwiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsKICAgIGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9ImhpZGRlbiI7CiAgfQogIGZ1bmN0aW9uIGNsb3NlUmVjb3JkTW9kYWwoKXsgJCgicmVjb3JkTW9kYWwiKS5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsgZG9jdW1lbnQuYm9keS5zdHlsZS5vdmVyZmxvdz0iIjsgfQogIGZ1bmN0aW9uIHVwZGF0ZURlcml2ZWRQcmV2aWV3KCl7CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRUb3RhbCIpLnZhbHVlKSxoZWF0PW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRQdW1wIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEFubmV4IikudmFsdWUpOwogICAgY29uc3QgZWw9JCgiZGVyaXZlZFByZXZpZXciKTsKICAgIGlmKFt0b3RhbCxoZWF0LGFubmV4XS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpKXsKICAgICAgY29uc3QgcmVzdD10b3RhbC1oZWF0LWFubmV4OwogICAgICBlbC50ZXh0Q29udGVudD1gU2NobGVlL0tsdXM6ICR7bnVtKHJlc3QsMyl9IGtXaGA7CiAgICAgIGVsLmNsYXNzTGlzdC50b2dnbGUoImVycm9yIixyZXN0PDApOwogICAgfWVsc2V7CiAgICAgIGVsLnRleHRDb250ZW50PSJTY2hsZWUvS2x1czog4oCTICh3aXJkIGF1cyBHZXNhbXQg4oiSIFfDpHJtZXB1bXBlIOKIkiBBbHRlbnRlaWwgYmVyZWNobmV0KSI7CiAgICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoImVycm9yIik7CiAgICB9CiAgfQogIGZ1bmN0aW9uIHNhdmVFZGl0ZWRSZWNvcmQoZXZlbnQpewogICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IG1vbnRoPSQoImVkaXRpbmdNb250aE9yaWdpbmFsIikudmFsdWU7CiAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aChtb250aCk7CiAgICBpZighZXhpc3RpbmcpeyQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iRGVyIE1vbmF0IHd1cmRlIG5pY2h0IGdlZnVuZGVuLiI7cmV0dXJuO30KICAgIGNvbnN0IHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoInJlY29yZFRvdGFsIikudmFsdWUpLGhlYXRQdW1wPW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRQdW1wIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEFubmV4IikudmFsdWUpOwogICAgaWYoW3RvdGFsLGhlYXRQdW1wLGFubmV4XS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpJiZ0b3RhbC1oZWF0UHVtcC1hbm5leDwtLjAxKXsKICAgICAgJCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJVbnBsYXVzaWJlbDogV8Okcm1lcHVtcGUgKyBBbHRlbnRlaWwgc2luZCBncsO2w59lciBhbHMgZGVyIEdlc2FtdHZlcmJyYXVjaC4iO3JldHVybjsKICAgIH0KICAgIGNvbnN0IGhlYXRDaGFuZ2VkPWhlYXRQdW1wIT09ZXhpc3RpbmcuaGVhdFB1bXA7CiAgICBjb25zdCBtZXRlckNoYW5nZWQ9dG90YWwhPT1leGlzdGluZy50b3RhbHx8YW5uZXghPT1leGlzdGluZy5hbm5leDsKICAgIGNvbnN0IG5leHRQcmljZUN0PW51bGxhYmxlTnVtYmVyKCQoInJlY29yZFByaWNlQ3QiKS52YWx1ZSksbmV4dEJhc2VGZWU9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkQmFzZUZlZSIpLnZhbHVlKTsKICAgIGNvbnN0IHByaWNlQ2hhbmdlZD1uZXh0UHJpY2VDdCE9PWV4aXN0aW5nLnByaWNlQ3R8fG5leHRCYXNlRmVlIT09ZXhpc3RpbmcuYmFzZUZlZTsKICAgIGNvbnN0IHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIGNvbnN0IHJlY29yZD17Li4uZXhpc3RpbmcsCiAgICAgIHRvdGFsLGhlYXRQdW1wLGFubmV4LAogICAgICBwcmljZUN0Om5leHRQcmljZUN0LAogICAgICBiYXNlRmVlOm5leHRCYXNlRmVlLAogICAgICBoZWF0R2VuZXJhdGVkOm51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRHZW5lcmF0ZWQiKS52YWx1ZSksCiAgICAgIGhlYXRpbmdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiKS52YWx1ZSksCiAgICAgIGRod0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZERod0VsZWN0cmljaXR5IikudmFsdWUpLAogICAgICBoZWF0aW5nSGVhdDpudWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0aW5nSGVhdCIpLnZhbHVlKSwKICAgICAgZGh3SGVhdDpudWxsYWJsZU51bWJlcigkKCJyZWNvcmREaHdIZWF0IikudmFsdWUpLAogICAgICBub3RlOiQoInJlY29yZE5vdGUiKS52YWx1ZS50cmltKCksCiAgICAgIGhlYXRQdW1wU291cmNlOmhlYXRDaGFuZ2VkPyJtYW51YWwtY29ycmVjdGlvbiI6ZXhpc3RpbmcuaGVhdFB1bXBTb3VyY2UsCiAgICAgIGhlYXRQdW1wVXBkYXRlZEF0OmhlYXRDaGFuZ2VkP3N0YW1wOmV4aXN0aW5nLmhlYXRQdW1wVXBkYXRlZEF0LAogICAgICBtZXRlclNvdXJjZTptZXRlckNoYW5nZWQmJmV4aXN0aW5nLm1ldGVyU291cmNlP2Ake2V4aXN0aW5nLm1ldGVyU291cmNlfSttYW51YWwtbW9udGgtY29ycmVjdGlvbmA6ZXhpc3RpbmcubWV0ZXJTb3VyY2UsCiAgICAgIHByaWNlU291cmNlOnByaWNlQ2hhbmdlZD8ibWFudWFsLWNvcnJlY3Rpb24iOmV4aXN0aW5nLnByaWNlU291cmNlLAogICAgICBwcmljZVVwZGF0ZWRBdDpwcmljZUNoYW5nZWQ/c3RhbXA6ZXhpc3RpbmcucHJpY2VVcGRhdGVkQXQsCiAgICAgIG9zdHJvbVZhcmlhYmxlQ29zdEV1cjpwcmljZUNoYW5nZWQ/bnVsbDpleGlzdGluZy5vc3Ryb21WYXJpYWJsZUNvc3RFdXIsCiAgICAgIG9zdHJvbVRvdGFsQ29zdEV1cjpwcmljZUNoYW5nZWQ/bnVsbDpleGlzdGluZy5vc3Ryb21Ub3RhbENvc3RFdXIsCiAgICAgIG9zdHJvbUNvbnN1bXB0aW9uS1doOnByaWNlQ2hhbmdlZD9udWxsOmV4aXN0aW5nLm9zdHJvbUNvbnN1bXB0aW9uS1doLAogICAgICBvc3Ryb21QcmljZUNvbXBsZXRlOnByaWNlQ2hhbmdlZD9mYWxzZTpleGlzdGluZy5vc3Ryb21QcmljZUNvbXBsZXRlLAogICAgICB1cGRhdGVkQXQ6c3RhbXAKICAgIH07CiAgICBjb25zdCBuZXh0PXJlY29yZHMuZmlsdGVyKHI9PnIubW9udGghPT1tb250aCk7bmV4dC5wdXNoKHJlY29yZCk7CiAgICB0cnl7c2F2ZVJlY29yZHMobmV4dCx7cmVhc29uOmBNb25hdCAke21vbnRofSBtYW51ZWxsIGtvcnJpZ2llcnRgfSk7fQogICAgY2F0Y2goZXJyb3IpeyQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1lcnJvci5tZXNzYWdlO3JldHVybjt9CiAgICBjbG9zZVJlY29yZE1vZGFsKCk7cmVuZGVyQWxsKCk7dG9hc3QoYCR7bW9udGhMYWJlbChtb250aCl9IGdlw6RuZGVydGApOwogIH0KCiAgZnVuY3Rpb24gb3Blbk1ldGVyTW9kYWwoKXsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXthbGVydCgiRXMgZmVobHQgZWluIEF1c2dhbmdzesOkaGxlcnN0YW5kLiIpO3JldHVybjt9CiAgICAkKCJtZXRlckRhdGUiKS52YWx1ZT1uZXh0TW9udGhGaXJzdChwcmV2aW91cy5kYXRlKTsKICAgICQoIm1ldGVyVG90YWwiKS52YWx1ZT0iIjsKICAgICQoIm1ldGVyQW5uZXgiKS52YWx1ZT0iIjsKICAgICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSIiOwogICAgdXBkYXRlTWV0ZXJQcmV2aWV3KCk7CiAgICAkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7CiAgICBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSJoaWRkZW4iOwogICAgc2V0VGltZW91dCgoKT0+JCgibWV0ZXJUb3RhbCIpLmZvY3VzKCksNTApOwogIH0KICBmdW5jdGlvbiBjbG9zZU1ldGVyTW9kYWwoKXsgJCgibWV0ZXJNb2RhbCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOyBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSIiOyB9CiAgZnVuY3Rpb24gdXBkYXRlTWV0ZXJQcmV2aWV3KCl7CiAgICBjb25zdCBwcmV2aW91cz1sYXRlc3RNZXRlclJlYWRpbmcoKTsKICAgIGlmKCFwcmV2aW91cylyZXR1cm47CiAgICBjb25zdCBkYXRlPSQoIm1ldGVyRGF0ZSIpLnZhbHVlfHxuZXh0TW9udGhGaXJzdChwcmV2aW91cy5kYXRlKTsKICAgIGNvbnN0IHRhcmdldE1vbnRoPXByZXZpb3VzLmRhdGUuc2xpY2UoMCw3KTsKICAgICQoIm1ldGVyUHJldmlvdXMiKS5pbm5lckhUTUw9YFZvcmhlcmlnZXIgU3RhbmQ6IDxzdHJvbmc+JHtkYXRlTGFiZWwocHJldmlvdXMuZGF0ZSl9PC9zdHJvbmc+IMK3IEdlc2FtdCA8c3Ryb25nPiR7bnVtKHByZXZpb3VzLnRvdGFsLDApfSBrV2g8L3N0cm9uZz4gwrcgQWx0ZW50ZWlsIDxzdHJvbmc+JHtudW0ocHJldmlvdXMuYW5uZXgsMCl9IGtXaDwvc3Ryb25nPmA7CiAgICAkKCJtZXRlclRhcmdldE1vbnRoIikudGV4dENvbnRlbnQ9YEJlcmVjaG5ldCB3aXJkIGRlciBWZXJicmF1Y2ggZsO8ciAke21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfS5gOwogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJUb3RhbCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJtZXRlckFubmV4IikudmFsdWUpOwogICAgaWYoTnVtYmVyLmlzRmluaXRlKHRvdGFsKSYmTnVtYmVyLmlzRmluaXRlKGFubmV4KSl7CiAgICAgIGNvbnN0IHRvdGFsVXNlPXRvdGFsLXByZXZpb3VzLnRvdGFsLGFubmV4VXNlPWFubmV4LXByZXZpb3VzLmFubmV4OwogICAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aCh0YXJnZXRNb250aCksaGVhdD1leGlzdGluZz8uaGVhdFB1bXA7CiAgICAgIGNvbnN0IHJlc3Q9TnVtYmVyLmlzRmluaXRlKGhlYXQpP3RvdGFsVXNlLWFubmV4VXNlLWhlYXQ6bnVsbDsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuaW5uZXJIVE1MPWBHZXNhbXQ6IDxzdHJvbmc+JHtudW0odG90YWxVc2UsMSl9IGtXaDwvc3Ryb25nPiDCtyBBbHRlbnRlaWw6IDxzdHJvbmc+JHtudW0oYW5uZXhVc2UsMSl9IGtXaDwvc3Ryb25nPiR7TnVtYmVyLmlzRmluaXRlKGhlYXQpP2AgwrcgV8Okcm1lcHVtcGU6IDxzdHJvbmc+JHtudW0oaGVhdCwxKX0ga1doPC9zdHJvbmc+IMK3IFNjaGxlZS9LbHVzOiA8c3Ryb25nPiR7bnVtKHJlc3QsMSl9IGtXaDwvc3Ryb25nPmA6YCDCtyBXw6RybWVwdW1wZTogPHN0cm9uZz5DU1YgZmVobHQ8L3N0cm9uZz5gfWA7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLmNsYXNzTGlzdC50b2dnbGUoImVycm9yIix0b3RhbFVzZTwwfHxhbm5leFVzZTwwfHwoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PDApKTsKICAgIH1lbHNlewogICAgICAkKCJtZXRlclByZXZpZXciKS50ZXh0Q29udGVudD0iTW9uYXRzdmVyYnLDpHVjaGUgd2VyZGVuIGF1cyBkZXIgRGlmZmVyZW56IHp1bSB2b3JoZXJpZ2VuIFrDpGhsZXJzdGFuZCBiZXJlY2huZXQuIjsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuY2xhc3NMaXN0LnJlbW92ZSgiZXJyb3IiKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2F2ZU1ldGVyUmVhZGluZ0Zyb21Gb3JtKGV2ZW50KXsKICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICBjb25zdCBwcmV2aW91cz1sYXRlc3RNZXRlclJlYWRpbmcoKTsKICAgIGlmKCFwcmV2aW91cylyZXR1cm47CiAgICBjb25zdCBkYXRlPSQoIm1ldGVyRGF0ZSIpLnZhbHVlLHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyVG90YWwiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJBbm5leCIpLnZhbHVlKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChkYXRlKSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJCaXR0ZSBlaW4gZ8O8bHRpZ2VzIEFibGVzZWRhdHVtIHfDpGhsZW4uIjsgcmV0dXJuOyB9CiAgICBpZihkYXRlPD1wcmV2aW91cy5kYXRlKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9YERhcyBEYXR1bSBtdXNzIG5hY2ggZGVtIGxldHp0ZW4gU3RhbmQgdm9tICR7ZGF0ZUxhYmVsKHByZXZpb3VzLmRhdGUpfSBsaWVnZW4uYDsgcmV0dXJuOyB9CiAgICBpZighTnVtYmVyLmlzRmluaXRlKHRvdGFsKXx8IU51bWJlci5pc0Zpbml0ZShhbm5leCkpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iQml0dGUgYmVpZGUgWsOkaGxlcnN0w6RuZGUgZWludHJhZ2VuLiI7IHJldHVybjsgfQogICAgaWYodG90YWw8cHJldmlvdXMudG90YWwpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iRGVyIEdlc2FtdHrDpGhsZXJzdGFuZCBpc3Qga2xlaW5lciBhbHMgZGVyIHZvcmhlcmlnZSBTdGFuZC4gRWluIG5ldWVyIFrDpGhsZXIgbcO8c3N0ZSBzZXBhcmF0IGJlcsO8Y2tzaWNodGlndCB3ZXJkZW4uIjsgcmV0dXJuOyB9CiAgICBpZihhbm5leDxwcmV2aW91cy5hbm5leCl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBpc3Qga2xlaW5lciBhbHMgZGVyIHZvcmhlcmlnZSBTdGFuZC4iOyByZXR1cm47IH0KICAgIGNvbnN0IHRhcmdldE1vbnRoPXByZXZpb3VzLmRhdGUuc2xpY2UoMCw3KSx0b3RhbFVzZT10b3RhbC1wcmV2aW91cy50b3RhbCxhbm5leFVzZT1hbm5leC1wcmV2aW91cy5hbm5leDsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRoOnRhcmdldE1vbnRofSk7CiAgICBjb25zdCByZXN0PU51bWJlci5pc0Zpbml0ZShleGlzdGluZy5oZWF0UHVtcCk/dG90YWxVc2UtYW5uZXhVc2UtZXhpc3RpbmcuaGVhdFB1bXA6bnVsbDsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwtLjAxKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9YFVucGxhdXNpYmVsOiBOYWNoIEFienVnIHZvbiBXw6RybWVwdW1wZSB1bmQgQWx0ZW50ZWlsIGVyZ2lidCBTY2hsZWUvS2x1cyAke251bShyZXN0LDEpfSBrV2guYDsgcmV0dXJuOyB9CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgICBjb25zdCBuZXh0UmVjb3JkPXsuLi5leGlzdGluZyx0b3RhbDp0b3RhbFVzZSxhbm5leDphbm5leFVzZSxtZXRlclJlYWRpbmdEYXRlOmRhdGUscHJldmlvdXNNZXRlclJlYWRpbmdEYXRlOnByZXZpb3VzLmRhdGUsdG90YWxNZXRlclJlYWRpbmc6dG90YWwsYW5uZXhNZXRlclJlYWRpbmc6YW5uZXgsbWV0ZXJTb3VyY2U6ImN1bXVsYXRpdmUtcmVhZGluZ3MiLHVwZGF0ZWRBdDpzdGFtcH07CiAgICBjb25zdCBuZXh0PXJlY29yZHMuZmlsdGVyKHI9PnIubW9udGghPT10YXJnZXRNb250aCk7bmV4dC5wdXNoKG5leHRSZWNvcmQpOwogICAgdHJ5ewogICAgICBzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YFrDpGhsZXJzdMOkbmRlICR7ZGF0ZUxhYmVsKGRhdGUpfSBnZXNwZWljaGVydGB9KTsKICAgICAgc2F2ZU1ldGVyUmVhZGluZ3MoWy4uLm1ldGVyUmVhZGluZ3Mse2RhdGUsdG90YWwsYW5uZXgsbm90ZTpgVmVyYnJhdWNoICR7dGFyZ2V0TW9udGh9YCx1cGRhdGVkQXQ6c3RhbXB9XSk7CiAgICB9Y2F0Y2goZXJyb3IpeyQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWVycm9yLm1lc3NhZ2U7cmV0dXJuO30KICAgIGNsb3NlTWV0ZXJNb2RhbCgpO3JlbmRlckFsbCgpOwogICAgdG9hc3QoTnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmhlYXRQdW1wKT9gJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0gdm9sbHN0w6RuZGlnIGJlcmVjaG5ldGA6YFrDpGhsZXJzdMOkbmRlIGdlc3BlaWNoZXJ0IMK3IFfDpHJtZXB1bXBlbi1DU1YgZmVobHQgbm9jaGApOwogIH0KICBmdW5jdGlvbiB1bmRvTGF0ZXN0TWV0ZXJSZWFkaW5nKCl7CiAgICBpZihtZXRlclJlYWRpbmdzLmxlbmd0aDw9MSlyZXR1cm47CiAgICBjb25zdCBsYXRlc3Q9bWV0ZXJSZWFkaW5ncy5hdCgtMSkscHJldmlvdXM9bWV0ZXJSZWFkaW5ncy5hdCgtMiksdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpOwogICAgaWYoIWNvbmZpcm0oYFrDpGhsZXJzdGFuZCB2b20gJHtkYXRlTGFiZWwobGF0ZXN0LmRhdGUpfSB6dXLDvGNrbmVobWVuPyBEaWUgZGFyYXVzIGJlcmVjaG5ldGVuIFdlcnRlIGbDvHIgJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0gd2VyZGVuIGVudGZlcm50LmApKXJldHVybjsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKTsKICAgIGlmKGV4aXN0aW5nKXsKICAgICAgY29uc3QgY2xlYXJlZD17Li4uZXhpc3RpbmcsdG90YWw6bnVsbCxhbm5leDpudWxsLG1ldGVyUmVhZGluZ0RhdGU6bnVsbCxwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6bnVsbCx0b3RhbE1ldGVyUmVhZGluZzpudWxsLGFubmV4TWV0ZXJSZWFkaW5nOm51bGwsbWV0ZXJTb3VyY2U6IiIsdXBkYXRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKX07CiAgICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PXRhcmdldE1vbnRoKTtuZXh0LnB1c2goY2xlYXJlZCk7c2F2ZVJlY29yZHMobmV4dCx7cmVhc29uOmBMZXR6dGVuIFrDpGhsZXJzdGFuZCAke2xhdGVzdC5kYXRlfSB6dXLDvGNrZ2Vub21tZW5gfSk7CiAgICB9CiAgICBzYXZlTWV0ZXJSZWFkaW5ncyhtZXRlclJlYWRpbmdzLnNsaWNlKDAsLTEpKTtyZW5kZXJBbGwoKTt0b2FzdCgiTGV0enRlbiBaw6RobGVyc3RhbmQgenVyw7xja2dlbm9tbWVuIik7CiAgfQoKICBmdW5jdGlvbiBhbmFseXNpc1llYXJSb3dzKHllYXIpeyByZXR1cm4gcmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aC5zdGFydHNXaXRoKGAke3llYXJ9LWApKS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOyB9CiAgZnVuY3Rpb24gb3N0cm9tU3RhdHNGb3JZZWFyKHllYXIpewogICAgY29uc3QgY2FjaGU9bmV3IE1hcChvc3Ryb21QcmljZVN0YXRzLmZpbHRlcihpdGVtPT5pdGVtLm1vbnRoLnN0YXJ0c1dpdGgoYCR7eWVhcn0tYCkpLm1hcChpdGVtPT5baXRlbS5tb250aCxpdGVtXSkpOwogICAgZm9yKGNvbnN0IHIgb2YgYW5hbHlzaXNZZWFyUm93cyh5ZWFyKSl7CiAgICAgIGlmKCFyLm9zdHJvbVByaWNlQ29tcGxldGV8fCFOdW1iZXIuaXNGaW5pdGUoci5wcmljZUN0KXx8IU51bWJlci5pc0Zpbml0ZShyLm9zdHJvbUNvbnN1bXB0aW9uS1doKXx8ci5vc3Ryb21Db25zdW1wdGlvbktXaDw9MCljb250aW51ZTsKICAgICAgY29uc3QgZnJvbVJlY29yZD1zYW5pdGl6ZU9zdHJvbVByaWNlU3RhdCh7bW9udGg6ci5tb250aCx3ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaDpyLnByaWNlQ3QsdG90YWxLV2g6ci5vc3Ryb21Db25zdW1wdGlvbktXaCx2YXJpYWJsZUNvc3RFdXI6ci5vc3Ryb21WYXJpYWJsZUNvc3RFdXIsZml4ZWRDb3N0RXVyOnIuYmFzZUZlZSx0b3RhbENvc3RFdXI6ci5vc3Ryb21Ub3RhbENvc3RFdXIsY29tcGxldGU6dHJ1ZSxwYXJ0aWFsOmZhbHNlLHVwZGF0ZWRBdDpyLnByaWNlVXBkYXRlZEF0fHxyLnVwZGF0ZWRBdHx8IiJ9KTsKICAgICAgY29uc3QgZXhpc3Rpbmc9Y2FjaGUuZ2V0KHIubW9udGgpOwogICAgICBpZighZXhpc3Rpbmd8fERhdGUucGFyc2UoZnJvbVJlY29yZC51cGRhdGVkQXR8fCIiKT49RGF0ZS5wYXJzZShleGlzdGluZy51cGRhdGVkQXR8fCIiKSljYWNoZS5zZXQoci5tb250aCxmcm9tUmVjb3JkKTsKICAgIH0KICAgIHJldHVybiBbLi4uY2FjaGUudmFsdWVzKCldLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7CiAgfQogIGZ1bmN0aW9uIG9zdHJvbVBlcmlvZEF2ZXJhZ2UoaXRlbXMpewogICAgY29uc3QgdmFsaWQ9KEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKS5maWx0ZXIoaXRlbT0+TnVtYmVyLmlzRmluaXRlKGl0ZW0udG90YWxLV2gpJiZpdGVtLnRvdGFsS1doPjAmJk51bWJlci5pc0Zpbml0ZShpdGVtLnZhcmlhYmxlQ29zdEV1cikpOwogICAgaWYoIXZhbGlkLmxlbmd0aClyZXR1cm4ge2F2ZXJhZ2VDdDpudWxsLGVmZmVjdGl2ZUN0Om51bGwsa1doOjAsdmFyaWFibGVDb3N0RXVyOjAsZml4ZWRDb3N0RXVyOjAsdG90YWxDb3N0RXVyOjAsbW9udGhzOjAscGFydGlhbDpmYWxzZX07CiAgICBjb25zdCBrV2g9dmFsaWQucmVkdWNlKChzdW0saXRlbSk9PnN1bStOdW1iZXIoaXRlbS50b3RhbEtXaHx8MCksMCk7CiAgICBjb25zdCB2YXJpYWJsZUNvc3RFdXI9dmFsaWQucmVkdWNlKChzdW0saXRlbSk9PnN1bStOdW1iZXIoaXRlbS52YXJpYWJsZUNvc3RFdXJ8fDApLDApOwogICAgY29uc3QgZml4ZWRDb3N0RXVyPXZhbGlkLnJlZHVjZSgoc3VtLGl0ZW0pPT5zdW0rTnVtYmVyKGl0ZW0uZml4ZWRDb3N0RXVyfHwwKSwwKTsKICAgIGNvbnN0IHRvdGFsQ29zdEV1cj12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtKyhOdW1iZXIuaXNGaW5pdGUoaXRlbS50b3RhbENvc3RFdXIpP051bWJlcihpdGVtLnRvdGFsQ29zdEV1cik6TnVtYmVyKGl0ZW0udmFyaWFibGVDb3N0RXVyfHwwKStOdW1iZXIoaXRlbS5maXhlZENvc3RFdXJ8fDApKSwwKTsKICAgIHJldHVybiB7YXZlcmFnZUN0OmtXaD4wP3ZhcmlhYmxlQ29zdEV1ci9rV2gqMTAwOm51bGwsZWZmZWN0aXZlQ3Q6a1doPjA/dG90YWxDb3N0RXVyL2tXaCoxMDA6bnVsbCxrV2gsdmFyaWFibGVDb3N0RXVyLGZpeGVkQ29zdEV1cix0b3RhbENvc3RFdXIsbW9udGhzOnZhbGlkLmxlbmd0aCxwYXJ0aWFsOnZhbGlkLnNvbWUoaXRlbT0+aXRlbS5wYXJ0aWFsKX07CiAgfQogIGZ1bmN0aW9uIHF1YXJ0ZXJGb3JNb250aChtb250aCl7cmV0dXJuIE1hdGguZmxvb3IoKE51bWJlcihTdHJpbmcobW9udGgpLnNsaWNlKDUsNykpLTEpLzMpKzE7fQogIGZ1bmN0aW9uIHJlbmRlck9zdHJvbVByaWNlU3RhdHMoeWVhcil7CiAgICBpZighJCgnb3N0cm9tUHJpY2VTdGF0c01ldHJpY3MnKSlyZXR1cm47CiAgICBjb25zdCBpdGVtcz1vc3Ryb21TdGF0c0ZvclllYXIoeWVhcik7CiAgICBjb25zdCBjdXJyZW50WWVhcj1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk7CiAgICBjb25zdCBhbm51YWw9b3N0cm9tUGVyaW9kQXZlcmFnZShpdGVtcyk7CiAgICBjb25zdCBjYXJkcz1bW1N0cmluZyh5ZWFyKSxhbm51YWwseWVhcj09PWN1cnJlbnRZZWFyPyJiaXMgaGV1dGUiOiJKYWhyZXN3ZXJ0Il1dOwogICAgZm9yKGxldCBxPTE7cTw9NDtxKyspY2FyZHMucHVzaChbYFEke3F9YCxvc3Ryb21QZXJpb2RBdmVyYWdlKGl0ZW1zLmZpbHRlcihpdGVtPT5xdWFydGVyRm9yTW9udGgoaXRlbS5tb250aCk9PT1xKSksYCR7aXRlbXMuZmlsdGVyKGl0ZW09PnF1YXJ0ZXJGb3JNb250aChpdGVtLm1vbnRoKT09PXEpLmxlbmd0aH0gTW9uYXQoZSlgXSk7CiAgICAkKCdvc3Ryb21QcmljZVN0YXRzTWV0cmljcycpLmlubmVySFRNTD1jYXJkcy5tYXAoKFtsYWJlbCxzdGF0cyxzdWJdKT0+YDxhcnRpY2xlPjxzcGFuPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPjxzdHJvbmc+JHtOdW1iZXIuaXNGaW5pdGUoc3RhdHMuYXZlcmFnZUN0KT9gJHtudW0oc3RhdHMuYXZlcmFnZUN0LDIpfSBjdC9rV2hgOiLigJMifTwvc3Ryb25nPjxzbWFsbD4ke3N0YXRzLm1vbnRocz9gJHtlc2NhcGVIdG1sKHN1Yil9IMK3ICR7bnVtKHN0YXRzLmtXaCwwKX0ga1doJHtOdW1iZXIuaXNGaW5pdGUoc3RhdHMuZWZmZWN0aXZlQ3QpP2AgwrcgaW5rbC4gRml4a29zdGVuICR7bnVtKHN0YXRzLmVmZmVjdGl2ZUN0LDIpfSBjdC9rV2hgOiIifWA6ImtlaW5lIE9zdHJvbS1EYXRlbiJ9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbignJyk7CiAgICBjb25zdCBtb250aE1hcD1uZXcgTWFwKGl0ZW1zLm1hcChpdGVtPT5bTnVtYmVyKGl0ZW0ubW9udGguc2xpY2UoNSw3KSksaXRlbV0pKTsKICAgICQoJ29zdHJvbVByaWNlU3RhdHNUYWJsZScpLmlubmVySFRNTD1BcnJheS5mcm9tKHtsZW5ndGg6MTJ9LChfLGkpPT5pKzEpLm1hcChtPT57CiAgICAgIGNvbnN0IGl0ZW09bW9udGhNYXAuZ2V0KG0pO2lmKCFpdGVtKXJldHVybiBgPHRyPjx0ZD4ke01PTlRIU1ttLTFdfTwvdGQ+PHRkPuKAkzwvdGQ+PHRkPuKAkzwvdGQ+PHRkPuKAkzwvdGQ+PHRkPuKAkzwvdGQ+PC90cj5gOwogICAgICBjb25zdCBlZmZlY3RpdmU9TnVtYmVyKGl0ZW0udG90YWxLV2gpPjAmJk51bWJlci5pc0Zpbml0ZShpdGVtLnRvdGFsQ29zdEV1cik/TnVtYmVyKGl0ZW0udG90YWxDb3N0RXVyKS9OdW1iZXIoaXRlbS50b3RhbEtXaCkqMTAwOm51bGw7CiAgICAgIGNvbnN0IHJ1bm5pbmc9aXRlbS5wYXJ0aWFsfHxpdGVtLm1vbnRoPT09Y3VycmVudE1vbnRoS2V5KCk7CiAgICAgIHJldHVybiBgPHRyPjx0ZD4ke01PTlRIU1ttLTFdfSR7cnVubmluZz8nIDxzbWFsbCBjbGFzcz0icHJpY2UtcnVubmluZyI+bGF1ZmVuZDwvc21hbGw+JzonJ308L3RkPjx0ZD4ke251bShpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doLDIpfSBjdDwvdGQ+PHRkPiR7TnVtYmVyLmlzRmluaXRlKGVmZmVjdGl2ZSk/YCR7bnVtKGVmZmVjdGl2ZSwyKX0gY3RgOiLigJMifTwvdGQ+PHRkPiR7bnVtKGl0ZW0udG90YWxLV2gsMSl9IGtXaDwvdGQ+PHRkPiR7aXRlbS5jb21wbGV0ZT8nT3N0cm9tIGV4YWt0JzondW52b2xsc3TDpG5kaWcnfTwvdGQ+PC90cj5gOwogICAgfSkuam9pbignJyk7CiAgICBjb25zdCBsYXN0PWl0ZW1zLm1hcChpdGVtPT5EYXRlLnBhcnNlKGl0ZW0udXBkYXRlZEF0fHwnJykpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpLnNvcnQoKGEsYik9PmItYSlbMF07CiAgICAkKCdvc3Ryb21QcmljZVN0YXRzU3RhdHVzJykudGV4dENvbnRlbnQ9b3N0cm9tUHJpY2VTdGF0c0J1c3k/J09zdHJvbS1QcmVpc2Ugd2VyZGVuIGdlbGFkZW4g4oCmJzppdGVtcy5sZW5ndGg/YCR7aXRlbXMubGVuZ3RofSBNb25hdChlKSB2ZXJmw7xnYmFyJHtsYXN0P2AgwrcgenVsZXR6dCAke2Zvcm1hdERhdGVUaW1lKGxhc3QpfWA6Jyd9IMK3IFF1YXJ0YWwvSmFociB2ZXJicmF1Y2hzZ2V3aWNodGV0YDpzZXR0aW5ncy5vc3Ryb21BcHBLZXk/J05vY2gga2VpbmUgUHJlaXNzdGF0aXN0aWsgZsO8ciBkaWVzZXMgSmFociBnZWxhZGVuLic6J05vY2gga2VpbmUgUHJlaXNzdGF0aXN0aWsgc3luY2hyb25pc2llcnQuIEF1ZiBlaW5lbSB2ZXJidW5kZW5lbiBHZXLDpHQgbWl0IE9zdHJvbS1TY2hsw7xzc2VsIGFrdHVhbGlzaWVyZW4uJzsKICAgICQoJ3JlZnJlc2hPc3Ryb21QcmljZVN0YXRzQnRuJykuZGlzYWJsZWQ9b3N0cm9tUHJpY2VTdGF0c0J1c3l8fCFzZXR0aW5ncy5vc3Ryb21BcHBLZXk7CiAgICBkcmF3T3N0cm9tQXZlcmFnZVByaWNlQ2hhcnQoeWVhcixpdGVtcyk7CiAgfQogIGZ1bmN0aW9uIGRyYXdPc3Ryb21BdmVyYWdlUHJpY2VDaGFydCh5ZWFyLGl0ZW1zPW9zdHJvbVN0YXRzRm9yWWVhcih5ZWFyKSl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoJ29zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0JykpO2lmKCFjKXJldHVybjtjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsKICAgIGNvbnN0IHZhbHM9aXRlbXMubWFwKGl0ZW09Pk51bWJlcihpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7aWYoIXZhbHMubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCwnS2VpbmUgT3N0cm9tLVByZWlzZGF0ZW4nKTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMpKjEuMTV8fDE7CiAgICBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7CiAgICBjb25zdCBtYXA9bmV3IE1hcChpdGVtcy5tYXAoaXRlbT0+W051bWJlcihpdGVtLm1vbnRoLnNsaWNlKDUsNykpLTEsaXRlbV0pKTtjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLmNvc3Q7Y3R4LmxpbmVXaWR0aD0yLjg7Y3R4LmJlZ2luUGF0aCgpO2xldCBzdGFydGVkPWZhbHNlOwogICAgZm9yKGxldCBtPTA7bTwxMjttKyspe2NvbnN0IGl0ZW09bWFwLmdldChtKTtpZighaXRlbXx8IU51bWJlci5pc0Zpbml0ZShpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSljb250aW51ZTtjb25zdCB4PWZyYW1lLmxlZnQrZnJhbWUucGxvdFcqbS8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1pdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doL21heCk7aWYoIXN0YXJ0ZWQpe2N0eC5tb3ZlVG8oeCx5KTtzdGFydGVkPXRydWU7fWVsc2UgY3R4LmxpbmVUbyh4LHkpO31jdHguc3Ryb2tlKCk7CiAgICBjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O2ZvcihsZXQgbT0wO208MTI7bSsrKXtjb25zdCBpdGVtPW1hcC5nZXQobSk7aWYoIWl0ZW18fCFOdW1iZXIuaXNGaW5pdGUoaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpY29udGludWU7Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKm0vMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaC9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSwzLjIsMCxNYXRoLlBJKjIpO2N0eC5maWxsKCk7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZm9udD0nMTBweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmJztjdHguZmlsbFRleHQobnVtKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gsMSkseC0xMCxNYXRoLm1heCgxMCx5LTgpKTtjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O30KICB9CiAgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE9zdHJvbVByaWNlU3RhdHMoeWVhcix7c2lsZW50PWZhbHNlfT17fSl7CiAgICBpZihvc3Ryb21QcmljZVN0YXRzQnVzeSlyZXR1cm4gZmFsc2U7aWYoIXNldHRpbmdzLm9zdHJvbUFwcEtleSl7aWYoIXNpbGVudCl0b2FzdCgnT3N0cm9tIHp1ZXJzdCB2ZXJiaW5kZW4nKTtyZXR1cm4gZmFsc2U7fQogICAgY29uc3QgeT1OdW1iZXIoeWVhcik7aWYoIU51bWJlci5pc0ludGVnZXIoeSl8fHk8MjAyMHx8eT5uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkpe2lmKCFzaWxlbnQpdG9hc3QoJ1VuZ8O8bHRpZ2VzIEphaHInKTtyZXR1cm4gZmFsc2U7fQogICAgY29uc3Qgbm93PW5ldyBEYXRlKCksbGFzdE1vbnRoPXk9PT1ub3cuZ2V0RnVsbFllYXIoKT9ub3cuZ2V0TW9udGgoKSsxOjEyO29zdHJvbVByaWNlU3RhdHNCdXN5PXRydWU7cmVuZGVyT3N0cm9tUHJpY2VTdGF0cyh5KTsKICAgIGxldCB1cGRhdGVkPTAsdW5hdmFpbGFibGU9MDtjb25zdCByZWNvcmRNYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICB0cnl7CiAgICAgIGZvcihsZXQgbT0xO208PWxhc3RNb250aDttKyspewogICAgICAgIGNvbnN0IG1vbnRoPWAke3l9LSR7U3RyaW5nKG0pLnBhZFN0YXJ0KDIsJzAnKX1gO2lmKCFzaWxlbnQpJCgnb3N0cm9tUHJpY2VTdGF0c1N0YXR1cycpLnRleHRDb250ZW50PWAke21vbnRoTGFiZWwobW9udGgsZmFsc2UpfSB3aXJkIHZvbiBPc3Ryb20gZ2VsYWRlbiDigKYgKCR7bX0vJHtsYXN0TW9udGh9KWA7CiAgICAgICAgdHJ5ewogICAgICAgICAgY29uc3QgZGF0YT1hd2FpdCBvc3Ryb21GZXRjaChgL2FwaS9tb250aD9tb250aD0ke2VuY29kZVVSSUNvbXBvbmVudChtb250aCl9YCk7CiAgICAgICAgICBpZighZGF0YT8uY29tcGxldGV8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKXx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS50b3RhbEtXaCkpfHxOdW1iZXIoZGF0YS50b3RhbEtXaCk8PTB8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEudmFyaWFibGVDb3N0RXVyKSkpe3VuYXZhaWxhYmxlKys7Y29udGludWU7fQogICAgICAgICAgY29uc3QgcGFydGlhbD1tb250aD09PWN1cnJlbnRNb250aEtleSgpO3Vwc2VydE9zdHJvbVByaWNlU3RhdChtb250aCxkYXRhLHtwYXJ0aWFsfSk7dXBkYXRlZCsrOwogICAgICAgICAgaWYoIXBhcnRpYWwmJnJlY29yZE1hcC5oYXMobW9udGgpKXtjb25zdCBpdGVtPXJlY29yZE1hcC5nZXQobW9udGgpLHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtpdGVtLnByaWNlQ3Q9TnVtYmVyKGRhdGEud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpO2l0ZW0uYmFzZUZlZT1OdW1iZXIoZGF0YS5maXhlZENvc3RFdXIpfHwwO2l0ZW0ub3N0cm9tVmFyaWFibGVDb3N0RXVyPU51bWJlcihkYXRhLnZhcmlhYmxlQ29zdEV1cik7aXRlbS5vc3Ryb21Ub3RhbENvc3RFdXI9TnVtYmVyKGRhdGEudG90YWxDb3N0RXVyKTtpdGVtLm9zdHJvbUNvbnN1bXB0aW9uS1doPU51bWJlcihkYXRhLnRvdGFsS1doKTtpdGVtLm9zdHJvbVByaWNlQ29tcGxldGU9dHJ1ZTtpdGVtLnByaWNlU291cmNlPSdvc3Ryb20taG91cmx5LWNvbnN1bXB0aW9uLXdlaWdodGVkJztpdGVtLnByaWNlVXBkYXRlZEF0PXN0YW1wO2l0ZW0udXBkYXRlZEF0PXN0YW1wO3JlY29yZE1hcC5zZXQobW9udGgsaXRlbSk7fQogICAgICAgIH1jYXRjaHt1bmF2YWlsYWJsZSsrO30KICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlPT5zZXRUaW1lb3V0KHJlc29sdmUsMTQwKSk7CiAgICAgIH0KICAgICAgaWYodXBkYXRlZClzYXZlUmVjb3JkcyhbLi4ucmVjb3JkTWFwLnZhbHVlcygpXSx7cmVhc29uOmBPc3Ryb20tUHJlaXNzdGF0aXN0aWsgJHt5fSBha3R1YWxpc2llcnRgfSk7CiAgICAgIHJlbmRlckFsbCgpO2lmKCFzaWxlbnQpdG9hc3QoYCR7dXBkYXRlZH0gT3N0cm9tLU1vbmF0KGUpIGbDvHIgJHt5fSBha3R1YWxpc2llcnQke3VuYXZhaWxhYmxlP2AgwrcgJHt1bmF2YWlsYWJsZX0gbmljaHQgdmVyZsO8Z2JhcmA6Jyd9YCk7cmV0dXJuIHVwZGF0ZWQ+MDsKICAgIH1maW5hbGx5e29zdHJvbVByaWNlU3RhdHNCdXN5PWZhbHNlO3JlbmRlck9zdHJvbVByaWNlU3RhdHMoeSk7fQogIH0KICBmdW5jdGlvbiBhbm51YWxTdW1zKHJvd3MpewogICAgcmV0dXJuIHJvd3MucmVkdWNlKChhLHIpPT57IGlmKE51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSlhLnRvdGFsKz1yLnRvdGFsOyBpZihOdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCkpYS5oZWF0Kz1yLmhlYXRQdW1wOyBpZihOdW1iZXIuaXNGaW5pdGUoci5hbm5leCkpYS5hbm5leCs9ci5hbm5leDsgY29uc3QgcmVzdD1kZXJpdmVkKHIpOyBpZihOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q+PTApYS5yZXN0Kz1yZXN0OyBjb25zdCBjb3N0PXJlY29yZENvc3Qocik7IGlmKE51bWJlci5pc0Zpbml0ZShjb3N0KSlhLmNvc3QrPWNvc3Q7IGlmKE51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSlhLmNvdW50Kys7IHJldHVybiBhOyB9LHt0b3RhbDowLGhlYXQ6MCxhbm5leDowLHJlc3Q6MCxjb3N0OjAsY291bnQ6MH0pOwogIH0KICBmdW5jdGlvbiByZW5kZXJBbmFseXNpcygpewogICAgY29uc3QgeXM9eWVhcnMoKTsKICAgIGNvbnN0IHllYXJTZWxlY3Q9JCgiYW5hbHlzaXNZZWFyIik7CiAgICBjb25zdCBwcmlvcj1OdW1iZXIoeWVhclNlbGVjdC52YWx1ZSk7CiAgICBjb25zdCBzZWxlY3RlZD15cy5pbmNsdWRlcyhwcmlvcik/cHJpb3I6KHlzWzBdfHxuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkpOwogICAgeWVhclNlbGVjdC5pbm5lckhUTUw9KHlzLmxlbmd0aD95czpbbmV3IERhdGUoKS5nZXRGdWxsWWVhcigpXSkubWFwKHk9PmA8b3B0aW9uIHZhbHVlPSIke3l9Ij4ke3l9PC9vcHRpb24+YCkuam9pbigiIik7CiAgICB5ZWFyU2VsZWN0LnZhbHVlPVN0cmluZyhzZWxlY3RlZCk7CiAgICBjb25zdCByb3dzPWFuYWx5c2lzWWVhclJvd3Moc2VsZWN0ZWQpLCBzdW1zPWFubnVhbFN1bXMocm93cyk7CiAgICBjb25zdCBwcmV2aW91c1llYXI9eXMuZmlsdGVyKHk9Pnk8c2VsZWN0ZWQpLnNvcnQoKGEsYik9PmItYSlbMF18fG51bGw7CiAgICBjb25zdCBwcmV2aW91c1Jvd3M9cHJldmlvdXNZZWFyP2FuYWx5c2lzWWVhclJvd3MocHJldmlvdXNZZWFyKTpbXTsKICAgIGNvbnN0IHByZXZpb3VzPWFubnVhbFN1bXMocHJldmlvdXNSb3dzKTsKICAgIGNvbnN0IHRvdGFsRGVsdGE9cHJldmlvdXMuY291bnQmJnByZXZpb3VzLnRvdGFsPygoc3Vtcy50b3RhbC1wcmV2aW91cy50b3RhbCkvcHJldmlvdXMudG90YWwqMTAwKTpudWxsOwogICAgY29uc3QgY29wUm93cz1yb3dzLm1hcChyZWNvcmRDb3ApLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpOwogICAgY29uc3QgYW5udWFsQ29wPXJvd3MucmVkdWNlKChhLHIpPT57IGlmKE51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSYmTnVtYmVyLmlzRmluaXRlKHIuaGVhdEdlbmVyYXRlZCkpe2EuZSs9ci5oZWF0UHVtcDthLmgrPXIuaGVhdEdlbmVyYXRlZDt9IHJldHVybiBhO30se2U6MCxoOjB9KTsKICAgIGNvbnN0IGV4YWN0UHJpY2VNb250aHM9cm93cy5maWx0ZXIocj0+ci5vc3Ryb21QcmljZUNvbXBsZXRlJiZOdW1iZXIuaXNGaW5pdGUoci5vc3Ryb21Ub3RhbENvc3RFdXIpKS5sZW5ndGg7CiAgICBjb25zdCBtZXRyaWNzPVsKICAgICAgWyJHZXNhbXQiLGAke251bShzdW1zLnRvdGFsLDApfSBrV2hgLE51bWJlci5pc0Zpbml0ZSh0b3RhbERlbHRhKT9gJHtwY3QodG90YWxEZWx0YSl9IHp1ICR7cHJldmlvdXNZZWFyfWA6YCR7c3Vtcy5jb3VudH0gTW9uYXRlYF0sCiAgICAgIFsiV8Okcm1lcHVtcGUiLGAke251bShzdW1zLmhlYXQsMCl9IGtXaGAsc3Vtcy50b3RhbD9gJHtudW0oc3Vtcy5oZWF0L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiQWx0ZW50ZWlsIixgJHtudW0oc3Vtcy5hbm5leCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLmFubmV4L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiU2NobGVlL0tsdXMiLGAke251bShzdW1zLnJlc3QsMCl9IGtXaGAsc3Vtcy50b3RhbD9gJHtudW0oc3Vtcy5yZXN0L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiS29zdGVuIixldXJvKHN1bXMuY29zdCksZXhhY3RQcmljZU1vbnRocz9gJHtleGFjdFByaWNlTW9udGhzfSBNb25hdChlKSBtaXQgT3N0cm9tLVN0dW5kZW5wcmVpc2VuYDphbm51YWxDb3AuZT4wP2BXUC1BcmJlaXRzemFobCAke251bShhbm51YWxDb3AuaC9hbm51YWxDb3AuZSwyKX1gOiJGYWxsYmFjay1QcmVpc2UiXQogICAgXTsKICAgICQoImFuYWx5c2lzTWV0cmljcyIpLmlubmVySFRNTD1tZXRyaWNzLm1hcCgoW2wsdixzXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2x9PC9zcGFuPjxzdHJvbmc+JHt2fTwvc3Ryb25nPjxzbWFsbD4ke3N9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbigiIik7CiAgICAkKCJhbmFseXNpc1RhYmxlIikuaW5uZXJIVE1MPXJvd3MubGVuZ3RoP3Jvd3MubWFwKHI9PmA8dHI+PHRkPiR7ZXNjYXBlSHRtbChtb250aExhYmVsKHIubW9udGgsZmFsc2UpKX08L3RkPjx0ZD4ke251bShyLnRvdGFsLDEpfTwvdGQ+PHRkPiR7bnVtKHIuaGVhdFB1bXAsMSl9PC90ZD48dGQ+JHtudW0oci5hbm5leCwxKX08L3RkPjx0ZD4ke251bShkZXJpdmVkKHIpLDEpfTwvdGQ+PHRkPiR7ZXVybyhyZWNvcmRDb3N0KHIpKX0ke3Iub3N0cm9tUHJpY2VDb21wbGV0ZT8iICoiOiIifTwvdGQ+PC90cj5gKS5qb2luKCIiKTonPHRyPjx0ZCBjb2xzcGFuPSI2Ij5LZWluZSBNb25hdHNkYXRlbiBmw7xyIGRpZXNlcyBKYWhyLjwvdGQ+PC90cj4nOwogICAgJCgiY29wUGFuZWwiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFjb3BSb3dzLmxlbmd0aCk7CiAgICByZW5kZXJPc3Ryb21QcmljZVN0YXRzKHNlbGVjdGVkKTsKICAgIHJlbmRlckNsaW1hdGVBbmFseXNpcygpOwogICAgZHJhd0FsbG9jYXRpb25DaGFydChyb3dzKTsgZHJhd1RvdGFsQ2hhcnRBbGxZZWFycyh5cyk7IGRyYXdDb3N0Q2hhcnQocm93cyk7IGlmKGNvcFJvd3MubGVuZ3RoKWRyYXdDb3BDaGFydChyb3dzKTsKICB9CgogIGZ1bmN0aW9uIGNhbnZhc1NldHVwKGNhbnZhcyl7CiAgICBpZighY2FudmFzKXJldHVybiBudWxsOwogICAgY29uc3QgcmVjdD1jYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7IGNvbnN0IGRwcj1NYXRoLm1pbih3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpb3x8MSwyKTsgY29uc3Qgd2lkdGg9TWF0aC5tYXgoMjgwLE1hdGgucm91bmQocmVjdC53aWR0aHx8NjAwKSk7IGNvbnN0IGhlaWdodD1NYXRoLm1heCgxODAsTWF0aC5yb3VuZChyZWN0LmhlaWdodHx8MjYwKSk7CiAgICBjYW52YXMud2lkdGg9TWF0aC5yb3VuZCh3aWR0aCpkcHIpOyBjYW52YXMuaGVpZ2h0PU1hdGgucm91bmQoaGVpZ2h0KmRwcik7IGNvbnN0IGN0eD1jYW52YXMuZ2V0Q29udGV4dCgiMmQiKTsgY3R4LnNldFRyYW5zZm9ybShkcHIsMCwwLGRwciwwLDApOyBjdHguY2xlYXJSZWN0KDAsMCx3aWR0aCxoZWlnaHQpOyByZXR1cm4ge2N0eCx3aWR0aCxoZWlnaHR9OwogIH0KICBmdW5jdGlvbiBkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCx0ZXh0PSJLZWluZSBEYXRlbiIpewogICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDsgY3R4LmZvbnQ9IjEzcHggLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsU2Vnb2UgVUksc2Fucy1zZXJpZiI7IGN0eC50ZXh0QWxpZ249ImNlbnRlciI7IGN0eC5maWxsVGV4dCh0ZXh0LHdpZHRoLzIsaGVpZ2h0LzIpOyBjdHgudGV4dEFsaWduPSJsZWZ0IjsKICB9CiAgZnVuY3Rpb24gY2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxsYWJlbHMse2xlZnQ9NDgsYm90dG9tPTM0LHRvcD0xNSxyaWdodD0xMn09e30pewogICAgY29uc3QgcGxvdFc9d2lkdGgtbGVmdC1yaWdodCwgcGxvdEg9aGVpZ2h0LXRvcC1ib3R0b207CiAgICBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLmdyaWQ7IGN0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7IGN0eC5mb250PSIxMHB4IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LFNlZ29lIFVJLHNhbnMtc2VyaWYiOyBjdHgubGluZVdpZHRoPTE7CiAgICBmb3IobGV0IGk9MDtpPD00O2krKyl7IGNvbnN0IHk9dG9wK3Bsb3RIKmkvNDsgY3R4LmJlZ2luUGF0aCgpO2N0eC5tb3ZlVG8obGVmdCx5KTtjdHgubGluZVRvKHdpZHRoLXJpZ2h0LHkpO2N0eC5zdHJva2UoKTsgY29uc3QgdmFsPW1heCooMS1pLzQpO2N0eC5maWxsVGV4dChudW0odmFsLDApLDQseSszKTsgfQogICAgaWYobGFiZWxzPy5sZW5ndGgpeyBsYWJlbHMuZm9yRWFjaCgobGFiZWwsaSk9PnsgY29uc3QgeD1sZWZ0KyhsYWJlbHMubGVuZ3RoPT09MT9wbG90Vy8yOnBsb3RXKmkvKGxhYmVscy5sZW5ndGgtMSkpOyBjdHguZmlsbFRleHQobGFiZWwseC0xMCxoZWlnaHQtMTApOyB9KTsgfQogICAgcmV0dXJuIHtsZWZ0LHJpZ2h0LHRvcCxib3R0b20scGxvdFcscGxvdEh9OwogIH0KICBmdW5jdGlvbiBkcmF3RGFzaGJvYXJkQ29uc3VtcHRpb24oKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiZGFzaGJvYXJkQ29uc3VtcHRpb25DaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3Qgcm93cz1zb3J0ZWQoKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKS5zbGljZSgtMTIpOyBpZighcm93cy5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLnJvd3MubWFwKHI9PnIudG90YWwpKSoxLjEyfHwxOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LHJvd3MubWFwKHI9Pk1PTlRIU1tOdW1iZXIoci5tb250aC5zbGljZSg1LDcpKS0xXSkse30pOwogICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy50b3RhbDtjdHgubGluZVdpZHRoPTIuNTtjdHguYmVnaW5QYXRoKCk7cm93cy5mb3JFYWNoKChyLGkpPT57Y29uc3QgeD1mcmFtZS5sZWZ0Kyhyb3dzLmxlbmd0aD09PTE/ZnJhbWUucGxvdFcvMjpmcmFtZS5wbG90VyppLyhyb3dzLmxlbmd0aC0xKSk7Y29uc3QgeT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtci50b3RhbC9tYXgpO2k/Y3R4LmxpbmVUbyh4LHkpOmN0eC5tb3ZlVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgICBjdHguZmlsbFN0eWxlPUNPTE9SUy50b3RhbDtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PWZyYW1lLmxlZnQrKHJvd3MubGVuZ3RoPT09MT9mcmFtZS5wbG90Vy8yOmZyYW1lLnBsb3RXKmkvKHJvd3MubGVuZ3RoLTEpKTtjb25zdCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1yLnRvdGFsL21heCk7Y3R4LmJlZ2luUGF0aCgpO2N0eC5hcmMoeCx5LDMsMCxNYXRoLlBJKjIpO2N0eC5maWxsKCk7fSk7CiAgfQogIGZ1bmN0aW9uIGRyYXdBbGxvY2F0aW9uQ2hhcnQocm93cyl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoImFsbG9jYXRpb25DaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgdmFsaWQ9cm93cy5maWx0ZXIocj0+W3IuaGVhdFB1bXAsci5hbm5leCxyLnRvdGFsXS5zb21lKE51bWJlci5pc0Zpbml0ZSkpOyBpZighdmFsaWQubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCk7cmV0dXJuO30KICAgIGNvbnN0IG1heD1NYXRoLm1heCguLi52YWxpZC5tYXAocj0+TWF0aC5tYXgoMCxOdW1iZXIoci50b3RhbCl8fCgoTnVtYmVyKHIuaGVhdFB1bXApfHwwKSsoTnVtYmVyKHIuYW5uZXgpfHwwKSsoTWF0aC5tYXgoMCxkZXJpdmVkKHIpKXx8MCkpKSkpKjEuMXx8MTsgY29uc3QgbGFiZWxzPXZhbGlkLm1hcChyPT5NT05USFNbTnVtYmVyKHIubW9udGguc2xpY2UoNSw3KSktMV0pOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LGxhYmVscyx7fSk7IGNvbnN0IHNsb3Q9ZnJhbWUucGxvdFcvdmFsaWQubGVuZ3RoLCBiYXJXPU1hdGgubWluKDM4LHNsb3QqLjYyKTsKICAgIHZhbGlkLmZvckVhY2goKHIsaSk9PnsgY29uc3QgeD1mcmFtZS5sZWZ0K3Nsb3QqaSsoc2xvdC1iYXJXKS8yOyBsZXQgeT1mcmFtZS50b3ArZnJhbWUucGxvdEg7IGNvbnN0IHBhcnRzPVtbTWF0aC5tYXgoMCxOdW1iZXIoci5oZWF0UHVtcCl8fDApLENPTE9SUy5oZWF0XSxbTWF0aC5tYXgoMCxOdW1iZXIoci5hbm5leCl8fDApLENPTE9SUy5hbm5leF0sW01hdGgubWF4KDAsZGVyaXZlZChyKXx8MCksQ09MT1JTLnJlc3RdXTsgZm9yKGNvbnN0IFt2LGNvbG9yXSBvZiBwYXJ0cyl7Y29uc3QgaD1mcmFtZS5wbG90SCp2L21heDt5LT1oO2N0eC5maWxsU3R5bGU9Y29sb3I7Y3R4LmZpbGxSZWN0KHgseSxiYXJXLGgpO30gfSk7CiAgfQogIGZ1bmN0aW9uIHllYXJDb2xvcih5ZWFyLHllYXJzQXNjKXsKICAgIGNvbnN0IGluZGV4PU1hdGgubWF4KDAseWVhcnNBc2MuaW5kZXhPZih5ZWFyKSk7CiAgICByZXR1cm4gWUVBUl9DT0xPUlNbaW5kZXglWUVBUl9DT0xPUlMubGVuZ3RoXTsKICB9CiAgZnVuY3Rpb24gZHJhd1RvdGFsQ2hhcnRBbGxZZWFycyh5ZWFyTGlzdCl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoInRvdGFsQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsKICAgIGNvbnN0IHllYXJzQXNjPVsuLi55ZWFyTGlzdF0uc29ydCgoYSxiKT0+YS1iKTsKICAgIGNvbnN0IHNlcmllcz15ZWFyc0FzYy5tYXAoeWVhcj0+KHt5ZWFyLHJvd3M6YW5hbHlzaXNZZWFyUm93cyh5ZWFyKX0pKS5maWx0ZXIocz0+cy5yb3dzLnNvbWUocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKSk7CiAgICBjb25zdCB2YWxzPXNlcmllcy5mbGF0TWFwKHM9PnMucm93cykuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSk7CiAgICBpZighdmFscy5sZW5ndGgpe2RyYXdFbXB0eShjLmN0eCxjLndpZHRoLGMuaGVpZ2h0KTskKCJ5ZWFyQ29tcGFyaXNvbkxlZ2VuZCIpLmlubmVySFRNTD0iIjtyZXR1cm47fQogICAgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IG1heD1NYXRoLm1heCguLi52YWxzLm1hcChyPT5yLnRvdGFsKSkqMS4xMnx8MTsgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxNT05USFMse30pOwogICAgY29uc3QgY3VycmVudFllYXI9bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpOwogICAgJCgieWVhckNvbXBhcmlzb25MZWdlbmQiKS5pbm5lckhUTUw9c2VyaWVzLm1hcChpdGVtPT57Y29uc3QgY29sb3I9eWVhckNvbG9yKGl0ZW0ueWVhcix5ZWFyc0FzYyk7Y29uc3QgcGFzdD1pdGVtLnllYXIhPT1jdXJyZW50WWVhcjtyZXR1cm4gYDxzcGFuIGNsYXNzPSIke3Bhc3Q/InBhc3QiOiJjdXJyZW50In0iIHN0eWxlPSJjb2xvcjoke2NvbG9yfSI+PGk+PC9pPiR7aXRlbS55ZWFyfSR7cGFzdD8iIjoiIMK3IGFrdHVlbGwifTwvc3Bhbj5gO30pLmpvaW4oIiIpOwogICAgZm9yKGNvbnN0IGl0ZW0gb2Ygc2VyaWVzKXsKICAgICAgY29uc3QgY29sb3I9eWVhckNvbG9yKGl0ZW0ueWVhcix5ZWFyc0FzYyksZGFzaGVkPWl0ZW0ueWVhciE9PWN1cnJlbnRZZWFyOwogICAgICBjb25zdCBtYXA9bmV3IE1hcChpdGVtLnJvd3MuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkubWFwKHI9PltOdW1iZXIoci5tb250aC5zbGljZSg1LDcpKS0xLHIudG90YWxdKSk7CiAgICAgIGN0eC5zdHJva2VTdHlsZT1jb2xvcjtjdHgubGluZVdpZHRoPWRhc2hlZD8yLjI6MztjdHguc2V0TGluZURhc2goZGFzaGVkP1s3LDVdOltdKTtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7CiAgICAgIGZvcihsZXQgbT0wO208MTI7bSsrKXtpZighbWFwLmhhcyhtKSljb250aW51ZTtjb25zdCB4PWZyYW1lLmxlZnQrZnJhbWUucGxvdFcqbS8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1tYXAuZ2V0KG0pL21heCk7aWYoIXN0YXJ0ZWQpe2N0eC5tb3ZlVG8oeCx5KTtzdGFydGVkPXRydWU7fWVsc2UgY3R4LmxpbmVUbyh4LHkpO30KICAgICAgY3R4LnN0cm9rZSgpO2N0eC5zZXRMaW5lRGFzaChbXSk7CiAgICAgIGN0eC5maWxsU3R5bGU9Y29sb3I7Zm9yKGxldCBtPTA7bTwxMjttKyspe2lmKCFtYXAuaGFzKG0pKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLW1hcC5nZXQobSkvbWF4KTtjdHguYmVnaW5QYXRoKCk7Y3R4LmFyYyh4LHksZGFzaGVkPzIuMjozLjIsMCxNYXRoLlBJKjIpO2N0eC5maWxsKCk7fQogICAgfQogIH0KCiAgZnVuY3Rpb24gZHJhd0Nvc3RDaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiY29zdENoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxzPXJvd3MubWFwKHI9PnJlY29yZENvc3QocikpOyBpZighdmFscy5zb21lKE51bWJlci5pc0Zpbml0ZSkpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LCJLZWluZSBLb3N0ZW5kYXRlbiIpO3JldHVybjt9IGNvbnN0IG1heD1NYXRoLm1heCguLi52YWxzLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKSoxLjEyfHwxOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7IGNvbnN0IHNsb3Q9ZnJhbWUucGxvdFcvMTIsYmFyVz1NYXRoLm1pbigzOCxzbG90Ki42Mik7IHZhbHMuZm9yRWFjaCgodixpKT0+e2lmKCFOdW1iZXIuaXNGaW5pdGUodikpcmV0dXJuO2NvbnN0IGg9ZnJhbWUucGxvdEgqdi9tYXgseD1mcmFtZS5sZWZ0K3Nsb3QqaSsoc2xvdC1iYXJXKS8yLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RILWg7Y3R4LmZpbGxTdHlsZT1DT0xPUlMuY29zdDtjdHguZmlsbFJlY3QoeCx5LGJhclcsaCk7fSk7CiAgfQogIGZ1bmN0aW9uIGRyYXdDb3BDaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiY29wQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbHM9cm93cy5tYXAocmVjb3JkQ29wKTsgaWYoIXZhbHMuc29tZShOdW1iZXIuaXNGaW5pdGUpKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCk7cmV0dXJuO30gY29uc3QgbWF4PU1hdGgubWF4KDUsLi4udmFscy5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKSkqMS4wNTsgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxNT05USFMse30pOyBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLmhlYXQ7Y3R4LmxpbmVXaWR0aD0yLjQ7Y3R4LmJlZ2luUGF0aCgpO2xldCBzdGFydGVkPWZhbHNlO3ZhbHMuZm9yRWFjaCgodixpKT0+e2lmKCFOdW1iZXIuaXNGaW5pdGUodikpcmV0dXJuO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyppLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXYvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fSk7Y3R4LnN0cm9rZSgpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyTWV0ZXJQYW5lbCgpewogICAgY29uc3QgbGF0ZXN0PWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIWxhdGVzdClyZXR1cm47CiAgICAkKCJtZXRlckxhdGVzdCIpLmlubmVySFRNTD1gPGFydGljbGU+PHNwYW4+U3RhbmQgdm9tPC9zcGFuPjxzdHJvbmc+JHtkYXRlTGFiZWwobGF0ZXN0LmRhdGUpfTwvc3Ryb25nPjxzbWFsbD5sZXR6dGUgQWJsZXN1bmc8L3NtYWxsPjwvYXJ0aWNsZT48YXJ0aWNsZT48c3Bhbj5HZXNhbXQ8L3NwYW4+PHN0cm9uZz4ke251bShsYXRlc3QudG90YWwsMCl9IGtXaDwvc3Ryb25nPjxzbWFsbD5aw6RobGVyc3RhbmQ8L3NtYWxsPjwvYXJ0aWNsZT48YXJ0aWNsZT48c3Bhbj5BbHRlbnRlaWw8L3NwYW4+PHN0cm9uZz4ke251bShsYXRlc3QuYW5uZXgsMCl9IGtXaDwvc3Ryb25nPjxzbWFsbD5aw6RobGVyc3RhbmQ8L3NtYWxsPjwvYXJ0aWNsZT5gOwogICAgJCgibWV0ZXJIaXN0b3J5IikuaW5uZXJIVE1MPW1ldGVyUmVhZGluZ3Muc2xpY2UoKS5yZXZlcnNlKCkuc2xpY2UoMCw4KS5tYXAoKHIsaSk9PmA8ZGl2IGNsYXNzPSJtZXRlci1oaXN0b3J5LXJvdyI+PHNwYW4+JHtkYXRlTGFiZWwoci5kYXRlKX08L3NwYW4+PHN0cm9uZz5HZXNhbXQgJHtudW0oci50b3RhbCwwKX08L3N0cm9uZz48c3Ryb25nPkFsdGVudGVpbCAke251bShyLmFubmV4LDApfTwvc3Ryb25nPiR7aT09PW1ldGVyUmVhZGluZ3MubGVuZ3RoLTE/JzxzbWFsbD5TdGFydHdlcnQ8L3NtYWxsPic6Jyd9PC9kaXY+YCkuam9pbigiIik7CiAgICAkKCJ1bmRvTGF0ZXN0TWV0ZXJCdG4iKS5kaXNhYmxlZD1tZXRlclJlYWRpbmdzLmxlbmd0aDw9MTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyRGF0YSgpewogICAgY29uc3QgaXNzdWVzPVtdOyBsZXQgY29tcGxldGVDb3VudD0wOwogICAgZm9yKGNvbnN0IHIgb2YgcmVjb3Jkcyl7CiAgICAgIGNvbnN0IG1pc3Npbmc9W107IGlmKCFOdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpbWlzc2luZy5wdXNoKCJHZXNhbXQiKTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSltaXNzaW5nLnB1c2goIlfDpHJtZXB1bXBlIik7IGlmKCFOdW1iZXIuaXNGaW5pdGUoci5hbm5leCkpbWlzc2luZy5wdXNoKCJBbHRlbnRlaWwiKTsgY29uc3QgcmVzdD1kZXJpdmVkKHIpOwogICAgICBpZihOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8MClpc3N1ZXMucHVzaCh7bGV2ZWw6ImVycm9yIixtb250aDpyLm1vbnRoLHRpdGxlOiJBdWZ0ZWlsdW5nIHVucGxhdXNpYmVsIixkZXRhaWw6YFNjaGxlZS9LbHVzIGVyZ2lidCAke251bShyZXN0LDEpfSBrV2guYH0pOwogICAgICBlbHNlIGlmKG1pc3NpbmcubGVuZ3RoKWlzc3Vlcy5wdXNoKHtsZXZlbDoid2FybmluZyIsbW9udGg6ci5tb250aCx0aXRsZToiTW9uYXQgdW52b2xsc3TDpG5kaWciLGRldGFpbDpgRmVobHQ6ICR7bWlzc2luZy5qb2luKCIsICIpfWB9KTsKICAgICAgZWxzZSBjb21wbGV0ZUNvdW50Kys7CiAgICB9CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0UmVjb3JkKCk7CiAgICBjb25zdCBxPVsKICAgICAgWyJNb25hdGUiLFN0cmluZyhyZWNvcmRzLmxlbmd0aCksImdlc3BlaWNoZXJ0Il0sCiAgICAgIFsiVm9sbHN0w6RuZGlnIixTdHJpbmcoY29tcGxldGVDb3VudCkscmVjb3Jkcy5sZW5ndGg/YCR7bnVtKGNvbXBsZXRlQ291bnQvcmVjb3Jkcy5sZW5ndGgqMTAwLDApfSAlYDoi4oCTIl0sCiAgICAgIFsiSGlud2Vpc2UiLFN0cmluZyhpc3N1ZXMubGVuZ3RoKSxpc3N1ZXMuc29tZShpPT5pLmxldmVsPT09ImVycm9yIik/Im1pbmQuIDEgRmVobGVyIjoicHLDvGZlbiJdLAogICAgICBbIkxldHp0ZXIgTW9uYXQiLGxhdGVzdD9tb250aExhYmVsKGxhdGVzdC5tb250aCxmYWxzZSk6IuKAkyIsImF1dG9tYXRpc2NoIGJlcmVjaG5ldCJdCiAgICBdOwogICAgJCgicXVhbGl0eU1ldHJpY3MiKS5pbm5lckhUTUw9cS5tYXAoKFtsLHYsc10pPT5gPGFydGljbGU+PHNwYW4+JHtsfTwvc3Bhbj48c3Ryb25nPiR7dn08L3N0cm9uZz48c21hbGw+JHtzfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgJCgicXVhbGl0eUlzc3VlcyIpLmlubmVySFRNTD1pc3N1ZXMubGVuZ3RoP2lzc3Vlcy5zbGljZSgpLnJldmVyc2UoKS5zbGljZSgwLDE2KS5tYXAoaT0+YDxhcnRpY2xlIGNsYXNzPSJpc3N1ZSAke2kubGV2ZWx9Ij48ZGl2PjxzdHJvbmc+JHtlc2NhcGVIdG1sKG1vbnRoTGFiZWwoaS5tb250aCkpfTogJHtlc2NhcGVIdG1sKGkudGl0bGUpfTwvc3Ryb25nPjxzbWFsbD4ke2VzY2FwZUh0bWwoaS5kZXRhaWwpfTwvc21hbGw+PC9kaXY+PC9hcnRpY2xlPmApLmpvaW4oIiIpOic8YXJ0aWNsZSBjbGFzcz0iaXNzdWUiPjxkaXY+PHN0cm9uZz5LZWluZSBBdWZmw6RsbGlna2VpdGVuPC9zdHJvbmc+PHNtYWxsPkFsbGUgZ2VzcGVpY2hlcnRlbiBNb25hdGUgc2luZCBwbGF1c2liZWwgdW5kIHZvbGxzdMOkbmRpZy48L3NtYWxsPjwvZGl2PjwvYXJ0aWNsZT4nOwogICAgcmVuZGVyTWV0ZXJQYW5lbCgpOwogICAgJCgib3N0cm9tQXBwS2V5SW5wdXQiKS52YWx1ZT1zZXR0aW5ncy5vc3Ryb21BcHBLZXl8fCIiOwogICAgJCgib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIpLmNoZWNrZWQ9c2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2ghPT1mYWxzZTsKICAgICQoInByZWZlcnJlZFdpbmRvd0hvdXJzSW5wdXQiKS52YWx1ZT1TdHJpbmcoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnN8fDMpOwogICAgJCgiZmFsbGJhY2tQcmljZUlucHV0IikudmFsdWU9TnVtYmVyKHNldHRpbmdzLmZhbGxiYWNrUHJpY2V8fDAuMzIpLnRvRml4ZWQoMyk7CiAgICAkKCJkZWZhdWx0QmFzZUZlZUlucHV0IikudmFsdWU9TnVtYmVyKHNldHRpbmdzLmRlZmF1bHRCYXNlRmVlfHwwKS50b0ZpeGVkKDIpOwogICAgY29uc3QgbGFzdEJhY2t1cD1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShMQVNUX0JBQ0tVUF9LRVkpOyAkKCJiYWNrdXBTdGF0dXMiKS50ZXh0Q29udGVudD1sYXN0QmFja3VwP2BMZXR6dGVzIEJhY2t1cDogJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtkYXRlU3R5bGU6Im1lZGl1bSIsdGltZVN0eWxlOiJzaG9ydCJ9KS5mb3JtYXQobmV3IERhdGUobGFzdEJhY2t1cCkpfWA6Ik5vY2gga2VpbiBCYWNrdXAgbWl0IEVsZGVob2YgNi4yIGVyc3RlbGx0LiI7CiAgICBjb25zdCBoaXN0b3J5U3RhdHVzPXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oT1NUUk9NX0hJU1RPUllfS0VZKSxudWxsKTsKICAgIGlmKCQoIm9zdHJvbUhpc3RvcnlTdGF0dXMiKSkkKCJvc3Ryb21IaXN0b3J5U3RhdHVzIikudGV4dENvbnRlbnQ9b3N0cm9tSGlzdG9yeUJ1c3k/Ikhpc3RvcmlzY2hlIE9zdHJvbS1QcmVpc2Ugd2VyZGVuIGdlbGFkZW4g4oCmIjpoaXN0b3J5U3RhdHVzPy51cGRhdGVkQXQ/YFByZWlzaGlzdG9yaWUgenVsZXR6dCAke2Zvcm1hdERhdGVUaW1lKGhpc3RvcnlTdGF0dXMudXBkYXRlZEF0KX0gwrcgJHtoaXN0b3J5U3RhdHVzLnVwZGF0ZWR8fDB9IE1vbmF0KGUpIGV4YWt0IMK3ICR7aGlzdG9yeVN0YXR1cy51bmF2YWlsYWJsZXx8MH0gbmljaHQgdmVyZsO8Z2JhcmA6YEhpc3RvcmlzY2hlIFByZWlzZSBub2NoIG5pY2h0IGdlcHLDvGZ0LmA7CiAgICByZW5kZXJTeW5jUGFuZWwoKTsKICB9CgogIGZ1bmN0aW9uIGRvd25sb2FkQmxvYihjb250ZW50LGZpbGVuYW1lLHR5cGUpeyBjb25zdCBibG9iPW5ldyBCbG9iKFtjb250ZW50XSx7dHlwZX0pOyBjb25zdCB1cmw9VVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsgY29uc3QgYT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJhIik7IGEuaHJlZj11cmw7YS5kb3dubG9hZD1maWxlbmFtZTtkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGEpO2EuY2xpY2soKTthLnJlbW92ZSgpO3NldFRpbWVvdXQoKCk9PlVSTC5yZXZva2VPYmplY3RVUkwodXJsKSwxMDAwKTsgfQogIGZ1bmN0aW9uIGV4cG9ydEJhY2t1cCgpewogICAgY29uc3Qgbm93PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIGNvbnN0IHJlbGV2YW50U2V0dGluZ3M9e2ZhbGxiYWNrUHJpY2U6c2V0dGluZ3MuZmFsbGJhY2tQcmljZSxkZWZhdWx0QmFzZUZlZTpzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZSxvc3Ryb21BcHBLZXk6c2V0dGluZ3Mub3N0cm9tQXBwS2V5LG9zdHJvbUF1dG9SZWZyZXNoOnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoLHByZWZlcnJlZFdpbmRvd0hvdXJzOnNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzfTsKICAgIGNvbnN0IHBheWxvYWQ9e3ZlcnNpb246IjYuMy40IixhcHA6IkVsZGVob2YiLHB1cnBvc2U6IlByaXZhdGVzIGxva2FsZXMgQmFja3VwIOKAkyBuaWNodCDDtmZmZW50bGljaCBob2NobGFkZW4iLGV4cG9ydGVkQXQ6bm93LHNldHRpbmdzOnJlbGV2YW50U2V0dGluZ3MscmVjb3Jkcyx2YWlsbGFudE1vbnRocyxtZXRlclJlYWRpbmdzLG9zdHJvbVByaWNlU3RhdHMsY2xpbWF0ZU1vbnRocyxjbGltYXRlV2VhdGhlcn07CiAgICBkb3dubG9hZEJsb2IoSlNPTi5zdHJpbmdpZnkocGF5bG9hZCxudWxsLDIpLGBFbGRlaG9mX1BSSVZBVEVfQmFja3VwXyR7ZGF0ZVN0YW1wKCl9Lmpzb25gLCJhcHBsaWNhdGlvbi9qc29uIik7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKExBU1RfQkFDS1VQX0tFWSxub3cpOyByZW5kZXJEYXRhKCk7IHRvYXN0KCJQcml2YXRlcyBCYWNrdXAgZXJzdGVsbHQiKTsKICB9CiAgZnVuY3Rpb24gZXhwb3J0Q3N2KCl7CiAgICBjb25zdCByb3dzPVtbIk1vbmF0IiwiV8Okcm1lcHVtcGUga1doIiwiRXJ6ZXVndGUgV8Okcm1lIGtXaCIsIkFyYmVpdHN6YWhsIiwiQWx0ZW50ZWlsIGtXaCIsIlNjaGxlZS9LbHVzIGtXaCIsIkdlc2FtdCBrV2giLCJHZXNhbXQtWsOkaGxlcnN0YW5kIGtXaCIsIkFsdGVudGVpbC1aw6RobGVyc3RhbmQga1doIiwiQWJsZXNlZGF0dW0iLCJQcmVpcyBjdC9rV2giLCJGaXhrb3N0ZW4gRVVSIiwiS29zdGVuIEVVUiIsIlByZWlzcXVlbGxlIiwiT3N0cm9tLVZlcmJyYXVjaCBrV2giLCJOb3RpeiJdXTsKICAgIGZvcihjb25zdCByIG9mIHNvcnRlZCgpKXJvd3MucHVzaChbci5tb250aCxyLmhlYXRQdW1wPz8iIixyLmhlYXRHZW5lcmF0ZWQ/PyIiLHJlY29yZENvcChyKT8/IiIsci5hbm5leD8/IiIsZGVyaXZlZChyKT8/IiIsci50b3RhbD8/IiIsci50b3RhbE1ldGVyUmVhZGluZz8/IiIsci5hbm5leE1ldGVyUmVhZGluZz8/IiIsci5tZXRlclJlYWRpbmdEYXRlPz8iIixyLnByaWNlQ3Q/PyIiLHIuYmFzZUZlZT8/IiIscmVjb3JkQ29zdChyKT8/IiIsci5wcmljZVNvdXJjZXx8IiIsci5vc3Ryb21Db25zdW1wdGlvbktXaD8/IiIsci5ub3RlfHwiIl0pOwogICAgZG93bmxvYWRCbG9iKCJcdUZFRkYiK3Jvd3MubWFwKHJvdz0+cm93Lm1hcChjc3ZDZWxsKS5qb2luKCI7IikpLmpvaW4oIlxuIiksYEVsZGVob2ZfVmVyYnJhdWNoXyR7ZGF0ZVN0YW1wKCl9LmNzdmAsInRleHQvY3N2O2NoYXJzZXQ9dXRmLTgiKTsgdG9hc3QoIkNTViBlcnN0ZWxsdCIpOwogIH0KICBhc3luYyBmdW5jdGlvbiBpbXBvcnRCYWNrdXAoZmlsZSl7CiAgICB0cnl7CiAgICAgIGNvbnN0IHBheWxvYWQ9SlNPTi5wYXJzZShhd2FpdCBmaWxlLnRleHQoKSk7IGNvbnN0IGluY29taW5nPUFycmF5LmlzQXJyYXkocGF5bG9hZCk/cGF5bG9hZDooQXJyYXkuaXNBcnJheShwYXlsb2FkLnJlY29yZHMpP3BheWxvYWQucmVjb3JkczpwYXlsb2FkLmRhdGEpOyBpZighQXJyYXkuaXNBcnJheShpbmNvbWluZykpdGhyb3cgbmV3IEVycm9yKCJLZWluZSBNb25hdHNkYXRlbiBnZWZ1bmRlbi4iKTsKICAgICAgY29uc3QgY2xlYW5lZD1zYW5pdGl6ZVJlY29yZHMoaW5jb21pbmcpOyBpZighY2xlYW5lZC5sZW5ndGgmJiFjb25maXJtKCJEYXMgQmFja3VwIGVudGjDpGx0IGtlaW5lIE1vbmF0c3dlcnRlLiBMZWVyZW4gQmVzdGFuZCB3aXJrbGljaCBpbXBvcnRpZXJlbj8iKSlyZXR1cm47CiAgICAgIGlmKCFjb25maXJtKGAke2NsZWFuZWQubGVuZ3RofSBNb25hdHN3ZXJ0ZSBhdXMgZGVtIEJhY2t1cCDDvGJlcm5laG1lbj8gRGVyIGFrdHVlbGxlIFN0YW5kIHdpcmQgdm9yaGVyIGxva2FsIGdlc2ljaGVydC5gKSlyZXR1cm47CiAgICAgIGNvbnN0IGltcG9ydFN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgICAgc2F2ZVJlY29yZHMoY2xlYW5lZC5tYXAocj0+KHsuLi5yLHVwZGF0ZWRBdDppbXBvcnRTdGFtcH0pKSx7cmVhc29uOiJCYWNrdXAgaW1wb3J0aWVydCIsYWxsb3dFbXB0eTp0cnVlfSk7CiAgICAgIGlmKHBheWxvYWQuc2V0dGluZ3MmJnR5cGVvZiBwYXlsb2FkLnNldHRpbmdzPT09Im9iamVjdCIpewogICAgICAgIHNldHRpbmdzPXsuLi5zZXR0aW5ncywuLi5wYXlsb2FkLnNldHRpbmdzfTsKICAgICAgICBpZihOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHBheWxvYWQuc2V0dGluZ3MucHJpY2UpKSYmIU51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5mYWxsYmFja1ByaWNlKSkpc2V0dGluZ3MuZmFsbGJhY2tQcmljZT1OdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5wcmljZSk7CiAgICAgICAgc2F2ZVNldHRpbmdzKCk7CiAgICAgIH0KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLnZhaWxsYW50TW9udGhzKSl7IHZhaWxsYW50TW9udGhzPXBheWxvYWQudmFpbGxhbnRNb250aHMubWFwKHY9Pih7Li4udix1cGRhdGVkQXQ6aW1wb3J0U3RhbXB9KSk7IHNhdmVWYWlsbGFudE1vbnRocygpOyB9CiAgICAgIGlmKEFycmF5LmlzQXJyYXkocGF5bG9hZC5tZXRlclJlYWRpbmdzKSl7c2F2ZU1ldGVyUmVhZGluZ3MocGF5bG9hZC5tZXRlclJlYWRpbmdzKTt9ZWxzZXttZXRlclJlYWRpbmdzPWxvYWRNZXRlclJlYWRpbmdzKCk7ZW5zdXJlTWV0ZXJCYXNlbGluZSgpO30KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLm9zdHJvbVByaWNlU3RhdHMpKXNhdmVPc3Ryb21QcmljZVN0YXRzKHBheWxvYWQub3N0cm9tUHJpY2VTdGF0cyk7CiAgICAgIGlmKEFycmF5LmlzQXJyYXkocGF5bG9hZC5jbGltYXRlTW9udGhzKSlzYXZlQ2xpbWF0ZU1vbnRocyhwYXlsb2FkLmNsaW1hdGVNb250aHMpOwogICAgICBpZihwYXlsb2FkLmNsaW1hdGVXZWF0aGVyJiZ0eXBlb2YgcGF5bG9hZC5jbGltYXRlV2VhdGhlcj09PSJvYmplY3QiJiYhQXJyYXkuaXNBcnJheShwYXlsb2FkLmNsaW1hdGVXZWF0aGVyKSl7Y2xpbWF0ZVdlYXRoZXI9Y2xpbWF0ZVdlYXRoZXJPYmplY3QocGF5bG9hZC5jbGltYXRlV2VhdGhlcik7bG9jYWxTdG9yYWdlLnNldEl0ZW0oQ0xJTUFURV9XRUFUSEVSX0tFWSxKU09OLnN0cmluZ2lmeShjbGltYXRlV2VhdGhlcikpO30KICAgICAgcmVuZGVyQWxsKCk7IHRvYXN0KCJCYWNrdXAgaW1wb3J0aWVydCIpOwogICAgfWNhdGNoKGVycm9yKXsgYWxlcnQoYEJhY2t1cCBrb25udGUgbmljaHQgaW1wb3J0aWVydCB3ZXJkZW46ICR7ZXJyb3IubWVzc2FnZX1gKTsgfQogICAgZmluYWxseXsgJCgiaW1wb3J0QmFja3VwSW5wdXQiKS52YWx1ZT0iIjsgfQogIH0KCgogIC8qIEVsZGVob2YgNi4wLjEg4oCTIHNjaGxhbmtlciBsb2thbGVyIG15VkFJTExBTlQtQ1NWLUltcG9ydCAqLwogIGZ1bmN0aW9uIHZhaWxsYW50Q3N2TnVtYmVyKHZhbHVlKXsKICAgIGNvbnN0IHRleHQ9U3RyaW5nKHZhbHVlPz8iIikudHJpbSgpOwogICAgaWYoIXRleHQpcmV0dXJuIG51bGw7CiAgICBjb25zdCBub3JtYWxpemVkPXRleHQuaW5jbHVkZXMoIiwiKSYmdGV4dC5pbmNsdWRlcygiLiIpCiAgICAgID90ZXh0Lmxhc3RJbmRleE9mKCIsIik+dGV4dC5sYXN0SW5kZXhPZigiLiIpCiAgICAgICAgP3RleHQucmVwbGFjZSgvXC4vZywiIikucmVwbGFjZSgiLCIsIi4iKQogICAgICAgIDp0ZXh0LnJlcGxhY2UoLywvZywiIikKICAgICAgOnRleHQucmVwbGFjZSgiLCIsIi4iKTsKICAgIGNvbnN0IG51bWJlcj1OdW1iZXIobm9ybWFsaXplZCk7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG51bWJlcik/bnVtYmVyOm51bGw7CiAgfQogIGZ1bmN0aW9uIHZhaWxsYW50Q3N2RGF0ZVBhcnRzKHZhbHVlKXsKICAgIGNvbnN0IG1hdGNoPS9eKFxkezR9KS0oXGR7Mn0pLShcZHsyfSkoPzpbIFRdKFxkezJ9KTooXGR7Mn0pOihcZHsyfSkpPyQvLmV4ZWMoU3RyaW5nKHZhbHVlfHwiIikudHJpbSgpKTsKICAgIGlmKCFtYXRjaClyZXR1cm4gbnVsbDsKICAgIGNvbnN0IHllYXI9TnVtYmVyKG1hdGNoWzFdKSxtb250aD1OdW1iZXIobWF0Y2hbMl0pLGRheT1OdW1iZXIobWF0Y2hbM10pOwogICAgY29uc3QgZGF0ZT1uZXcgRGF0ZShEYXRlLlVUQyh5ZWFyLG1vbnRoLTEsZGF5KSk7CiAgICBpZihkYXRlLmdldFVUQ0Z1bGxZZWFyKCkhPT15ZWFyfHxkYXRlLmdldFVUQ01vbnRoKCkhPT1tb250aC0xfHxkYXRlLmdldFVUQ0RhdGUoKSE9PWRheSlyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7eWVhcixtb250aCxkYXksZGF0ZUtleTpgJHttYXRjaFsxXX0tJHttYXRjaFsyXX0tJHttYXRjaFszXX1gLG1vbnRoS2V5OmAke21hdGNoWzFdfS0ke21hdGNoWzJdfWAsZGF0ZVRpbWU6U3RyaW5nKHZhbHVlfHwiIikudHJpbSgpfTsKICB9CiAgZnVuY3Rpb24gZGV0ZWN0VmFpbGxhbnRDc3ZUeXBlKGhlYWRlcnMpewogICAgY29uc3QgZmllbGRzPW5ldyBTZXQoaGVhZGVycyksaGFzPW5hbWU9PmZpZWxkcy5oYXMobmFtZSk7CiAgICBpZihoYXMoIkRhdGVUaW1lIikmJmhhcygiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6RG9tZXN0aWNIb3RXYXRlciIpKXJldHVybiAiYXJvdGhlcm0tZW5lcmd5IjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpJiYhaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpKXJldHVybiAidW5pdG93ZXItZW5lcmd5IjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJPdXRkb29yVGVtcGVyYXR1cmUiKSlyZXR1cm4gInN5c3RlbS10ZW1wZXJhdHVyZSI7CiAgICBpZihoYXMoIkRhdGVUaW1lIikmJmhhcygiQ3VycmVudFJvb21UZW1wZXJhdHVyZSIpKXJldHVybiAiem9uZS10ZW1wZXJhdHVyZSI7CiAgICBpZihoYXMoIkRhdGVUaW1lIikmJmhhcygiRGh3VGFua1RlbXBlcmF0dXJlIikpcmV0dXJuICJkaHctdGVtcGVyYXR1cmUiOwogICAgaWYoaGFzKCJtb250aCIpJiZoYXMoImVsZWN0cmljaXR5S1doIikmJmhhcygiaGVhdGluZ0hlYXRLV2giKSlyZXR1cm4gIm1vbnRobHktZW5lcmd5IjsKICAgIHJldHVybiAidW5rbm93biI7CiAgfQogIGZ1bmN0aW9uIHBhcnNlVmFpbGxhbnRDc3ZUZXh0KHRleHQsaW5kZXg9MCl7CiAgICBjb25zdCBub3JtYWxpemVkPVN0cmluZyh0ZXh0fHwiIikucmVwbGFjZSgvXlx1RkVGRi8sIiIpLnJlcGxhY2UoL1xyXG4/L2csIlxuIik7CiAgICBjb25zdCBleHBvcnRlZEF0PShub3JtYWxpemVkLm1hdGNoKC9leHBvcnRlZCBhdFxzKyhcZHs0fS1cZHsyfS1cZHsyfSlccytcZHsyfTpcZHsyfS9pKXx8W10pWzFdfHxudWxsOwogICAgY29uc3QgZGF0YUxpbmVzPW5vcm1hbGl6ZWQuc3BsaXQoIlxuIikuZmlsdGVyKGxpbmU9Pntjb25zdCB0PWxpbmUudHJpbSgpO3JldHVybiB0JiYhdC5zdGFydHNXaXRoKCIjIik7fSk7CiAgICBpZighZGF0YUxpbmVzLmxlbmd0aClyZXR1cm4ge2luZGV4LHR5cGU6InVua25vd24iLHJvd3M6W10saW52YWxpZFJvd3M6MH07CiAgICBjb25zdCBkZWxpbWl0ZXI9ZGF0YUxpbmVzWzBdLmluY2x1ZGVzKCI7Iik/IjsiOiIsIjsKICAgIGNvbnN0IGhlYWRlcnM9ZGF0YUxpbmVzWzBdLnNwbGl0KGRlbGltaXRlcikubWFwKHY9PnYudHJpbSgpKTsKICAgIGNvbnN0IHR5cGU9ZGV0ZWN0VmFpbGxhbnRDc3ZUeXBlKGhlYWRlcnMpLHJvd3M9W107bGV0IGludmFsaWRSb3dzPTA7CiAgICBpZih0eXBlPT09Im1vbnRobHktZW5lcmd5Iil7CiAgICAgIGZvcihjb25zdCBsaW5lIG9mIGRhdGFMaW5lcy5zbGljZSgxKSl7CiAgICAgICAgY29uc3QgcGFydHM9bGluZS5zcGxpdChkZWxpbWl0ZXIpLHJhdz1PYmplY3QuZnJvbUVudHJpZXMoaGVhZGVycy5tYXAoKGgsaSk9PltoLHBhcnRzW2ldPz8iIl0pKSxtb250aD1TdHJpbmcocmF3Lm1vbnRofHwiIikudHJpbSgpOwogICAgICAgIGlmKCEvXlxkezR9LSgwWzEtOV18MVswLTJdKSQvLnRlc3QobW9udGgpKXtpbnZhbGlkUm93cysrO2NvbnRpbnVlO30KICAgICAgICBjb25zdCB2YWx1ZXM9e307CiAgICAgICAgZm9yKGNvbnN0IGggb2YgaGVhZGVycyl7CiAgICAgICAgICBpZihoPT09Im1vbnRoIiljb250aW51ZTsKICAgICAgICAgIHZhbHVlc1toXT1bImNvbXBsZXRlIiwiZXN0aW1hdGVkIl0uaW5jbHVkZXMoaCk/U3RyaW5nKHJhd1toXSkudHJpbSgpLnRvTG93ZXJDYXNlKCk9PT0idHJ1ZSI6dmFpbGxhbnRDc3ZOdW1iZXIocmF3W2hdKTsKICAgICAgICB9CiAgICAgICAgcm93cy5wdXNoKHttb250aEtleTptb250aCx2YWx1ZXN9KTsKICAgICAgfQogICAgICByZXR1cm4ge2luZGV4LHR5cGUsaGVhZGVycyxyb3dzLGludmFsaWRSb3dzLGV4cG9ydGVkQXR9OwogICAgfQogICAgZm9yKGNvbnN0IGxpbmUgb2YgZGF0YUxpbmVzLnNsaWNlKDEpKXsKICAgICAgaWYoIWxpbmUudHJpbSgpKWNvbnRpbnVlOwogICAgICBjb25zdCB2YWx1ZXM9bGluZS5zcGxpdChkZWxpbWl0ZXIpOwogICAgICBjb25zdCByYXc9T2JqZWN0LmZyb21FbnRyaWVzKGhlYWRlcnMubWFwKChoZWFkZXIsY29sdW1uKT0+W2hlYWRlcix2YWx1ZXNbY29sdW1uXT8/IiJdKSk7CiAgICAgIGNvbnN0IGRhdGU9dmFpbGxhbnRDc3ZEYXRlUGFydHMocmF3LkRhdGVUaW1lKTtpZighZGF0ZSl7aW52YWxpZFJvd3MrKztjb250aW51ZTt9CiAgICAgIGNvbnN0IHBhcnNlZD17Li4uZGF0ZSx2YWx1ZXM6e319OwogICAgICBmb3IoY29uc3QgaGVhZGVyIG9mIGhlYWRlcnMpe2lmKGhlYWRlciE9PSJEYXRlVGltZSIpcGFyc2VkLnZhbHVlc1toZWFkZXJdPXZhaWxsYW50Q3N2TnVtYmVyKHJhd1toZWFkZXJdKTt9CiAgICAgIHJvd3MucHVzaChwYXJzZWQpOwogICAgfQogICAgcmV0dXJuIHtpbmRleCx0eXBlLGhlYWRlcnMscm93cyxpbnZhbGlkUm93cyxleHBvcnRlZEF0fTsKICB9CiAgZnVuY3Rpb24gc2FtZVZhaWxsYW50VmFsdWUoYSxiLHRvbGVyYW5jZT0uMDUpewogICAgaWYoYT09bnVsbHx8Yj09bnVsbClyZXR1cm4gYT09bnVsbCYmYj09bnVsbDsKICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGEpKSYmTnVtYmVyLmlzRmluaXRlKE51bWJlcihiKSk/TWF0aC5hYnMoTnVtYmVyKGEpLU51bWJlcihiKSk8PXRvbGVyYW5jZTpTdHJpbmcoYSk9PT1TdHJpbmcoYik7CiAgfQogIGZ1bmN0aW9uIGJ1aWxkVmFpbGxhbnRJbXBvcnRQcmV2aWV3KHBhcnNlZEZpbGVzKXsKICAgIGNvbnN0IGVuZXJneVR5cGVzPVsiYXJvdGhlcm0tZW5lcmd5IiwidW5pdG93ZXItZW5lcmd5Il07CiAgICBjb25zdCBkYWlseT17ImFyb3RoZXJtLWVuZXJneSI6bmV3IE1hcCgpLCJ1bml0b3dlci1lbmVyZ3kiOm5ldyBNYXAoKX07CiAgICBjb25zdCBjb25mbGljdE1vbnRocz1uZXcgU2V0KCk7bGV0IGR1cGxpY2F0ZVJvd3M9MDsKICAgIGZvcihjb25zdCBmaWxlIG9mIHBhcnNlZEZpbGVzLmZpbHRlcihmPT5lbmVyZ3lUeXBlcy5pbmNsdWRlcyhmLnR5cGUpKSl7CiAgICAgIGNvbnN0IHRhcmdldD1kYWlseVtmaWxlLnR5cGVdOwogICAgICBmb3IoY29uc3Qgcm93IG9mIGZpbGUucm93cyl7CiAgICAgICAgY29uc3QgZXhpc3Rpbmc9dGFyZ2V0LmdldChyb3cuZGF0ZUtleSk7CiAgICAgICAgaWYoIWV4aXN0aW5nKXt0YXJnZXQuc2V0KHJvdy5kYXRlS2V5LHJvdyk7Y29udGludWU7fQogICAgICAgIGNvbnN0IG1ldHJpY3M9bmV3IFNldChbLi4uT2JqZWN0LmtleXMoZXhpc3RpbmcudmFsdWVzfHx7fSksLi4uT2JqZWN0LmtleXMocm93LnZhbHVlc3x8e30pXSk7CiAgICAgICAgY29uc3QgZGlmZmVycz1bLi4ubWV0cmljc10uc29tZShtZXRyaWM9PiFzYW1lVmFpbGxhbnRWYWx1ZShleGlzdGluZy52YWx1ZXM/LlttZXRyaWNdLHJvdy52YWx1ZXM/LlttZXRyaWNdKSk7CiAgICAgICAgaWYoZGlmZmVycyljb25mbGljdE1vbnRocy5hZGQocm93Lm1vbnRoS2V5KTtlbHNlIGR1cGxpY2F0ZVJvd3MrKzsKICAgICAgfQogICAgfQogICAgY29uc3QgYWxsRGF0ZXM9Wy4uLm5ldyBTZXQoWy4uLmRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXS5rZXlzKCksLi4uZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLmtleXMoKV0pXTsKICAgIGNvbnN0IG1vbnRoS2V5cz1bLi4ubmV3IFNldChhbGxEYXRlcy5tYXAoZD0+ZC5zbGljZSgwLDcpKSldLnNvcnQoKTsKICAgIGNvbnN0IHN1bT0obWFwLGRhdGVzLG1ldHJpYyk9PmRhdGVzLnJlZHVjZSgocyxrZXkpPT57Y29uc3Qgdj1tYXAuZ2V0KGtleSk/LnZhbHVlcz8uW21ldHJpY107cmV0dXJuIHMrKE51bWJlci5pc0Zpbml0ZSh2KT92OjApO30sMCk7CiAgICBjb25zdCBmdWxsPShkYXRlcyx5LG0pPT57Y29uc3QgZXhwZWN0ZWQ9bmV3IERhdGUoeSxtLDApLmdldERhdGUoKSx1PVsuLi5uZXcgU2V0KGRhdGVzKV0uc29ydCgpO3JldHVybiB1Lmxlbmd0aD09PWV4cGVjdGVkJiZ1WzBdPT09YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwiMCIpfS0wMWAmJnUuYXQoLTEpPT09YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwiMCIpfS0ke1N0cmluZyhleHBlY3RlZCkucGFkU3RhcnQoMiwiMCIpfWA7fTsKICAgIGNvbnN0IGN1cnJlbnQ9Y3VycmVudE1vbnRoS2V5KCk7CiAgICBjb25zdCBtb250aHM9bW9udGhLZXlzLm1hcChtb250aD0+ewogICAgICBjb25zdCB5PU51bWJlcihtb250aC5zbGljZSgwLDQpKSxtPU51bWJlcihtb250aC5zbGljZSg1LDcpKTsKICAgICAgY29uc3QgYXJvPVsuLi5kYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0ua2V5cygpXS5maWx0ZXIoaz0+ay5zdGFydHNXaXRoKGAke21vbnRofS1gKSkuc29ydCgpOwogICAgICBjb25zdCB1bmk9Wy4uLmRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXS5rZXlzKCldLmZpbHRlcihrPT5rLnN0YXJ0c1dpdGgoYCR7bW9udGh9LWApKS5zb3J0KCk7CiAgICAgIGNvbnN0IHVuaW9uPVsuLi5uZXcgU2V0KFsuLi5hcm8sLi4udW5pXSldLnNvcnQoKTsKICAgICAgY29uc3QgZXhwb3J0ZWRQYXJ0aWFsPXBhcnNlZEZpbGVzLnNvbWUoZj0+WyJhcm90aGVybS1lbmVyZ3kiLCJ1bml0b3dlci1lbmVyZ3kiXS5pbmNsdWRlcyhmLnR5cGUpJiZmLmV4cG9ydGVkQXQ/LnNsaWNlKDAsNyk9PT1tb250aCk7CiAgICAgICBjb25zdCBjb21wbGV0ZT1mdWxsKGFybyx5LG0pJiZmdWxsKHVuaSx5LG0pJiYhZXhwb3J0ZWRQYXJ0aWFsJiZtb250aCE9PWN1cnJlbnQ7CiAgICAgIGNvbnN0IGhlYXRpbmdFbGVjdHJpY2l0eT0oc3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikrc3VtKGRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXSx1bmksIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikpLzEwMDA7CiAgICAgIGNvbnN0IGRod0VsZWN0cmljaXR5PXN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpLzEwMDA7CiAgICAgIGNvbnN0IGhlYXRpbmdIZWF0PShzdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikrc3VtKGRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXSx1bmksIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpKS8xMDAwOwogICAgICBjb25zdCBkaHdIZWF0PXN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJIZWF0R2VuZXJhdGVkOkRvbWVzdGljSG90V2F0ZXIiKS8xMDAwOwogICAgICBjb25zdCBlbGVjdHJpY2l0eUtXaD1oZWF0aW5nRWxlY3RyaWNpdHkrZGh3RWxlY3RyaWNpdHksaGVhdEdlbmVyYXRlZEtXaD1oZWF0aW5nSGVhdCtkaHdIZWF0OwogICAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aChtb250aCk7CiAgICAgIGNvbnN0IG5lZ2F0aXZlUmVzdD1Cb29sZWFuKGV4aXN0aW5nJiZOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcuYW5uZXgpJiZleGlzdGluZy50b3RhbC1lbGVjdHJpY2l0eUtXaC1leGlzdGluZy5hbm5leDwtLjAxKTsKICAgICAgY29uc3QgaGFzQ29uZmxpY3Q9Y29uZmxpY3RNb250aHMuaGFzKG1vbnRoKSxoYXNCb3RoPWFyby5sZW5ndGg+MCYmdW5pLmxlbmd0aD4wLGlzQ3VycmVudD1tb250aD09PWN1cnJlbnQsaXNGdXR1cmU9bW9udGg+Y3VycmVudDsKICAgICAgY29uc3QgYmxvY2tlZD0haGFzQm90aHx8aGFzQ29uZmxpY3R8fG5lZ2F0aXZlUmVzdHx8aXNGdXR1cmV8fCghY29tcGxldGUmJiFpc0N1cnJlbnQpOwogICAgICByZXR1cm4ge21vbnRoLGVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2gsaGVhdGluZ0VsZWN0cmljaXR5S1doOmhlYXRpbmdFbGVjdHJpY2l0eSxkaHdFbGVjdHJpY2l0eUtXaDpkaHdFbGVjdHJpY2l0eSxoZWF0aW5nSGVhdEtXaDpoZWF0aW5nSGVhdCxkaHdIZWF0S1doOmRod0hlYXQsY29tcGxldGUsY292ZXJhZ2VTdGFydDp1bmlvblswXXx8bnVsbCxjb3ZlcmFnZUVuZDp1bmlvbi5hdCgtMSl8fG51bGwsYmxvY2tlZCxoYXNCb3RoLGhhc0NvbmZsaWN0LG5lZ2F0aXZlUmVzdCxpc0N1cnJlbnR9OwogICAgfSk7CiAgICByZXR1cm4ge21vbnRocyxkdXBsaWNhdGVSb3dzLHJlY29nbml6ZWQ6cGFyc2VkRmlsZXMuZmlsdGVyKGY9PmYudHlwZSE9PSJ1bmtub3duIikubGVuZ3RoLHVua25vd246cGFyc2VkRmlsZXMuZmlsdGVyKGY9PmYudHlwZT09PSJ1bmtub3duIikubGVuZ3RoLGludmFsaWRSb3dzOnBhcnNlZEZpbGVzLnJlZHVjZSgocyxmKT0+cytmLmludmFsaWRSb3dzLDApfTsKICB9CiAgZnVuY3Rpb24gbWVyZ2VWYWlsbGFudEltcG9ydChtb250aHMpewogICAgY29uc3QgcmVjb3JkTWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgY29uc3QgdmFpbGxhbnRNYXA9bmV3IE1hcCgodmFpbGxhbnRNb250aHN8fFtdKS5tYXAodj0+W3YubW9udGgsey4uLnZ9XSkpOwogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO2xldCBpbXBvcnRlZD0wLGNyZWF0ZWQ9MCxwYXJ0aWFsPTA7CiAgICBmb3IoY29uc3QgbW9udGggb2YgbW9udGhzLmZpbHRlcihtPT4hbS5ibG9ja2VkKSl7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZE1hcC5nZXQobW9udGgubW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6bW9udGgubW9udGh9KTsKICAgICAgY29uc3Qgd2FzTmV3PSFyZWNvcmRNYXAuaGFzKG1vbnRoLm1vbnRoKTsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXA9bW9udGguZWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRHZW5lcmF0ZWQ9bW9udGguaGVhdEdlbmVyYXRlZEtXaDsKICAgICAgZXhpc3RpbmcuaGVhdGluZ0VsZWN0cmljaXR5PW1vbnRoLmhlYXRpbmdFbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuZGh3RWxlY3RyaWNpdHk9bW9udGguZGh3RWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRpbmdIZWF0PW1vbnRoLmhlYXRpbmdIZWF0S1doOwogICAgICBleGlzdGluZy5kaHdIZWF0PW1vbnRoLmRod0hlYXRLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wU291cmNlPW1vbnRoLmNvbXBsZXRlPyJteXZhaWxsYW50LWNzdi1pbXBvcnQiOiJteXZhaWxsYW50LWNzdi1pbXBvcnQtcGFydGlhbCI7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wVXBkYXRlZEF0PXN0YW1wOwogICAgICBleGlzdGluZy51cGRhdGVkQXQ9c3RhbXA7CiAgICAgIGlmKCFtb250aC5jb21wbGV0ZSl7CiAgICAgICAgcGFydGlhbCsrOwogICAgICAgIGNvbnN0IG5vdGU9YG15VkFJTExBTlQgQ1NWLVRlaWxtb25hdCAke21vbnRoLmNvdmVyYWdlU3RhcnR9IGJpcyAke21vbnRoLmNvdmVyYWdlRW5kfWA7CiAgICAgICAgaWYoIVN0cmluZyhleGlzdGluZy5ub3RlfHwiIikuaW5jbHVkZXMobm90ZSkpZXhpc3Rpbmcubm90ZT1leGlzdGluZy5ub3RlP2Ake2V4aXN0aW5nLm5vdGV9IOKAoiAke25vdGV9YDpub3RlOwogICAgICAgIGV4aXN0aW5nLmNsb3NlZD1mYWxzZTtleGlzdGluZy5jbG9zZWRBdD1udWxsOwogICAgICB9CiAgICAgIHJlY29yZE1hcC5zZXQobW9udGgubW9udGgsZXhpc3RpbmcpOwogICAgICB2YWlsbGFudE1hcC5zZXQobW9udGgubW9udGgse21vbnRoOm1vbnRoLm1vbnRoLGVsZWN0cmljaXR5S1doOm1vbnRoLmVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2g6bW9udGguaGVhdEdlbmVyYXRlZEtXaCxoZWF0aW5nRWxlY3RyaWNpdHlLV2g6bW9udGguaGVhdGluZ0VsZWN0cmljaXR5S1doLGRod0VsZWN0cmljaXR5S1doOm1vbnRoLmRod0VsZWN0cmljaXR5S1doLGhlYXRpbmdIZWF0S1doOm1vbnRoLmhlYXRpbmdIZWF0S1doLGRod0hlYXRLV2g6bW9udGguZGh3SGVhdEtXaCxzb3VyY2U6ZXhpc3RpbmcuaGVhdFB1bXBTb3VyY2UsZXN0aW1hdGVkOiFtb250aC5jb21wbGV0ZSx1cGRhdGVkQXQ6c3RhbXB9KTsKICAgICAgaW1wb3J0ZWQrKztpZih3YXNOZXcpY3JlYXRlZCsrOwogICAgfQogICAgc2F2ZVJlY29yZHMoWy4uLnJlY29yZE1hcC52YWx1ZXMoKV0se3JlYXNvbjoibXlWQUlMTEFOVCBDU1YgaW1wb3J0aWVydCJ9KTsKICAgIHZhaWxsYW50TW9udGhzPVsuLi52YWlsbGFudE1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTtzYXZlVmFpbGxhbnRNb250aHMoKTsKICAgIHJldHVybiB7aW1wb3J0ZWQsY3JlYXRlZCxwYXJ0aWFsfTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gaW1wb3J0VmFpbGxhbnRDc3ZGaWxlcyhmaWxlTGlzdCl7CiAgICBjb25zdCBmaWxlcz1bLi4uKGZpbGVMaXN0fHxbXSldO2lmKCFmaWxlcy5sZW5ndGgpcmV0dXJuOwogICAgc2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsIkRhdGVpZW4gd2VyZGVuIGxva2FsIGdlcHLDvGZ0IOKApiIpOwogICAgdHJ5ewogICAgICBjb25zdCBwYXJzZWQ9W107Zm9yKGxldCBpPTA7aTxmaWxlcy5sZW5ndGg7aSsrKXBhcnNlZC5wdXNoKHBhcnNlVmFpbGxhbnRDc3ZUZXh0KGF3YWl0IGZpbGVzW2ldLnRleHQoKSxpKSk7CiAgICAgIGNvbnN0IGhhc0Fybz1wYXJzZWQuc29tZSh4PT54LnR5cGU9PT0iYXJvdGhlcm0tZW5lcmd5IiksaGFzVW5pPXBhcnNlZC5zb21lKHg9PngudHlwZT09PSJ1bml0b3dlci1lbmVyZ3kiKTsKICAgICAgaWYoaGFzQXJvIT09aGFzVW5pKXRocm93IEVycm9yKCJUw6RnbGljaGUgRW5lcmdpZXdlcnRlIG51ciBtaXQgYXJvVEhFUk0gdW5kIHVuaVRPV0VSIGdlbWVpbnNhbSBpbXBvcnRpZXJlbi4iKTsKICAgICAgY29uc3QgZGFpbHk9aGFzQXJvJiZoYXNVbmk/YnVpbGRWYWlsbGFudEltcG9ydFByZXZpZXcocGFyc2VkKTp7bW9udGhzOltdfTsKICAgICAgY29uc3QgbWFwPW5ldyBNYXAobW9udGhseVZhaWxsYW50SW1wb3J0cyhwYXJzZWQpLm1hcCh4PT5beC5tb250aCx4XSkpOwogICAgICBmb3IoY29uc3Qgcm93IG9mIGRhaWx5Lm1vbnRocy5maWx0ZXIoeD0+IXguYmxvY2tlZCkpbWFwLnNldChyb3cubW9udGgscm93KTsKICAgICAgY29uc3QgbW9udGhzPVsuLi5tYXAudmFsdWVzKCldLHRlbXA9Y2xpbWF0ZVByZXZpZXcocGFyc2VkKTsKICAgICAgaWYoIW1vbnRocy5sZW5ndGgmJiF0ZW1wLmxlbmd0aCl0aHJvdyBFcnJvcigiS2VpbmUgaW1wb3J0aWVyYmFyZW4gRW5lcmdpZXdlcnRlIG9kZXIgVGVtcGVyYXR1cmRhdGVpZW4gZXJrYW5udC4iKTsKICAgICAgY29uc3Qgc2tpcHBlZD1kYWlseS5tb250aHMuZmlsdGVyKHg9PnguYmxvY2tlZCkubGVuZ3RoOwogICAgICBpZighY29uZmlybShtb250aHMubGVuZ3RoKyIgRW5lcmdpZW1vbmF0ZSB1bmQgIit0ZW1wLmxlbmd0aCsiIFRlbXBlcmF0dXJtb25hdGUgw7xiZXJuZWhtZW4/ICIrKHNraXBwZWQ/c2tpcHBlZCsiIEVuZXJnaWUtTW9uYXRlIHdlcmRlbiB3ZWdlbiB1bnZvbGxzdMOkbmRpZ2VyIG9kZXIgd2lkZXJzcHLDvGNobGljaGVyIERhdGVuIMO8YmVyc3BydW5nZW4uICI6IiIpKyJaw6RobGVyc3TDpG5kZSwgT3N0cm9tLVByZWlzZSB1bmQgTm90aXplbiBibGVpYmVuIHVudmVyw6RuZGVydC4iKSlyZXR1cm47CiAgICAgIGlmKG1vbnRocy5sZW5ndGgpbWVyZ2VWYWlsbGFudEltcG9ydChtb250aHMpOwogICAgICBpZih0ZW1wLmxlbmd0aCljbGltYXRlSW1wb3J0KHRlbXApOwogICAgICByZW5kZXJBbGwoKTsKICAgICAgc2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsbW9udGhzLmxlbmd0aCsiIEVuZXJnaWUtTW9uYXRlIHVuZCAiK3RlbXAubGVuZ3RoKyIgVGVtcGVyYXR1ci1Nb25hdGUgaW1wb3J0aWVydCIsIm9rIik7CiAgICAgIHRvYXN0KCJWYWlsbGFudC1EYXRlbiBpbXBvcnRpZXJ0Iik7CiAgICB9Y2F0Y2goZXJyb3Ipe3NldFN0YXR1cygidmFpbGxhbnRJbXBvcnRTdGF0dXMiLGVycm9yLm1lc3NhZ2UsImVycm9yIik7fQogICAgZmluYWxseXskKCJ2YWlsbGFudENzdkZpbGVzSW5wdXQiKS52YWx1ZT0iIjt9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBvc3Ryb21GZXRjaChwYXRoKXsKICAgIGlmKCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpdGhyb3cgbmV3IEVycm9yKCJBcHAtU2NobMO8c3NlbCBmZWhsdC4iKTsKICAgIGNvbnN0IHJlc3BvbnNlPWF3YWl0IGZldGNoKHBhdGgse2hlYWRlcnM6eyJ4LWVsZGVob2Yta2V5IjpzZXR0aW5ncy5vc3Ryb21BcHBLZXksImFjY2VwdCI6ImFwcGxpY2F0aW9uL2pzb24ifSxjYWNoZToibm8tc3RvcmUifSk7IGNvbnN0IHRleHQ9YXdhaXQgcmVzcG9uc2UudGV4dCgpOyBsZXQgcGF5bG9hZD17fTsgdHJ5e3BheWxvYWQ9dGV4dD9KU09OLnBhcnNlKHRleHQpOnt9O31jYXRjaHt9CiAgICBpZighcmVzcG9uc2Uub2spdGhyb3cgbmV3IEVycm9yKHBheWxvYWQuZXJyb3J8fHBheWxvYWQubWVzc2FnZXx8dGV4dHx8YEZlaGxlciAke3Jlc3BvbnNlLnN0YXR1c31gKTsgcmV0dXJuIHBheWxvYWQ7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hPc3Ryb20oc2hvd1RvYXN0PWZhbHNlKXsKICAgIGlmKG9zdHJvbUJ1c3l8fCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe3JlbmRlck9zdHJvbURhc2hib2FyZCgpO3JldHVybiBmYWxzZTt9CiAgICBvc3Ryb21CdXN5PXRydWU7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7CiAgICB0cnl7IGNvbnN0IHBheWxvYWQ9YXdhaXQgb3N0cm9tRmV0Y2goYC9hcGkvbGl2ZSR7c2hvd1RvYXN0PyI/cmVmcmVzaD0xIjoiIn1gKTsgc2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQpOyBpZihzaG93VG9hc3QpdG9hc3QoIk9zdHJvbSBha3R1YWxpc2llcnQiKTsgcmV0dXJuIHRydWU7IH0KICAgIGNhdGNoKGVycm9yKXsgc2V0T3N0cm9tU3RhdHVzKGBGZWhsZXI6ICR7ZXJyb3IubWVzc2FnZX1gLCJlcnJvciIpOyBpZihzaG93VG9hc3QpdG9hc3QoYE9zdHJvbTogJHtlcnJvci5tZXNzYWdlfWApOyByZXR1cm4gZmFsc2U7IH0KICAgIGZpbmFsbHl7b3N0cm9tQnVzeT1mYWxzZTtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTt9CiAgfQogIGZ1bmN0aW9uIHNjaGVkdWxlT3N0cm9tKCl7IGNsZWFySW50ZXJ2YWwob3N0cm9tVGltZXIpO29zdHJvbVRpbWVyPW51bGw7IGlmKHNldHRpbmdzLm9zdHJvbUFwcEtleSYmc2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2ghPT1mYWxzZSlvc3Ryb21UaW1lcj1zZXRJbnRlcnZhbCgoKT0+cmVmcmVzaE9zdHJvbShmYWxzZSksMTAqNjAqMTAwMCk7IH0KICBmdW5jdGlvbiBzZXRPc3Ryb21TdGF0dXModGV4dCxraW5kPSIiKXsgY29uc3QgZWw9JCgib3N0cm9tU3RhdHVzIik7ZWwudGV4dENvbnRlbnQ9dGV4dDtlbC5zdHlsZS5jb2xvcj1raW5kPT09ImVycm9yIj8iI2ZmYWFhOSI6IiI7IH0KICBmdW5jdGlvbiBmb3JtYXREYXRlVGltZSh2YWx1ZSl7IGNvbnN0IGQ9bmV3IERhdGUodmFsdWUpOyBpZihOdW1iZXIuaXNOYU4oZC52YWx1ZU9mKCkpKXJldHVybiAi4oCTIjsgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse3dlZWtkYXk6InNob3J0IixkYXk6IjItZGlnaXQiLG1vbnRoOiIyLWRpZ2l0Iixob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KGQpOyB9CiAgZnVuY3Rpb24gaW50ZXJ2YWxSb3dzKCl7IHJldHVybiAoQXJyYXkuaXNBcnJheShvc3Ryb21MaXZlPy5wcmljZUZvcmVjYXN0KT9vc3Ryb21MaXZlLnByaWNlRm9yZWNhc3Q6W10pLm1hcChwPT4oe3RpbWU6bmV3IERhdGUocC5kYXRlfHxwLnN0YXJ0fHxwLnRpbWVzdGFtcCkuZ2V0VGltZSgpLHByaWNlOk51bWJlcihwLnRvdGFsQ3RQZXJLV2g/P3AucHJpY2VDdFBlcktXaD8/cC5wcmljZSl9KSkuZmlsdGVyKHA9Pk51bWJlci5pc0Zpbml0ZShwLnRpbWUpJiZOdW1iZXIuaXNGaW5pdGUocC5wcmljZSkpLnNvcnQoKGEsYik9PmEudGltZS1iLnRpbWUpOyB9CiAgZnVuY3Rpb24gaW5mZXJTdGVwKHJvd3MpeyBjb25zdCBkaWZmcz1bXTtmb3IobGV0IGk9MTtpPHJvd3MubGVuZ3RoO2krKyl7Y29uc3QgZD1yb3dzW2ldLnRpbWUtcm93c1tpLTFdLnRpbWU7aWYoZD49NSo2MGUzJiZkPD0yKjM2MDBlMylkaWZmcy5wdXNoKGQpO30gaWYoIWRpZmZzLmxlbmd0aClyZXR1cm4gMzYwMGUzO2RpZmZzLnNvcnQoKGEsYik9PmEtYik7cmV0dXJuIGRpZmZzW01hdGguZmxvb3IoZGlmZnMubGVuZ3RoLzIpXTsgfQogIGZ1bmN0aW9uIGNvbXB1dGVQcmljZVdpbmRvdyhyb3dzLGhvdXJzLG1vZGUpewogICAgaWYoIXJvd3MubGVuZ3RoKXJldHVybiBudWxsOyBjb25zdCBzdGVwPWluZmVyU3RlcChyb3dzKTsgY29uc3QgY291bnQ9TWF0aC5tYXgoMSxNYXRoLnJvdW5kKGhvdXJzKjM2MDBlMy9zdGVwKSk7IGNvbnN0IG5vdz1EYXRlLm5vdygpOyBjb25zdCBwb29sPXJvd3MuZmlsdGVyKHI9PnIudGltZT49bm93LXN0ZXApLnNsaWNlKDAsTWF0aC5tYXgoY291bnQsTWF0aC5yb3VuZCg0OCozNjAwZTMvc3RlcCkpKTsKICAgIGxldCBiZXN0PW51bGw7CiAgICBmb3IobGV0IGk9MDtpK2NvdW50PD1wb29sLmxlbmd0aDtpKyspe2NvbnN0IHNsaWNlPXBvb2wuc2xpY2UoaSxpK2NvdW50KTtsZXQgY29udGlndW91cz10cnVlO2ZvcihsZXQgaj0xO2o8c2xpY2UubGVuZ3RoO2orKylpZihzbGljZVtqXS50aW1lLXNsaWNlW2otMV0udGltZT5zdGVwKjEuNil7Y29udGlndW91cz1mYWxzZTticmVhazt9aWYoIWNvbnRpZ3VvdXMpY29udGludWU7Y29uc3QgYXZnPXNsaWNlLnJlZHVjZSgocyxyKT0+cytyLnByaWNlLDApL3NsaWNlLmxlbmd0aDtjb25zdCBjYW5kaWRhdGU9e3N0YXJ0OnNsaWNlWzBdLnRpbWUsZW5kOnNsaWNlLmF0KC0xKS50aW1lK3N0ZXAsYXZnfTtpZighYmVzdHx8KG1vZGU9PT0ibWluIj9hdmc8YmVzdC5hdmc6YXZnPmJlc3QuYXZnKSliZXN0PWNhbmRpZGF0ZTt9CiAgICByZXR1cm4gYmVzdDsKICB9CiAgZnVuY3Rpb24gcmVuZGVyT3N0cm9tRGFzaGJvYXJkKCl7CiAgICBjb25zdCBjYW5SZWZyZXNoPUJvb2xlYW4oc2V0dGluZ3Mub3N0cm9tQXBwS2V5KTsKICAgIGNvbnN0IGhhc1N5bmNlZERhdGE9Qm9vbGVhbihvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdCk7CiAgICBjb25zdCB2aXNpYmxlPWNhblJlZnJlc2h8fGhhc1N5bmNlZERhdGE7CiAgICAkKCJvc3Ryb21TZXR1cEhpbnQiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHZpc2libGUpOwogICAgJCgib3N0cm9tRGFzaGJvYXJkIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhdmlzaWJsZSk7CiAgICAkKCJvc3Ryb21NaW5pQ2hhcnQiKS5wYXJlbnRFbGVtZW50LmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIXZpc2libGUpOwogICAgJCgicmVmcmVzaE9zdHJvbUJ0biIpLmRpc2FibGVkPSFjYW5SZWZyZXNofHxvc3Ryb21CdXN5OwogICAgaWYoIXZpc2libGUpeyBzZXRPc3Ryb21TdGF0dXMoIk5pY2h0IHZlcmJ1bmRlbiIpOyByZXR1cm47IH0KICAgIGlmKG9zdHJvbUJ1c3kpc2V0T3N0cm9tU3RhdHVzKCJBa3R1YWxpc2llcnVuZyBsw6R1ZnQg4oCmIik7CiAgICBlbHNlIGlmKGhhc1N5bmNlZERhdGEmJiFjYW5SZWZyZXNoKXNldE9zdHJvbVN0YXR1cyhgVm9tIGFuZGVyZW4gR2Vyw6R0IHN5bmNocm9uaXNpZXJ0IMK3ICR7Zm9ybWF0RGF0ZVRpbWUob3N0cm9tTGl2ZS5nZW5lcmF0ZWRBdCl9YCk7CiAgICBlbHNlIGlmKGhhc1N5bmNlZERhdGEpc2V0T3N0cm9tU3RhdHVzKGBBa3R1YWxpc2llcnQgJHtmb3JtYXREYXRlVGltZShvc3Ryb21MaXZlLmdlbmVyYXRlZEF0KX1gKTsKICAgIGVsc2Ugc2V0T3N0cm9tU3RhdHVzKCJOb2NoIGtlaW5lIExpdmUtRGF0ZW4iKTsKICAgIGNvbnN0IHJvd3M9aW50ZXJ2YWxSb3dzKCk7IGlmKCFyb3dzLmxlbmd0aCl7IFsib3N0cm9tQ3VycmVudFByaWNlIiwib3N0cm9tQmVzdFByaWNlIiwib3N0cm9tV29yc3RQcmljZSJdLmZvckVhY2goaWQ9PiQoaWQpLnRleHRDb250ZW50PSLigJMiKTsgWyJvc3Ryb21DdXJyZW50TWV0YSIsIm9zdHJvbUJlc3RNZXRhIiwib3N0cm9tV29yc3RNZXRhIl0uZm9yRWFjaChpZD0+JChpZCkudGV4dENvbnRlbnQ9Ik5vY2gga2VpbmUgUHJlaXN2b3JzY2hhdSIpOyBkcmF3T3N0cm9tTWluaShbXSk7IHJldHVybjsgfQogICAgY29uc3Qgbm93PURhdGUubm93KCksc3RlcD1pbmZlclN0ZXAocm93cyk7IGNvbnN0IGN1cnJlbnQ9cm93cy5maW5kKChyLGkpPT5yLnRpbWU8PW5vdyYmKHJvd3NbaSsxXT8udGltZT8/ci50aW1lK3N0ZXApPm5vdyl8fHJvd3MuZmluZChyPT5yLnRpbWU+bm93KXx8cm93cy5hdCgtMSk7IGNvbnN0IGhvdXJzPU51bWJlcihzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vycyl8fDM7IGNvbnN0IGJlc3Q9Y29tcHV0ZVByaWNlV2luZG93KHJvd3MsaG91cnMsIm1pbiIpLCB3b3JzdD1jb21wdXRlUHJpY2VXaW5kb3cocm93cyxob3VycywibWF4Iik7CiAgICAkKCJvc3Ryb21CZXN0TGFiZWwiKS50ZXh0Q29udGVudD1gQmVzdGVzICR7aG91cnN9aC1GZW5zdGVyYDsgJCgib3N0cm9tV29yc3RMYWJlbCIpLnRleHRDb250ZW50PWBTY2hsZWNodGVzdGVzICR7aG91cnN9aC1GZW5zdGVyYDsKICAgICQoIm9zdHJvbUN1cnJlbnRQcmljZSIpLnRleHRDb250ZW50PWAke251bShjdXJyZW50Py5wcmljZSwyKX0gY3Qva1doYDsgJCgib3N0cm9tQ3VycmVudE1ldGEiKS50ZXh0Q29udGVudD1jdXJyZW50P2Zvcm1hdERhdGVUaW1lKGN1cnJlbnQudGltZSk6IuKAkyI7CiAgICAkKCJvc3Ryb21CZXN0UHJpY2UiKS50ZXh0Q29udGVudD1iZXN0P2Ake251bShiZXN0LmF2ZywyKX0gY3Qva1doYDoi4oCTIjsgJCgib3N0cm9tQmVzdE1ldGEiKS50ZXh0Q29udGVudD1iZXN0P2Ake2Zvcm1hdERhdGVUaW1lKGJlc3Quc3RhcnQpfSDigJMgJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKGJlc3QuZW5kKSl9YDoi4oCTIjsKICAgICQoIm9zdHJvbVdvcnN0UHJpY2UiKS50ZXh0Q29udGVudD13b3JzdD9gJHtudW0od29yc3QuYXZnLDIpfSBjdC9rV2hgOiLigJMiOyAkKCJvc3Ryb21Xb3JzdE1ldGEiKS50ZXh0Q29udGVudD13b3JzdD9gJHtmb3JtYXREYXRlVGltZSh3b3JzdC5zdGFydCl9IOKAkyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUod29yc3QuZW5kKSl9YDoi4oCTIjsKICAgIGRyYXdPc3Ryb21NaW5pKHJvd3MuZmlsdGVyKHI9PnIudGltZT49bm93LXN0ZXApLnNsaWNlKDAsNDgpKTsKICB9CiAgZnVuY3Rpb24gZHJhd09zdHJvbU1pbmkocm93cyl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoIm9zdHJvbU1pbmlDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgaWYoIXJvd3MubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCwiS2VpbmUgT3N0cm9tLVByZWlzZGF0ZW4iKTtyZXR1cm47fSBjb25zdCBtaW49TWF0aC5taW4oLi4ucm93cy5tYXAocj0+ci5wcmljZSkpLG1heD1NYXRoLm1heCguLi5yb3dzLm1hcChyPT5yLnByaWNlKSksc3Bhbj1NYXRoLm1heCgxLG1heC1taW4pOyBjb25zdCBwYWQ9e2w6NDMscjo4LHQ6MTIsYjozMH0sdz13aWR0aC1wYWQubC1wYWQucixoPWhlaWdodC1wYWQudC1wYWQuYjsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuZ3JpZDtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5mb250PSIxMHB4IHNhbnMtc2VyaWYiO2ZvcihsZXQgaT0wO2k8PTM7aSsrKXtjb25zdCB5PXBhZC50K2gqaS8zO2N0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKHBhZC5sLHkpO2N0eC5saW5lVG8od2lkdGgtcGFkLnIseSk7Y3R4LnN0cm9rZSgpO2N0eC5maWxsVGV4dChudW0obWF4LXNwYW4qaS8zLDApLDQseSszKTt9IGN0eC5zdHJva2VTdHlsZT1DT0xPUlMudG90YWw7Y3R4LmxpbmVXaWR0aD0yO2N0eC5iZWdpblBhdGgoKTtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PXBhZC5sKyhyb3dzLmxlbmd0aD09PTE/dy8yOncqaS8ocm93cy5sZW5ndGgtMSkpLHk9cGFkLnQraCooMS0oci5wcmljZS1taW4pL3NwYW4pO2k/Y3R4LmxpbmVUbyh4LHkpOmN0eC5tb3ZlVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgICBjb25zdCBzdGVwPU1hdGgubWF4KDEsTWF0aC5mbG9vcihyb3dzLmxlbmd0aC81KSk7IHJvd3MuZm9yRWFjaCgocixpKT0+e2lmKGklc3RlcCYmaSE9PXJvd3MubGVuZ3RoLTEpcmV0dXJuO2NvbnN0IHg9cGFkLmwrKHJvd3MubGVuZ3RoPT09MT93LzI6dyppLyhyb3dzLmxlbmd0aC0xKSk7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZmlsbFRleHQobmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUoci50aW1lKSkseC04LGhlaWdodC05KTt9KTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUFuZENoZWNrT3N0cm9tKCl7CiAgICBjb25zdCBrZXk9JCgib3N0cm9tQXBwS2V5SW5wdXQiKS52YWx1ZS50cmltKCk7IHNldHRpbmdzLm9zdHJvbUFwcEtleT1rZXk7IHNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoPSQoIm9zdHJvbUF1dG9SZWZyZXNoSW5wdXQiKS5jaGVja2VkOyBzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vycz1OdW1iZXIoJCgicHJlZmVycmVkV2luZG93SG91cnNJbnB1dCIpLnZhbHVlKXx8Mzsgc2F2ZVNldHRpbmdzKCk7CiAgICBpZigha2V5KXtzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJCaXR0ZSBBcHAtU2NobMO8c3NlbCBlaW50cmFnZW4uIiwiZXJyb3IiKTtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTtyZXR1cm47fQogICAgc2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiVmVyYmluZHVuZyB3aXJkIGdlcHLDvGZ0IOKApiIpOwogICAgdHJ5eyBjb25zdCBoZWFsdGg9YXdhaXQgb3N0cm9tRmV0Y2goIi9hcGkvaGVhbHRoP2RlZXA9dG9rZW4iKTsgaWYoIWhlYWx0aC5jb25maWd1cmVkKXRocm93IG5ldyBFcnJvcigiQ2xvdWRmbGFyZS1TZWNyZXRzIHNpbmQgbmljaHQgdm9sbHN0w6RuZGlnIGVpbmdlcmljaHRldC4iKTsgc2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiT3N0cm9tLVZlcmJpbmR1bmcgZXJmb2xncmVpY2guIiwib2siKTsgYXdhaXQgcmVmcmVzaE9zdHJvbSh0cnVlKTsgc2NoZWR1bGVPc3Ryb20oKTsgcmVuZGVyQWxsKCk7IH0KICAgIGNhdGNoKGVycm9yKXtzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLGVycm9yLm1lc3NhZ2UsImVycm9yIik7fQogIH0KICBmdW5jdGlvbiBkaXNjb25uZWN0T3N0cm9tKCl7IGlmKHNldHRpbmdzLm9zdHJvbUFwcEtleSYmIWNvbmZpcm0oIk9zdHJvbS1WZXJiaW5kdW5nIHdpcmtsaWNoIGVudGZlcm5lbj8iKSlyZXR1cm47IHNldHRpbmdzLm9zdHJvbUFwcEtleT0iIjtzYXZlU2V0dGluZ3MoKTtzYXZlT3N0cm9tQ2FjaGUobnVsbCk7bG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oT1NUUk9NX0NPTlRST0xfS0VZKTtzY2hlZHVsZU9zdHJvbSgpO3JlbmRlckFsbCgpO3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIlZlcmJpbmR1bmcgZW50ZmVybnQuIik7dG9hc3QoIk9zdHJvbSBnZXRyZW5udCIpOyB9CgoKICBhc3luYyBmdW5jdGlvbiByZWZyZXNoT3N0cm9tSGlzdG9yeSh7c2lsZW50PWZhbHNlLG9ubHlNaXNzaW5nPWZhbHNlLG1heE1vbnRocz1JbmZpbml0eX09e30pewogICAgaWYob3N0cm9tSGlzdG9yeUJ1c3kpcmV0dXJuOwogICAgaWYoIXNldHRpbmdzLm9zdHJvbUFwcEtleSl7aWYoIXNpbGVudCl0b2FzdCgiT3N0cm9tIHp1ZXJzdCB2ZXJiaW5kZW4iKTtyZXR1cm47fQogICAgY29uc3QgZWxpZ2libGU9c29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSYmci5tb250aDxjdXJyZW50TW9udGhLZXkoKSkuZmlsdGVyKHI9PiFvbmx5TWlzc2luZ3x8IXIub3N0cm9tUHJpY2VDb21wbGV0ZSk7CiAgICBpZighZWxpZ2libGUubGVuZ3RoKXtpZighc2lsZW50KXRvYXN0KCJQcmVpc2hpc3RvcmllIGlzdCBiZXJlaXRzIHZvbGxzdMOkbmRpZyIpO3JldHVybjt9CiAgICBvc3Ryb21IaXN0b3J5QnVzeT10cnVlO3JlbmRlckRhdGEoKTsKICAgIGxldCB1cGRhdGVkPTAsdW5hdmFpbGFibGU9MCxwcm9jZXNzZWQ9MDsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKHJlY29yZHMubWFwKHI9PltyLm1vbnRoLHsuLi5yfV0pKTsKICAgIHRyeXsKICAgICAgZm9yKGNvbnN0IHIgb2YgZWxpZ2libGUuc2xpY2UoLU1hdGgubWF4KDEsTnVtYmVyKG1heE1vbnRocyl8fGVsaWdpYmxlLmxlbmd0aCkpKXsKICAgICAgICBwcm9jZXNzZWQrKzsKICAgICAgICBpZighc2lsZW50KXNldFN0YXR1cygib3N0cm9tSGlzdG9yeVN0YXR1cyIsYCR7bW9udGhMYWJlbChyLm1vbnRoLGZhbHNlKX0gd2lyZCB2b24gT3N0cm9tIGdlbGFkZW4g4oCmICgke3Byb2Nlc3NlZH0vJHtNYXRoLm1pbihlbGlnaWJsZS5sZW5ndGgsbWF4TW9udGhzKX0pYCk7CiAgICAgICAgdHJ5ewogICAgICAgICAgY29uc3QgZGF0YT1hd2FpdCBvc3Ryb21GZXRjaChgL2FwaS9tb250aD9tb250aD0ke2VuY29kZVVSSUNvbXBvbmVudChyLm1vbnRoKX1gKTsKICAgICAgICAgIGlmKCFkYXRhPy5jb21wbGV0ZXx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLnRvdGFsQ29zdEV1cikpKXt1bmF2YWlsYWJsZSsrO2NvbnRpbnVlO30KICAgICAgICAgIGNvbnN0IGl0ZW09bWFwLmdldChyLm1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRoOnIubW9udGh9KTsKICAgICAgICAgIGNvbnN0IHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgICAgICAgIGl0ZW0ucHJpY2VDdD1OdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCk7CiAgICAgICAgICBpdGVtLmJhc2VGZWU9TnVtYmVyKGRhdGEuZml4ZWRDb3N0RXVyKXx8MDsKICAgICAgICAgIGl0ZW0ub3N0cm9tVmFyaWFibGVDb3N0RXVyPU51bWJlcihkYXRhLnZhcmlhYmxlQ29zdEV1cik7CiAgICAgICAgICBpdGVtLm9zdHJvbVRvdGFsQ29zdEV1cj1OdW1iZXIoZGF0YS50b3RhbENvc3RFdXIpOwogICAgICAgICAgaXRlbS5vc3Ryb21Db25zdW1wdGlvbktXaD1OdW1iZXIoZGF0YS50b3RhbEtXaCk7CiAgICAgICAgICBpdGVtLm9zdHJvbVByaWNlQ29tcGxldGU9dHJ1ZTsKICAgICAgICAgIGl0ZW0ucHJpY2VTb3VyY2U9Im9zdHJvbS1ob3VybHktY29uc3VtcHRpb24td2VpZ2h0ZWQiOwogICAgICAgICAgaXRlbS5wcmljZVVwZGF0ZWRBdD1zdGFtcDsKICAgICAgICAgIGl0ZW0udXBkYXRlZEF0PXN0YW1wOwogICAgICAgICAgbWFwLnNldChyLm1vbnRoLGl0ZW0pO3Vwc2VydE9zdHJvbVByaWNlU3RhdChyLm1vbnRoLGRhdGEse3BhcnRpYWw6ZmFsc2V9KTt1cGRhdGVkKys7CiAgICAgICAgfWNhdGNoKGVycm9yKXt1bmF2YWlsYWJsZSsrO30KICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlPT5zZXRUaW1lb3V0KHJlc29sdmUsMTQwKSk7CiAgICAgIH0KICAgICAgaWYodXBkYXRlZClzYXZlUmVjb3JkcyhbLi4ubWFwLnZhbHVlcygpXSx7cmVhc29uOiJPc3Ryb20tU3R1bmRlbnByZWlzZSBha3R1YWxpc2llcnQifSk7CiAgICAgIGNvbnN0IHN0YXR1cz17dXBkYXRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSx1cGRhdGVkLHVuYXZhaWxhYmxlfTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShPU1RST01fSElTVE9SWV9LRVksSlNPTi5zdHJpbmdpZnkoc3RhdHVzKSk7CiAgICAgIHJlbmRlckFsbCgpOwogICAgICBpZighc2lsZW50KXRvYXN0KGAke3VwZGF0ZWR9IE1vbmF0KGUpIG1pdCBPc3Ryb20tU3R1bmRlbnByZWlzZW4gYWt0dWFsaXNpZXJ0JHt1bmF2YWlsYWJsZT9gIMK3ICR7dW5hdmFpbGFibGV9IG5pY2h0IHZlcmbDvGdiYXJgOiIifWApOwogICAgfWZpbmFsbHl7b3N0cm9tSGlzdG9yeUJ1c3k9ZmFsc2U7cmVuZGVyRGF0YSgpO30KICB9CgogIGZ1bmN0aW9uIHN5bmNSYW5kb21CeXRlcyhsZW5ndGg9MzIpe2NvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KGxlbmd0aCk7Y3J5cHRvLmdldFJhbmRvbVZhbHVlcyhieXRlcyk7cmV0dXJuIGJ5dGVzO30KICBmdW5jdGlvbiBzeW5jQnl0ZXNUb0Jhc2U2NFVybChieXRlcyl7bGV0IGJpbmFyeT0iIjtmb3IobGV0IGk9MDtpPGJ5dGVzLmxlbmd0aDtpKz04MTkyKWJpbmFyeSs9U3RyaW5nLmZyb21DaGFyQ29kZSguLi5ieXRlcy5zdWJhcnJheShpLGkrODE5MikpO3JldHVybiBidG9hKGJpbmFyeSkucmVwbGFjZUFsbCgiKyIsIi0iKS5yZXBsYWNlQWxsKCIvIiwiXyIpLnJlcGxhY2UoLz0rJC9nLCIiKTt9CiAgZnVuY3Rpb24gc3luY0Jhc2U2NFVybFRvQnl0ZXModmFsdWUpe2NvbnN0IHJhdz1TdHJpbmcodmFsdWV8fCIiKS5yZXBsYWNlQWxsKCItIiwiKyIpLnJlcGxhY2VBbGwoIl8iLCIvIik7Y29uc3QgcGFkZGVkPXJhdysiPSIucmVwZWF0KCg0LXJhdy5sZW5ndGglNCklNCk7Y29uc3QgYmluYXJ5PWF0b2IocGFkZGVkKTtjb25zdCBieXRlcz1uZXcgVWludDhBcnJheShiaW5hcnkubGVuZ3RoKTtmb3IobGV0IGk9MDtpPGJpbmFyeS5sZW5ndGg7aSsrKWJ5dGVzW2ldPWJpbmFyeS5jaGFyQ29kZUF0KGkpO3JldHVybiBieXRlczt9CiAgZnVuY3Rpb24gc3luY1JlY292ZXJ5Tm9ybWFsaXplKHZhbHVlKXtyZXR1cm4gU3RyaW5nKHZhbHVlfHwiIikudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXjAtOWEtZl0vZywiIik7fQogIGZ1bmN0aW9uIHN5bmNSZWNvdmVyeUZvcm1hdCh2YWx1ZSl7Y29uc3QgcmF3PXN5bmNSZWNvdmVyeU5vcm1hbGl6ZSh2YWx1ZSkudG9VcHBlckNhc2UoKTtyZXR1cm4gcmF3Lm1hdGNoKC8uezEsNH0vZyk/LmpvaW4oIi0iKXx8IiI7fQogIGZ1bmN0aW9uIHN5bmNHZW5lcmF0ZVJlY292ZXJ5S2V5KCl7cmV0dXJuIFsuLi5zeW5jUmFuZG9tQnl0ZXMoMzIpXS5tYXAoYj0+Yi50b1N0cmluZygxNikucGFkU3RhcnQoMiwiMCIpKS5qb2luKCIiKTt9CiAgZnVuY3Rpb24gc3luY0dlbmVyYXRlSWQocHJlZml4LGJ5dGVzPTE2KXtyZXR1cm4gYCR7cHJlZml4fS0ke3N5bmNCeXRlc1RvQmFzZTY0VXJsKHN5bmNSYW5kb21CeXRlcyhieXRlcykpfWA7fQogIGZ1bmN0aW9uIGxvYWRTeW5jU3RhdGUoKXsKICAgIGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNZTkNfU1RBVEVfS0VZKSx7fSk7CiAgICByZXR1cm4ge2NvbmZpZ3VyZWQ6Qm9vbGVhbihyYXc/LmNvbmZpZ3VyZWQpLHZhdWx0SWQ6U3RyaW5nKHJhdz8udmF1bHRJZHx8IiIpLGRldmljZUlkOlN0cmluZyhyYXc/LmRldmljZUlkfHwiIiksZGV2aWNlTmFtZTpTdHJpbmcocmF3Py5kZXZpY2VOYW1lfHwiIiksZGV2aWNlVG9rZW46U3RyaW5nKHJhdz8uZGV2aWNlVG9rZW58fCIiKSxyZWNvdmVyeUtleTooKCk9Pntjb25zdCBjdXJyZW50PXN5bmNSZWNvdmVyeU5vcm1hbGl6ZShyYXc/LnJlY292ZXJ5S2V5fHwiIik7Y29uc3QgbGVnYWN5PXN5bmNSZWNvdmVyeU5vcm1hbGl6ZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTWU5DX1NFQ1JFVF9MRUdBQ1lfS0VZKXx8IiIpO3JldHVybiBjdXJyZW50Lmxlbmd0aD09PTY0P2N1cnJlbnQ6bGVnYWN5Lmxlbmd0aD09PTY0P2xlZ2FjeTpjdXJyZW50O30pKCkscm9sZTpyYXc/LnJvbGU9PT0iYWRtaW4iPyJhZG1pbiI6Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOk1hdGgubWF4KDAsTnVtYmVyKHJhdz8uc2VydmVyUmV2aXNpb24/P3Jhdz8ucmV2aXNpb24pfHwwKSxsYXN0U3luY0F0OlN0cmluZyhyYXc/Lmxhc3RTeW5jQXR8fCIiKSxsYXN0RXJyb3I6U3RyaW5nKHJhdz8ubGFzdEVycm9yfHwiIil9OwogIH0KICBmdW5jdGlvbiBzYXZlU3luY1N0YXRlKCl7bG9jYWxTdG9yYWdlLnNldEl0ZW0oU1lOQ19TVEFURV9LRVksSlNPTi5zdHJpbmdpZnkoc3luY1N0YXRlKSk7fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNEZXJpdmVLZXkocmVjb3ZlcnlLZXksdmF1bHRJZCl7CiAgICBjb25zdCByYXc9c3luY1JlY292ZXJ5Tm9ybWFsaXplKHJlY292ZXJ5S2V5KTtpZihyYXcubGVuZ3RoIT09NjQpdGhyb3cgbmV3IEVycm9yKCJXaWVkZXJoZXJzdGVsbHVuZ3NzY2hsw7xzc2VsIGlzdCB1bnZvbGxzdMOkbmRpZy4iKTsKICAgIGNvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KHJhdy5tYXRjaCgvLnsyfS9nKS5tYXAodj0+cGFyc2VJbnQodiwxNikpKTtjb25zdCBiYXNlPWF3YWl0IGNyeXB0by5zdWJ0bGUuaW1wb3J0S2V5KCJyYXciLGJ5dGVzLCJIS0RGIixmYWxzZSxbImRlcml2ZUtleSJdKTsKICAgIHJldHVybiBjcnlwdG8uc3VidGxlLmRlcml2ZUtleSh7bmFtZToiSEtERiIsaGFzaDoiU0hBLTI1NiIsc2FsdDpuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodmF1bHRJZCksaW5mbzpuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoImVsZGVob2YtcHJpdmF0ZS1zeW5jLXYxIil9LGJhc2Use25hbWU6IkFFUy1HQ00iLGxlbmd0aDoyNTZ9LGZhbHNlLFsiZW5jcnlwdCIsImRlY3J5cHQiXSk7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNFbmNyeXB0KHBheWxvYWQpe2NvbnN0IGtleT1hd2FpdCBzeW5jRGVyaXZlS2V5KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSxzeW5jU3RhdGUudmF1bHRJZCk7Y29uc3QgaXY9c3luY1JhbmRvbUJ5dGVzKDEyKTtjb25zdCBhYWQ9bmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGAke1NZTkNfRU5WRUxPUEVfU0NIRU1BfToke3N5bmNTdGF0ZS52YXVsdElkfWApO2NvbnN0IHBsYWluPW5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7Y29uc3QgZW5jcnlwdGVkPWF3YWl0IGNyeXB0by5zdWJ0bGUuZW5jcnlwdCh7bmFtZToiQUVTLUdDTSIsaXYsYWRkaXRpb25hbERhdGE6YWFkLHRhZ0xlbmd0aDoxMjh9LGtleSxwbGFpbik7cmV0dXJuIHtzY2hlbWE6U1lOQ19FTlZFTE9QRV9TQ0hFTUEsYWxnb3JpdGhtOiJBRVMtR0NNLTI1Ni9IS0RGLVNIQS0yNTYiLGl2OnN5bmNCeXRlc1RvQmFzZTY0VXJsKGl2KSxjaXBoZXJ0ZXh0OnN5bmNCeXRlc1RvQmFzZTY0VXJsKG5ldyBVaW50OEFycmF5KGVuY3J5cHRlZCkpLHNjb3BlOiJmdWxsIixjcmVhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHBheWxvYWRCdWlsZDpBUFBfQlVJTER9O30KICBhc3luYyBmdW5jdGlvbiBzeW5jRGVjcnlwdChlbnZlbG9wZSl7aWYoZW52ZWxvcGU/LnNjaGVtYSE9PVNZTkNfRU5WRUxPUEVfU0NIRU1BKXRocm93IG5ldyBFcnJvcigiVW5iZWthbm50ZXMgU3luYy1QYWtldC4iKTtjb25zdCBrZXk9YXdhaXQgc3luY0Rlcml2ZUtleShzeW5jU3RhdGUucmVjb3ZlcnlLZXksc3luY1N0YXRlLnZhdWx0SWQpO2NvbnN0IGFhZD1uZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoYCR7U1lOQ19FTlZFTE9QRV9TQ0hFTUF9OiR7c3luY1N0YXRlLnZhdWx0SWR9YCk7bGV0IHBsYWluO3RyeXtwbGFpbj1hd2FpdCBjcnlwdG8uc3VidGxlLmRlY3J5cHQoe25hbWU6IkFFUy1HQ00iLGl2OnN5bmNCYXNlNjRVcmxUb0J5dGVzKGVudmVsb3BlLml2KSxhZGRpdGlvbmFsRGF0YTphYWQsdGFnTGVuZ3RoOjEyOH0sa2V5LHN5bmNCYXNlNjRVcmxUb0J5dGVzKGVudmVsb3BlLmNpcGhlcnRleHQpKTt9Y2F0Y2h7dGhyb3cgbmV3IEVycm9yKCJTeW5jLVBha2V0IGtvbm50ZSBuaWNodCBlbnRzY2hsw7xzc2VsdCB3ZXJkZW4uIik7fWNvbnN0IHBheWxvYWQ9SlNPTi5wYXJzZShuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocGxhaW4pKTtpZihwYXlsb2FkPy5zY2hlbWEhPT1TWU5DX1BBWUxPQURfU0NIRU1BKXRocm93IG5ldyBFcnJvcigiU3luYy1QYWtldCBzdGFtbXQgYXVzIGVpbmVyIG5pY2h0IGtvbXBhdGlibGVuIEVsZGVob2YtVmVyc2lvbi4iKTtyZXR1cm4gcGF5bG9hZDt9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0FwaShwYXRoLGJvZHkpe2NvbnN0IHJlc3BvbnNlPWF3YWl0IGZldGNoKGAvYXBpL3N5bmMvJHtwYXRofWAse21ldGhvZDoiUE9TVCIsaGVhZGVyczp7ImNvbnRlbnQtdHlwZSI6ImFwcGxpY2F0aW9uL2pzb24iLCJhY2NlcHQiOiJhcHBsaWNhdGlvbi9qc29uIn0sYm9keTpKU09OLnN0cmluZ2lmeShib2R5KSxjYWNoZToibm8tc3RvcmUifSk7bGV0IHBheWxvYWQ9e307dHJ5e3BheWxvYWQ9YXdhaXQgcmVzcG9uc2UuanNvbigpO31jYXRjaHt9aWYoIXJlc3BvbnNlLm9rKXtjb25zdCBlcnJvcj1uZXcgRXJyb3IocGF5bG9hZC5lcnJvcnx8YFN5bmMtRmVobGVyICR7cmVzcG9uc2Uuc3RhdHVzfWApO2Vycm9yLnN0YXR1cz1yZXNwb25zZS5zdGF0dXM7ZXJyb3IucGF5bG9hZD1wYXlsb2FkO3Rocm93IGVycm9yO31yZXR1cm4gcGF5bG9hZDt9CiAgZnVuY3Rpb24gc3luY0F1dGgoZXh0cmE9e30pe3JldHVybiB7dmF1bHRJZDpzeW5jU3RhdGUudmF1bHRJZCxkZXZpY2VJZDpzeW5jU3RhdGUuZGV2aWNlSWQsZGV2aWNlVG9rZW46c3luY1N0YXRlLmRldmljZVRva2VuLC4uLmV4dHJhfTt9CiAgZnVuY3Rpb24gc3luY0l0ZW1UaW1lKGl0ZW0pe2Zvcihjb25zdCBrZXkgb2YgWyJ1cGRhdGVkQXQiLCJwcmljZVVwZGF0ZWRBdCIsImhlYXRQdW1wVXBkYXRlZEF0IiwiY2xvc2VkQXQiXSl7Y29uc3QgdD1EYXRlLnBhcnNlKGl0ZW0/LltrZXldfHwiIik7aWYoTnVtYmVyLmlzRmluaXRlKHQpKXJldHVybiB0O31yZXR1cm4gMDt9CiAgZnVuY3Rpb24gc3luY01lcmdlQnlLZXkobG9jYWwscmVtb3RlLGtleUZpZWxkKXtjb25zdCBtYXA9bmV3IE1hcCgpO2Zvcihjb25zdCBpdGVtIG9mIEFycmF5LmlzQXJyYXkobG9jYWwpP2xvY2FsOltdKW1hcC5zZXQoU3RyaW5nKGl0ZW0/LltrZXlGaWVsZF18fCIiKSxpdGVtKTtmb3IoY29uc3QgcmVtb3RlSXRlbSBvZiBBcnJheS5pc0FycmF5KHJlbW90ZSk/cmVtb3RlOltdKXtjb25zdCBrZXk9U3RyaW5nKHJlbW90ZUl0ZW0/LltrZXlGaWVsZF18fCIiKTtpZigha2V5KWNvbnRpbnVlO2NvbnN0IGxvY2FsSXRlbT1tYXAuZ2V0KGtleSk7aWYoIWxvY2FsSXRlbXx8c3luY0l0ZW1UaW1lKHJlbW90ZUl0ZW0pPj1zeW5jSXRlbVRpbWUobG9jYWxJdGVtKSltYXAuc2V0KGtleSxyZW1vdGVJdGVtKTt9cmV0dXJuIFsuLi5tYXAudmFsdWVzKCldO30KICBmdW5jdGlvbiBzeW5jQ3VycmVudFBheWxvYWQoKXtyZXR1cm4ge3NjaGVtYTpTWU5DX1BBWUxPQURfU0NIRU1BLHBheWxvYWRWZXJzaW9uOiI2LjMuNCIsYXBwOiJFbGRlaG9mIixzY29wZToiZnVsbCIscmVjb3JkczpzYW5pdGl6ZVJlY29yZHMocmVjb3JkcyksdmFpbGxhbnRNb250aHM6QXJyYXkuaXNBcnJheSh2YWlsbGFudE1vbnRocyk/dmFpbGxhbnRNb250aHM6W10sY2xpbWF0ZU1vbnRoczpjbGltYXRlU2FuaXRpemUoY2xpbWF0ZU1vbnRocyksbWV0ZXJSZWFkaW5nczpzYW5pdGl6ZU1ldGVyUmVhZGluZ3MobWV0ZXJSZWFkaW5ncyksbWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdDpsb2NhbFN0b3JhZ2UuZ2V0SXRlbShNRVRFUl9NRVRBX0tFWSl8fCIiLG9zdHJvbUxpdmU6b3N0cm9tTGl2ZXx8bnVsbCxvc3Ryb21QcmljZVN0YXRzOnNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhvc3Ryb21QcmljZVN0YXRzKSxleHBvcnRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxzb3VyY2VEZXZpY2VJZDpzeW5jU3RhdGUuZGV2aWNlSWQsc291cmNlRGV2aWNlTmFtZTpzeW5jU3RhdGUuZGV2aWNlTmFtZX07fQogIGZ1bmN0aW9uIHN5bmNNZXJnZVBheWxvYWQobG9jYWwscmVtb3RlKXsKICAgIGNvbnN0IGxvY2FsTWV0ZXJUaW1lPURhdGUucGFyc2UobG9jYWw/Lm1ldGVyUmVhZGluZ3NVcGRhdGVkQXR8fCIiKXx8MCxyZW1vdGVNZXRlclRpbWU9RGF0ZS5wYXJzZShyZW1vdGU/Lm1ldGVyUmVhZGluZ3NVcGRhdGVkQXR8fCIiKXx8MDsKICAgIGxldCBtZXJnZWRNZXRlcnM7aWYocmVtb3RlTWV0ZXJUaW1lPmxvY2FsTWV0ZXJUaW1lKW1lcmdlZE1ldGVycz1yZW1vdGUubWV0ZXJSZWFkaW5nc3x8W107ZWxzZSBpZihsb2NhbE1ldGVyVGltZT5yZW1vdGVNZXRlclRpbWUpbWVyZ2VkTWV0ZXJzPWxvY2FsLm1ldGVyUmVhZGluZ3N8fFtdO2Vsc2UgbWVyZ2VkTWV0ZXJzPShyZW1vdGU/Lm1ldGVyUmVhZGluZ3M/Lmxlbmd0aHx8MCk+PShsb2NhbD8ubWV0ZXJSZWFkaW5ncz8ubGVuZ3RofHwwKT9yZW1vdGUubWV0ZXJSZWFkaW5nc3x8W106bG9jYWwubWV0ZXJSZWFkaW5nc3x8W107CiAgICBjb25zdCBsb2NhbExpdmU9RGF0ZS5wYXJzZShsb2NhbD8ub3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKXx8MCxyZW1vdGVMaXZlPURhdGUucGFyc2UocmVtb3RlPy5vc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpfHwwOwogICAgcmV0dXJuIHtzY2hlbWE6U1lOQ19QQVlMT0FEX1NDSEVNQSxwYXlsb2FkVmVyc2lvbjoiNi4zLjQiLGFwcDoiRWxkZWhvZiIsc2NvcGU6ImZ1bGwiLHJlY29yZHM6c2FuaXRpemVSZWNvcmRzKHN5bmNNZXJnZUJ5S2V5KGxvY2FsPy5yZWNvcmRzLHJlbW90ZT8ucmVjb3JkcywibW9udGgiKSksdmFpbGxhbnRNb250aHM6c3luY01lcmdlQnlLZXkobG9jYWw/LnZhaWxsYW50TW9udGhzLHJlbW90ZT8udmFpbGxhbnRNb250aHMsIm1vbnRoIiksY2xpbWF0ZU1vbnRoczpjbGltYXRlU2FuaXRpemUoc3luY01lcmdlQnlLZXkobG9jYWw/LmNsaW1hdGVNb250aHMscmVtb3RlPy5jbGltYXRlTW9udGhzLCJtb250aCIpKSxtZXRlclJlYWRpbmdzOnNhbml0aXplTWV0ZXJSZWFkaW5ncyhtZXJnZWRNZXRlcnMpLG1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6cmVtb3RlTWV0ZXJUaW1lPmxvY2FsTWV0ZXJUaW1lP3JlbW90ZS5tZXRlclJlYWRpbmdzVXBkYXRlZEF0OmxvY2FsLm1ldGVyUmVhZGluZ3NVcGRhdGVkQXQsb3N0cm9tTGl2ZTpyZW1vdGVMaXZlPj1sb2NhbExpdmU/cmVtb3RlPy5vc3Ryb21MaXZlfHxudWxsOmxvY2FsPy5vc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHN5bmNNZXJnZUJ5S2V5KGxvY2FsPy5vc3Ryb21QcmljZVN0YXRzLHJlbW90ZT8ub3N0cm9tUHJpY2VTdGF0cywibW9udGgiKSksZXhwb3J0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksc291cmNlRGV2aWNlSWQ6c3luY1N0YXRlLmRldmljZUlkLHNvdXJjZURldmljZU5hbWU6c3luY1N0YXRlLmRldmljZU5hbWV9OwogIH0KICBmdW5jdGlvbiBzeW5jQ29tcGFyYWJsZShwYXlsb2FkKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3JlY29yZHM6c2FuaXRpemVSZWNvcmRzKHBheWxvYWQ/LnJlY29yZHN8fFtdKSx2YWlsbGFudE1vbnRoczpwYXlsb2FkPy52YWlsbGFudE1vbnRoc3x8W10sY2xpbWF0ZU1vbnRoczpjbGltYXRlU2FuaXRpemUocGF5bG9hZD8uY2xpbWF0ZU1vbnRoc3x8W10pLG1ldGVyUmVhZGluZ3M6c2FuaXRpemVNZXRlclJlYWRpbmdzKHBheWxvYWQ/Lm1ldGVyUmVhZGluZ3N8fFtdKSxtZXRlclJlYWRpbmdzVXBkYXRlZEF0OnBheWxvYWQ/Lm1ldGVyUmVhZGluZ3NVcGRhdGVkQXR8fCIiLG9zdHJvbUxpdmU6cGF5bG9hZD8ub3N0cm9tTGl2ZXx8bnVsbCxvc3Ryb21QcmljZVN0YXRzOnNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhwYXlsb2FkPy5vc3Ryb21QcmljZVN0YXRzfHxbXSl9KTt9CiAgZnVuY3Rpb24gc3luY0FwcGx5UGF5bG9hZChwYXlsb2FkKXtzeW5jQXBwbHlpbmc9dHJ1ZTt0cnl7c2F2ZVJlY29yZHMocGF5bG9hZC5yZWNvcmRzfHxbXSx7cmVhc29uOiJHZXLDpHRlLVN5bmMiLGFsbG93RW1wdHk6dHJ1ZX0pO3ZhaWxsYW50TW9udGhzPUFycmF5LmlzQXJyYXkocGF5bG9hZC52YWlsbGFudE1vbnRocyk/cGF5bG9hZC52YWlsbGFudE1vbnRoczpbXTtzYXZlVmFpbGxhbnRNb250aHMoKTtzYXZlQ2xpbWF0ZU1vbnRocyhwYXlsb2FkLmNsaW1hdGVNb250aHN8fFtdKTtzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3N8fFtdLHt0b3VjaDpmYWxzZX0pO2lmKHBheWxvYWQubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShNRVRFUl9NRVRBX0tFWSxwYXlsb2FkLm1ldGVyUmVhZGluZ3NVcGRhdGVkQXQpO3NhdmVPc3Ryb21DYWNoZShwYXlsb2FkLm9zdHJvbUxpdmV8fG51bGwpO3NhdmVPc3Ryb21QcmljZVN0YXRzKHBheWxvYWQub3N0cm9tUHJpY2VTdGF0c3x8W10pO31maW5hbGx5e3N5bmNBcHBseWluZz1mYWxzZTt9cmVuZGVyQWxsKCk7fQogIGZ1bmN0aW9uIHNjaGVkdWxlQ2xvdWRTeW5jKGRlbGF5PTkwMCl7Y2xlYXJUaW1lb3V0KHN5bmNEZWJvdW5jZVRpbWVyKTtpZighc3luY1N0YXRlLmNvbmZpZ3VyZWR8fHN5bmNBcHBseWluZylyZXR1cm47c3luY0RlYm91bmNlVGltZXI9c2V0VGltZW91dCgoKT0+e2lmKGRvY3VtZW50LnZpc2liaWxpdHlTdGF0ZSE9PSJoaWRkZW4iJiZuYXZpZ2F0b3Iub25MaW5lIT09ZmFsc2Upc3luY05vdyh7c2lsZW50OnRydWV9KTt9LGRlbGF5KTt9CiAgZnVuY3Rpb24gc2NoZWR1bGVTeW5jUG9sbCgpe2NsZWFySW50ZXJ2YWwoc3luY1BvbGxUaW1lcik7c3luY1BvbGxUaW1lcj1udWxsO2lmKCFzeW5jU3RhdGUuY29uZmlndXJlZClyZXR1cm47c3luY1BvbGxUaW1lcj1zZXRJbnRlcnZhbCgoKT0+e2lmKGRvY3VtZW50LnZpc2liaWxpdHlTdGF0ZT09PSJ2aXNpYmxlIiYmbmF2aWdhdG9yLm9uTGluZSE9PWZhbHNlKXN5bmNOb3coe3NpbGVudDp0cnVlfSk7fSw2MCoxMDAwKTt9CiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlU3luY1ZhdWx0KCl7aWYoc3luY0J1c3kpcmV0dXJuO2NvbnN0IGRldmljZU5hbWU9U3RyaW5nKCQoInN5bmNDcmVhdGVEZXZpY2VOYW1lIikudmFsdWV8fCIiKS50cmltKCk7aWYoZGV2aWNlTmFtZS5sZW5ndGg8Mil7dG9hc3QoIkdlcsOkdGVuYW1lbiBlaW5nZWJlbiIpO3JldHVybjt9c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7c3luY1N0YXRlPXtjb25maWd1cmVkOnRydWUsdmF1bHRJZDpzeW5jR2VuZXJhdGVJZCgidmF1bHQiLDE4KSxkZXZpY2VJZDpzeW5jR2VuZXJhdGVJZCgiZGV2aWNlIiwxNiksZGV2aWNlTmFtZSxkZXZpY2VUb2tlbjpzeW5jR2VuZXJhdGVJZCgidG9rZW4iLDMyKSxyZWNvdmVyeUtleTpzeW5jR2VuZXJhdGVSZWNvdmVyeUtleSgpLHJvbGU6ImFkbWluIixzY29wZToiZnVsbCIsc2VydmVyUmV2aXNpb246MCxsYXN0U3luY0F0OiIiLGxhc3RFcnJvcjoiIn07Y29uc3Qgc25hcHNob3Q9c3luY0N1cnJlbnRQYXlsb2FkKCk7Y29uc3QgZW52ZWxvcGU9YXdhaXQgc3luY0VuY3J5cHQoc25hcHNob3QpO2NvbnN0IHJlc3VsdD1hd2FpdCBzeW5jQXBpKCJ2YXVsdC9jcmVhdGUiLHt2YXVsdElkOnN5bmNTdGF0ZS52YXVsdElkLGRldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VuOnN5bmNTdGF0ZS5kZXZpY2VUb2tlbixzY29wZToiZnVsbCIsZW52ZWxvcGV9KTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cmVzdWx0LnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7c2NoZWR1bGVTeW5jUG9sbCgpO3JlbmRlckFsbCgpO3RvYXN0KCJHZXLDpHRlLVN5bmMgZWluZ2VyaWNodGV0Iik7fWNhdGNoKGVycm9yKXtzeW5jU3RhdGU9bG9hZFN5bmNTdGF0ZSgpO3N5bmNTdGF0ZS5sYXN0RXJyb3I9ZXJyb3IubWVzc2FnZTtzYXZlU3luY1N0YXRlKCk7YWxlcnQoYEdlcsOkdGUtU3luYyBrb25udGUgbmljaHQgZWluZ2VyaWNodGV0IHdlcmRlbjogJHtlcnJvci5tZXNzYWdlfWApO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlU3luY1BhaXJpbmcoKXtpZihzeW5jQnVzeXx8IXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjtpZihzeW5jU3RhdGUucm9sZSE9PSJhZG1pbiIpe3RvYXN0KCJOdXIgZGFzIGVyc3RlIFZlcndhbHR1bmdzZ2Vyw6R0IGthbm4gbmV1ZSBHZXLDpHRlIGtvcHBlbG4iKTtyZXR1cm47fXN5bmNCdXN5PXRydWU7cmVuZGVyU3luY1BhbmVsKCk7dHJ5e2NvbnN0IHJlc3VsdD1hd2FpdCBzeW5jQXBpKCJwYWlyL2NyZWF0ZSIsc3luY0F1dGgoe3Njb3BlOiJmdWxsIn0pKTskKCJzeW5jUGFpclZhdWx0IikudGV4dENvbnRlbnQ9c3luY1N0YXRlLnZhdWx0SWQ7JCgic3luY1BhaXJDb2RlIikudGV4dENvbnRlbnQ9cmVzdWx0LmNvZGU7JCgic3luY1BhaXJSZWNvdmVyeSIpLnRleHRDb250ZW50PXN5bmNSZWNvdmVyeUZvcm1hdChzeW5jU3RhdGUucmVjb3ZlcnlLZXkpOyQoInN5bmNQYWlyRXhwaXJ5IikudGV4dENvbnRlbnQ9YENvZGUgZ8O8bHRpZyBiaXMgJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHJlc3VsdC5leHBpcmVzQXQpKX1gOyQoInN5bmNQYWlyUmVzdWx0IikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7fWNhdGNoKGVycm9yKXt0b2FzdChlcnJvci5tZXNzYWdlKTt9ZmluYWxseXtzeW5jQnVzeT1mYWxzZTtyZW5kZXJTeW5jUGFuZWwoKTt9fQogIGFzeW5jIGZ1bmN0aW9uIGpvaW5TeW5jVmF1bHQoKXtpZihzeW5jQnVzeSlyZXR1cm47Y29uc3QgdmF1bHRJZD1TdHJpbmcoJCgic3luY0pvaW5WYXVsdElkIikudmFsdWV8fCIiKS50cmltKCksY29kZT1TdHJpbmcoJCgic3luY0pvaW5Db2RlIikudmFsdWV8fCIiKS50cmltKCkscmVjb3ZlcnlLZXk9c3luY1JlY292ZXJ5Tm9ybWFsaXplKCQoInN5bmNKb2luUmVjb3ZlcnkiKS52YWx1ZSksZGV2aWNlTmFtZT1TdHJpbmcoJCgic3luY0pvaW5EZXZpY2VOYW1lIikudmFsdWV8fCIiKS50cmltKCk7aWYoIXZhdWx0SWR8fCFjb2RlfHxyZWNvdmVyeUtleS5sZW5ndGghPT02NHx8ZGV2aWNlTmFtZS5sZW5ndGg8Mil7dG9hc3QoIktvcHBsdW5nc2RhdGVuIHZvbGxzdMOkbmRpZyBlaW5nZWJlbiIpO3JldHVybjt9c3luY0J1c3k9dHJ1ZTt0cnl7Y29uc3QgZGV2aWNlSWQ9c3luY0dlbmVyYXRlSWQoImRldmljZSIsMTYpLGRldmljZVRva2VuPXN5bmNHZW5lcmF0ZUlkKCJ0b2tlbiIsMzIpO2NvbnN0IGNsYWltPWF3YWl0IHN5bmNBcGkoInBhaXIvY2xhaW0iLHt2YXVsdElkLGNvZGUsZGV2aWNlSWQsZGV2aWNlTmFtZSxkZXZpY2VUb2tlbn0pO3N5bmNTdGF0ZT17Y29uZmlndXJlZDp0cnVlLHZhdWx0SWQsZGV2aWNlSWQsZGV2aWNlTmFtZSxkZXZpY2VUb2tlbixyZWNvdmVyeUtleSxyb2xlOmNsYWltLnJvbGV8fCJtZW1iZXIiLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtzYXZlU3luY1N0YXRlKCk7Y29uc3QgcmVtb3RlPWF3YWl0IHN5bmNBcGkoInNuYXBzaG90L3B1bGwiLHN5bmNBdXRoKCkpO2NvbnN0IHJlbW90ZVBheWxvYWQ9YXdhaXQgc3luY0RlY3J5cHQocmVtb3RlLnNuYXBzaG90LmVudmVsb3BlKTtjb25zdCBtZXJnZWQ9c3luY01lcmdlUGF5bG9hZChzeW5jQ3VycmVudFBheWxvYWQoKSxyZW1vdGVQYXlsb2FkKTtzeW5jQXBwbHlQYXlsb2FkKG1lcmdlZCk7c3luY1N0YXRlLnNlcnZlclJldmlzaW9uPXJlbW90ZS5yZXZpc2lvbjtzeW5jU3RhdGUubGFzdFN5bmNBdD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7c2F2ZVN5bmNTdGF0ZSgpO2lmKHN5bmNDb21wYXJhYmxlKG1lcmdlZCkhPT1zeW5jQ29tcGFyYWJsZShyZW1vdGVQYXlsb2FkKSl7Y29uc3QgZW52ZWxvcGU9YXdhaXQgc3luY0VuY3J5cHQobWVyZ2VkKTtjb25zdCBwdXNoZWQ9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVzaCIsc3luY0F1dGgoe2Jhc2VSZXZpc2lvbjpyZW1vdGUucmV2aXNpb24sZW52ZWxvcGV9KSk7c3luY1N0YXRlLnNlcnZlclJldmlzaW9uPXB1c2hlZC5yZXZpc2lvbjtzeW5jU3RhdGUubGFzdFN5bmNBdD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7c2F2ZVN5bmNTdGF0ZSgpO31zY2hlZHVsZVN5bmNQb2xsKCk7cmVuZGVyQWxsKCk7dG9hc3QoIkdlcsOkdCBnZWtvcHBlbHQgdW5kIGFrdHVhbGlzaWVydCIpO31jYXRjaChlcnJvcil7c3luY1N0YXRlPXtjb25maWd1cmVkOmZhbHNlLHZhdWx0SWQ6IiIsZGV2aWNlSWQ6IiIsZGV2aWNlTmFtZToiIixkZXZpY2VUb2tlbjoiIixyZWNvdmVyeUtleToiIixyb2xlOiJtZW1iZXIiLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOmVycm9yLm1lc3NhZ2V9O3NhdmVTeW5jU3RhdGUoKTthbGVydChgS29wcGx1bmcgZmVobGdlc2NobGFnZW46ICR7ZXJyb3IubWVzc2FnZX1gKTt9ZmluYWxseXtzeW5jQnVzeT1mYWxzZTtyZW5kZXJTeW5jUGFuZWwoKTt9fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNOb3coe3NpbGVudD1mYWxzZSxyZXRyeT10cnVlfT17fSl7aWYoc3luY0J1c3l8fCFzeW5jU3RhdGUuY29uZmlndXJlZClyZXR1cm4gZmFsc2U7c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7Y29uc3QgcmVtb3RlPWF3YWl0IHN5bmNBcGkoInNuYXBzaG90L3B1bGwiLHN5bmNBdXRoKCkpO2NvbnN0IHJlbW90ZVBheWxvYWQ9YXdhaXQgc3luY0RlY3J5cHQocmVtb3RlLnNuYXBzaG90LmVudmVsb3BlKTtjb25zdCBsb2NhbFBheWxvYWQ9c3luY0N1cnJlbnRQYXlsb2FkKCk7Y29uc3QgbWVyZ2VkPXN5bmNNZXJnZVBheWxvYWQobG9jYWxQYXlsb2FkLHJlbW90ZVBheWxvYWQpO3N5bmNBcHBseVBheWxvYWQobWVyZ2VkKTtsZXQgcmV2aXNpb249cmVtb3RlLnJldmlzaW9uO2lmKHN5bmNDb21wYXJhYmxlKG1lcmdlZCkhPT1zeW5jQ29tcGFyYWJsZShyZW1vdGVQYXlsb2FkKSl7dHJ5e2NvbnN0IGVudmVsb3BlPWF3YWl0IHN5bmNFbmNyeXB0KG1lcmdlZCk7Y29uc3QgcHVzaGVkPWF3YWl0IHN5bmNBcGkoInNuYXBzaG90L3B1c2giLHN5bmNBdXRoKHtiYXNlUmV2aXNpb246cmVtb3RlLnJldmlzaW9uLGVudmVsb3BlfSkpO3JldmlzaW9uPXB1c2hlZC5yZXZpc2lvbjt9Y2F0Y2goZXJyb3Ipe2lmKGVycm9yLnN0YXR1cz09PTQwOSYmcmV0cnkpe3N5bmNCdXN5PWZhbHNlO3JldHVybiBhd2FpdCBzeW5jTm93KHtzaWxlbnQscmV0cnk6ZmFsc2V9KTt9dGhyb3cgZXJyb3I7fX1zeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cmV2aXNpb247c3luY1N0YXRlLmxhc3RTeW5jQXQ9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO3N5bmNTdGF0ZS5sYXN0RXJyb3I9IiI7c2F2ZVN5bmNTdGF0ZSgpO2lmKCFzaWxlbnQpdG9hc3QoIkFsbGUgR2Vyw6R0ZSBhdWYgYWt0dWVsbGVtIFN0YW5kIik7cmV0dXJuIHRydWU7fWNhdGNoKGVycm9yKXtzeW5jU3RhdGUubGFzdEVycm9yPWVycm9yLm1lc3NhZ2U7c2F2ZVN5bmNTdGF0ZSgpO2lmKCFzaWxlbnQpdG9hc3QoYFN5bmM6ICR7ZXJyb3IubWVzc2FnZX1gKTtyZXR1cm4gZmFsc2U7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBmdW5jdGlvbiBkaXNjb25uZWN0U3luYygpe2lmKCFjb25maXJtKCJEaWVzZXMgR2Vyw6R0IGxva2FsIHZvbSBFbGRlaG9mLVN5bmMgdHJlbm5lbj8gRGllIERhdGVuIGF1ZiBkZW0gR2Vyw6R0IGJsZWliZW4gZXJoYWx0ZW4uIikpcmV0dXJuO3N5bmNTdGF0ZT17Y29uZmlndXJlZDpmYWxzZSx2YXVsdElkOiIiLGRldmljZUlkOiIiLGRldmljZU5hbWU6IiIsZGV2aWNlVG9rZW46IiIscmVjb3ZlcnlLZXk6IiIscm9sZToibWVtYmVyIixzY29wZToiZnVsbCIsc2VydmVyUmV2aXNpb246MCxsYXN0U3luY0F0OiIiLGxhc3RFcnJvcjoiIn07c2F2ZVN5bmNTdGF0ZSgpO3NjaGVkdWxlU3luY1BvbGwoKTtyZW5kZXJTeW5jUGFuZWwoKTt0b2FzdCgiR2Vyw6R0IHZvbSBTeW5jIGdldHJlbm50Iik7fQogIGZ1bmN0aW9uIHJlbmRlclN5bmNQYW5lbCgpe2lmKCEkKCJzeW5jUGFuZWwiKSlyZXR1cm47JCgic3luY1NldHVwQm94IikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIixzeW5jU3RhdGUuY29uZmlndXJlZCk7JCgic3luY0FjdGl2ZUJveCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIXN5bmNTdGF0ZS5jb25maWd1cmVkKTtjb25zdCBiYWRnZT0kKCJzeW5jQmFkZ2UiKTtiYWRnZS5jbGFzc05hbWU9YHN5bmMtYmFkZ2UgJHtzeW5jQnVzeT8iYnVzeSI6c3luY1N0YXRlLmxhc3RFcnJvcj8iZXJyb3IiOnN5bmNTdGF0ZS5jb25maWd1cmVkPyJvayI6IiJ9YDtiYWRnZS50ZXh0Q29udGVudD1zeW5jQnVzeT8ic3luY2hyb25pc2llcnQg4oCmIjpzeW5jU3RhdGUubGFzdEVycm9yPyJGZWhsZXIiOnN5bmNTdGF0ZS5jb25maWd1cmVkPyJ2ZXJidW5kZW4iOiJuaWNodCBlaW5nZXJpY2h0ZXQiO2lmKCFzeW5jU3RhdGUuY29uZmlndXJlZClyZXR1cm47JCgic3luY0RldmljZVRleHQiKS50ZXh0Q29udGVudD1zeW5jU3RhdGUuZGV2aWNlTmFtZXx8ImRpZXNlcyBHZXLDpHQiOyQoInN5bmNSb2xlVGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5yb2xlPT09ImFkbWluIj8iVmVyd2FsdHVuZ3NnZXLDpHQiOiJnZWtvcHBlbHRlcyBHZXLDpHQiOyQoInN5bmNSZXZpc2lvblRleHQiKS50ZXh0Q29udGVudD1TdHJpbmcoc3luY1N0YXRlLnNlcnZlclJldmlzaW9ufHwwKTskKCJzeW5jTGFzdFRleHQiKS50ZXh0Q29udGVudD1zeW5jU3RhdGUubGFzdFN5bmNBdD9genVsZXR6dCAke2Zvcm1hdERhdGVUaW1lKHN5bmNTdGF0ZS5sYXN0U3luY0F0KX1gOiJub2NoIG5pZSI7JCgic3luY1N0YXR1cyIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5sYXN0RXJyb3I/YExldHp0ZXIgRmVobGVyOiAke3N5bmNTdGF0ZS5sYXN0RXJyb3J9YDoiw4RuZGVydW5nZW4gd2VyZGVuIGF1dG9tYXRpc2NoIGFiZ2VnbGljaGVuLiI7JCgic3luY1N0YXR1cyIpLmNsYXNzTmFtZT1gc3RhdHVzLXRleHQgJHtzeW5jU3RhdGUubGFzdEVycm9yPyJlcnJvciI6Im9rIn1gOyQoInN5bmNQYWlyQnRuIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIixzeW5jU3RhdGUucm9sZSE9PSJhZG1pbiIpO30KCiAgZnVuY3Rpb24gc2F2ZUNvc3RTZXR0aW5ncygpeyBzZXR0aW5ncy5mYWxsYmFja1ByaWNlPU1hdGgubWF4KDAsTnVtYmVyKCQoImZhbGxiYWNrUHJpY2VJbnB1dCIpLnZhbHVlKXx8MCk7c2V0dGluZ3MuZGVmYXVsdEJhc2VGZWU9TWF0aC5tYXgoMCxOdW1iZXIoJCgiZGVmYXVsdEJhc2VGZWVJbnB1dCIpLnZhbHVlKXx8MCk7c2F2ZVNldHRpbmdzKCk7c2NoZWR1bGVDbG91ZFN5bmMoKTtyZW5kZXJBbGwoKTt0b2FzdCgiS29zdGVuLUVpbnN0ZWxsdW5nZW4gZ2VzcGVpY2hlcnQiKTsgfQoKICBmdW5jdGlvbiByZW5kZXJBbGwoKXsgdXBkYXRlUmVjb3ZlcnlCYW5uZXIoKTtyZW5kZXJEYXNoYm9hcmQoKTtyZW5kZXJSZWNvcmRzKCk7cmVuZGVyQW5hbHlzaXMoKTtyZW5kZXJEYXRhKCk7IH0KICBmdW5jdGlvbiByZXNpemVDaGFydHMoKXsgY2xlYXJUaW1lb3V0KHJlc2l6ZVRpbWVyKTtyZXNpemVUaW1lcj1zZXRUaW1lb3V0KCgpPT57IGlmKGN1cnJlbnRWaWV3PT09ImRhc2hib2FyZFZpZXciKXJlbmRlckRhc2hib2FyZCgpOyBpZihjdXJyZW50Vmlldz09PSJhbmFseXNpc1ZpZXciKXJlbmRlckFuYWx5c2lzKCk7IH0sMTAwKTsgfQoKICBmdW5jdGlvbiBiaW5kKCl7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXZlbnQ9PnsKICAgICAgY29uc3QgbmF2PWV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1uYXZdIik7IGlmKG5hdil7c3dpdGNoVmlldyhuYXYuZGF0YXNldC5uYXYpO3JldHVybjt9CiAgICAgIGNvbnN0IGVkaXQ9ZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLWVkaXQtbW9udGhdIik7IGlmKGVkaXQpe29wZW5SZWNvcmRNb2RhbChlZGl0LmRhdGFzZXQuZWRpdE1vbnRoKTtyZXR1cm47fQogICAgICBpZihldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtY2xvc2UtcmVjb3JkLW1vZGFsXSIpKXtjbG9zZVJlY29yZE1vZGFsKCk7cmV0dXJuO30KICAgICAgaWYoZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLWNsb3NlLW1ldGVyLW1vZGFsXSIpKXtjbG9zZU1ldGVyTW9kYWwoKTtyZXR1cm47fQogICAgfSk7CiAgICAkKCJkYXNoYm9hcmRBZGRCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsb3Blbk1ldGVyTW9kYWwpOyAkKCJhZGRSZWNvcmRCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsb3Blbk1ldGVyTW9kYWwpOyAkKCJhZGRNZXRlckJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7CiAgICAkKCJlZGl0TGF0ZXN0QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5vcGVuUmVjb3JkTW9kYWwoJCgiZWRpdExhdGVzdEJ0biIpLmRhdGFzZXQubW9udGgpKTsKICAgICQoInJlY29yZEZvcm0iKS5hZGRFdmVudExpc3RlbmVyKCJzdWJtaXQiLHNhdmVFZGl0ZWRSZWNvcmQpOyBbInJlY29yZFRvdGFsIiwicmVjb3JkSGVhdFB1bXAiLCJyZWNvcmRBbm5leCJdLmZvckVhY2goaWQ9PiQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoImlucHV0Iix1cGRhdGVEZXJpdmVkUHJldmlldykpOwogICAgJCgibWV0ZXJGb3JtIikuYWRkRXZlbnRMaXN0ZW5lcigic3VibWl0IixzYXZlTWV0ZXJSZWFkaW5nRnJvbUZvcm0pOyBbIm1ldGVyRGF0ZSIsIm1ldGVyVG90YWwiLCJtZXRlckFubmV4Il0uZm9yRWFjaChpZD0+JChpZCkuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLHVwZGF0ZU1ldGVyUHJldmlldykpOwogICAgJCgidW5kb0xhdGVzdE1ldGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHVuZG9MYXRlc3RNZXRlclJlYWRpbmcpOwogICAgJCgicmVjb3JkWWVhckZpbHRlciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIscmVuZGVyUmVjb3Jkcyk7ICQoImFuYWx5c2lzWWVhciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIscmVuZGVyQW5hbHlzaXMpOwogICAgJCgicmVzdG9yZVNoYWRvd0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixyZXN0b3JlU2hhZG93KTsgJCgiZXhwb3J0QmFja3VwQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV4cG9ydEJhY2t1cCk7ICQoImV4cG9ydENzdkJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixleHBvcnRDc3YpOyAkKCJpbXBvcnRCYWNrdXBJbnB1dCIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsKCk9Pntjb25zdCBmPSQoImltcG9ydEJhY2t1cElucHV0IikuZmlsZXM/LlswXTtpZihmKWltcG9ydEJhY2t1cChmKTt9KTsKICAgICQoInZhaWxsYW50Q3N2RmlsZXNJbnB1dCIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsKCk9PmltcG9ydFZhaWxsYW50Q3N2RmlsZXMoJCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikuZmlsZXMpKTsKICAgICQoInNhdmVPc3Ryb21CdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsc2F2ZUFuZENoZWNrT3N0cm9tKTsgJCgiZGlzY29ubmVjdE9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixkaXNjb25uZWN0T3N0cm9tKTsgJCgicmVmcmVzaE9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+cmVmcmVzaE9zdHJvbSh0cnVlKSk7ICQoInJlZnJlc2hPc3Ryb21IaXN0b3J5QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5yZWZyZXNoT3N0cm9tSGlzdG9yeSgpKTsgJCgicmVmcmVzaE9zdHJvbVByaWNlU3RhdHNCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PnJlZnJlc2hPc3Ryb21QcmljZVN0YXRzKE51bWJlcigkKCJhbmFseXNpc1llYXIiKS52YWx1ZSl8fG5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSkpOyAkKCJnb09zdHJvbVNldHRpbmdzQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT57c3dpdGNoVmlldygiZGF0YVZpZXciKTtzZXRUaW1lb3V0KCgpPT4kKCJvc3Ryb21TZXR0aW5nc1BhbmVsIikuc2Nyb2xsSW50b1ZpZXcoe2JlaGF2aW9yOiJzbW9vdGgiLGJsb2NrOiJzdGFydCJ9KSwxMDApO30pOwogICAgJCgic3luY0NyZWF0ZUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixjcmVhdGVTeW5jVmF1bHQpOyAkKCJzeW5jSm9pbkJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixqb2luU3luY1ZhdWx0KTsgJCgic3luY05vd0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+c3luY05vdyh7c2lsZW50OmZhbHNlfSkpOyAkKCJzeW5jUGFpckJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixjcmVhdGVTeW5jUGFpcmluZyk7ICQoInN5bmNEaXNjb25uZWN0QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGRpc2Nvbm5lY3RTeW5jKTsKICAgICQoInNhdmVDb3N0U2V0dGluZ3NCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsc2F2ZUNvc3RTZXR0aW5ncyk7CiAgICAkKCJsb2FkQ2xpbWF0ZVdlYXRoZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsbG9hZENsaW1hdGVXZWF0aGVyKTsKICAgICQoImRhc2hib2FyZENsaW1hdGVXZWF0aGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGxvYWRDbGltYXRlV2VhdGhlcik7CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlRGV0YWlsc0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+e3N3aXRjaFZpZXcoImFuYWx5c2lzVmlldyIpO3NldFRpbWVvdXQoKCk9PiQoImNsaW1hdGVBbmFseXNpc1BhbmVsIikuc2Nyb2xsSW50b1ZpZXcoe2JlaGF2aW9yOiJzbW9vdGgiLGJsb2NrOiJzdGFydCJ9KSw3MCk7fSk7CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlTW9udGhCdXR0b25zIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV2ZW50PT57Y29uc3QgYj1ldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtY2xpbWF0ZS1tb250aF0iKTtpZighYilyZXR1cm47ZGFzaGJvYXJkQ2xpbWF0ZVNlbGVjdGVkTW9udGg9Im1vbnRoLSIrU3RyaW5nKGIuZGF0YXNldC5jbGltYXRlTW9udGgpLnBhZFN0YXJ0KDIsIjAiKTtyZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7fSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1jbGltYXRlLXBlcmlvZF0iKS5mb3JFYWNoKGJ0bj0+YnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+e2Rhc2hib2FyZENsaW1hdGVQZXJpb2Q9YnRuLmRhdGFzZXQuY2xpbWF0ZVBlcmlvZDtkYXNoYm9hcmRDbGltYXRlU2VsZWN0ZWRNb250aD1udWxsO3JlbmRlckRhc2hib2FyZENsaW1hdGUoKTt9KSk7CiAgICBbImRhc2hib2FyZENsaW1hdGVUZW1wZXJhdHVyZUNoYXJ0IiwiZGFzaGJvYXJkQ2xpbWF0ZUVsZWN0cmljQ2hhcnQiXS5mb3JFYWNoKGlkPT4kKGlkKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXZlbnQ9PnsKICAgICAgY29uc3QgY2FudmFzPWV2ZW50LmN1cnJlbnRUYXJnZXQscmVjdD1jYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCksd2lkdGg9TWF0aC5tYXgoMjgwLE1hdGgucm91bmQocmVjdC53aWR0aHx8NjAwKSksbW9udGhzPWRhc2hib2FyZENvbXBhcmlzb25Nb250aHMoKTsKICAgICAgY29uc3QgaW5kZXg9TWF0aC5mbG9vcigoZXZlbnQuY2xpZW50WC1yZWN0LmxlZnQtNDcpLyh3aWR0aC00Ny0xMCkqbW9udGhzLmxlbmd0aCk7CiAgICAgIGlmKGluZGV4Pj0wJiZpbmRleDxtb250aHMubGVuZ3RoKXtkYXNoYm9hcmRDbGltYXRlU2VsZWN0ZWRNb250aD0ibW9udGgtIitTdHJpbmcobW9udGhzW2luZGV4XSkucGFkU3RhcnQoMiwiMCIpO3JlbmRlckRhc2hib2FyZENsaW1hdGUoKTt9CiAgICB9KSk7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigicmVzaXplIixyZXNpemVDaGFydHMpOyBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCJ2aXNpYmlsaXR5Y2hhbmdlIiwoKT0+e2lmKGRvY3VtZW50LmhpZGRlbilyZXR1cm47aWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtjb25zdCBhZ2U9RGF0ZS5ub3coKS1EYXRlLnBhcnNlKG9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0fHwiIik7aWYoIU51bWJlci5pc0Zpbml0ZShhZ2UpfHxhZ2U+MTAqNjBlMylyZWZyZXNoT3N0cm9tKGZhbHNlKTt9aWYoc3luY1N0YXRlLmNvbmZpZ3VyZWQpc3luY05vdyh7c2lsZW50OnRydWV9KTt9KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24iLGV2ZW50PT57aWYoZXZlbnQua2V5IT09IkVzY2FwZSIpcmV0dXJuO2lmKCEkKCJyZWNvcmRNb2RhbCIpLmNsYXNzTGlzdC5jb250YWlucygiaGlkZGVuIikpY2xvc2VSZWNvcmRNb2RhbCgpO2Vsc2UgaWYoISQoIm1ldGVyTW9kYWwiKS5jbGFzc0xpc3QuY29udGFpbnMoImhpZGRlbiIpKWNsb3NlTWV0ZXJNb2RhbCgpO30pOwogIH0KCiAgZnVuY3Rpb24gaW5pdCgpewogICAgYXBwbHlIaXN0b3JpY2FsU2VlZCgpO2Vuc3VyZU1ldGVyQmFzZWxpbmUoKTsKICAgIGJpbmQoKTtyZW5kZXJBbGwoKTtzY2hlZHVsZU9zdHJvbSgpO3NjaGVkdWxlU3luY1BvbGwoKTsKICAgIGlmKHNldHRpbmdzLm9zdHJvbUFwcEtleSl7IGNvbnN0IGFnZT1EYXRlLm5vdygpLURhdGUucGFyc2Uob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKTsgaWYoIW9zdHJvbUxpdmV8fCFOdW1iZXIuaXNGaW5pdGUoYWdlKXx8YWdlPjEwKjYwZTMpcmVmcmVzaE9zdHJvbShmYWxzZSk7IHNldFRpbWVvdXQoKCk9PnJlZnJlc2hPc3Ryb21IaXN0b3J5KHtzaWxlbnQ6dHJ1ZSxvbmx5TWlzc2luZzp0cnVlLG1heE1vbnRoczoyfSksNDIwMCk7IH0KICAgIGlmKHN5bmNTdGF0ZS5jb25maWd1cmVkKXNldFRpbWVvdXQoKCk9PnN5bmNOb3coe3NpbGVudDp0cnVlfSksNjUwKTsKICAgIGlmKCJzZXJ2aWNlV29ya2VyIiBpbiBuYXZpZ2F0b3Ipd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoImxvYWQiLCgpPT5uYXZpZ2F0b3Iuc2VydmljZVdvcmtlci5yZWdpc3Rlcigic3cuanM/dj02LjMuNCIpLmNhdGNoKCgpPT57fSkpOwogICAgY29uc29sZS5pbmZvKGBFbGRlaG9mICR7QVBQX0JVSUxEfWApOwogIH0KICBpbml0KCk7Cn0pKCk7Cg==","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/sw.js":{"body":"Y29uc3QgQ0FDSEU9ImVsZGVob2YtdjYtMy00LXdlYXRoZXItaGVhdC1wb3dlci0yMDI2MTAzMSI7CmNvbnN0IENPUkU9WyIuLyIsIi4vP3Y9Ni4zLjQiLCIuL2luZGV4Lmh0bWwiLCIuL3N0eWxlcy5jc3M/dj02LjMuNCIsIi4vYXBwLmpzP3Y9Ni4zLjQiLCIuL21hbmlmZXN0LndlYm1hbmlmZXN0IiwiLi9pY29uLTE5Mi5wbmciLCIuL2ljb24tNTEyLnBuZyJdOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImluc3RhbGwiLGV2ZW50PT57ZXZlbnQud2FpdFVudGlsKGNhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMuYWRkQWxsKENPUkUpKS50aGVuKCgpPT5zZWxmLnNraXBXYWl0aW5nKCkpKX0pOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImFjdGl2YXRlIixldmVudD0+e2V2ZW50LndhaXRVbnRpbChjYWNoZXMua2V5cygpLnRoZW4oa2V5cz0+UHJvbWlzZS5hbGwoa2V5cy5maWx0ZXIoaz0+ayE9PUNBQ0hFKS5tYXAoaz0+Y2FjaGVzLmRlbGV0ZShrKSkpKS50aGVuKCgpPT5zZWxmLmNsaWVudHMuY2xhaW0oKSkpfSk7CnNlbGYuYWRkRXZlbnRMaXN0ZW5lcigiZmV0Y2giLGV2ZW50PT57CiAgY29uc3QgdXJsPW5ldyBVUkwoZXZlbnQucmVxdWVzdC51cmwpOwogIGlmKGV2ZW50LnJlcXVlc3QubWV0aG9kIT09IkdFVCJ8fHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCIvYXBpLyIpKXJldHVybjsKICBldmVudC5yZXNwb25kV2l0aChmZXRjaChldmVudC5yZXF1ZXN0KS50aGVuKHJlc3BvbnNlPT57Y29uc3QgY29weT1yZXNwb25zZS5jbG9uZSgpO2NhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMucHV0KGV2ZW50LnJlcXVlc3QsY29weSkpO3JldHVybiByZXNwb25zZTt9KS5jYXRjaCgoKT0+Y2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4oY2FjaGVkPT5jYWNoZWR8fGNhY2hlcy5tYXRjaCgiLi9pbmRleC5odG1sIikpKSk7Cn0pOwo=","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/manifest.webmanifest":{"body":"ewogICJuYW1lIjogIkVsZGVob2YgNi4yLjEg4oCTIFZlcmJyYXVjaHNidWNoIiwKICAic2hvcnRfbmFtZSI6ICJFbGRlaG9mIiwKICAiZGVzY3JpcHRpb24iOiAiU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4g4oCTIG1pdCBrb21wYWt0ZXIgT3N0cm9tLVByZWlzw7xiZXJzaWNodC4iLAogICJzdGFydF91cmwiOiAiLi8/dj02LjIuMSIsCiAgInNjb3BlIjogIi4vIiwKICAiZGlzcGxheSI6ICJzdGFuZGFsb25lIiwKICAib3JpZW50YXRpb24iOiAicG9ydHJhaXQtcHJpbWFyeSIsCiAgImJhY2tncm91bmRfY29sb3IiOiAiIzA2MTAxYyIsCiAgInRoZW1lX2NvbG9yIjogIiMwNzExMWYiLAogICJpY29ucyI6IFsKICAgIHsic3JjIjoiaWNvbi0xOTIucG5nIiwic2l6ZXMiOiIxOTJ4MTkyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifSwKICAgIHsic3JjIjoiaWNvbi01MTIucG5nIiwic2l6ZXMiOiI1MTJ4NTEyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifQogIF0KfQo=","type":"application/manifest+json; charset=utf-8","cache":"no-cache"},"/icon-192.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFk0lEQVR42u3du24TQRiG4fVoBShpkKJ0hi6iTEqKKAURJbdASZcqN5AbSJWOkkuAEoUiSkFLSW/RWC6RKFxQWFrlZO96ZnbmP7xfGeWwh8ffzOx6ncnOwVFDbGU5XxT7W4HDbS/t/h6AiI4AiBICEKGBiNISAhCGAEQYwojSEgIQARCpV0IAIgAi9UoIQARApF4JAYgAiNQrIQARABEAEaWjGIAIgEi9EgIQSeOobotPLqe2T8nN+UzR1k7kPxdmXkwVTLmeHZMLaJ2b27OZYTHHV9MykiwDekzHNpqtPOWSZBPQXTpu0QyRlIVRFkNSAEEnQlIiIyOAoFOLkQVAnR7opDCKM6QbEHQkVFG6oTqA0COkitIBBfQYSHcky190Ld1Aqz2EzqhVNLyHlDUQespU0fAeSr8zH9Dj3JAOQOixaiigB0OiAaHHtqFQQA+pm81nIXEeHYq9FEitEtLaQAxeHgaygB4MKVjGE6sZBRD146eEaCAiDBD146qEaCCSdCkoMyDqx1sJ0UBEDCCT9fPp+g0lRAMl6TFmiEl0he7B0NoJeN7xy/Cwtfri59PfNvbx5HKa5fnozA1kYAK0uWwMVFHec8QQtrUPhjMApcrAEIBSTWAoJyDtV4DiNNz9qT9fD9VNg7Kse1rnL6DEIjG2NGMIK6pHaf0ASJYe5kDoScrF3xeeRQb00GoAqnaOu/pxa6iFzkh/yMnSLKAnY/04rKKAHhZ6KZ9TFtAzRv346aGAHnoIQKXP3MD68WCohQ5LMxqoqJ5t68d2FQX0sIUAKnduUurHpKGAHudbm/hh9QE9hevHWA+10GFp5reBSurJWz9mXgMBPeyLR0CFj/h49VPXUPq/e2rRUx3Zxe6/br/UzYcCeurWT6dH6VjWQqdmad3Xo3FpFtBTffaj+tUS0COqftTtdUBPlfrp1aPFUECPwO5RdAQCegrXz1Z65BtqoaNoFihwaRbQI7x+hL+uAnpkTn20HB9xQ9iQlpb8rudEPdzKIGN1D5Noy+d7Q2kZ1kMDiZ5xA4gYrx9rQ9jV2+/Dv/ns5/ux62fv9FuZbaCBSuuJ+P5t06unwDYASOvsZ4ge5kCEAIj6AZCouNIDoMz1400PgLKSsn7JB0Cjz34ARKif7cLN1HsZcmVvcf0BPTRQpJ4nJ84GLigDqJCeB/XTLbvcGgIQAVBUIu6Er6ufktsAIBEg0s/ck3oKbwOrsPqlElc/G7rHBguGsBHj8H4FgLLVD3oARABE/QCIqQ+AHNUPegBE9wCo3uyHAIj6AVDx+kEPgOgeABEAEQARAiACIAIgAiBCsgM6vppyQFVkdaZ+fPwlBdDN+azk/qv+R+vG9oshjLgEZK+ElO5R4Iivkvg4TuKP6309THYOjnL9rpPLadM0t2ezwvuQ8X+vxD3inqKnPJ2MM+jGxoOFGc/B893XjKfbDWHL+YKZIEmaAy3niyyMVot5rgZJTt7x694kmioiqaswDJHUZXzicMYo5mr8atZdB6KKSBKglCqihPzUT9N7JZoqIkmA4qqIEnJSP83we2FxVYQhOXqqNVBcFRV+hxDpzRj100TcjR/OiIHM9uAVCSiijTBkVU+T+H6gXkYMZFanPnkADWHEQGZy6pMTUC8jDJkcvFaZPHv5aozf2+7vPfhKrfcrokdHA/UWEj1kT8+IDbSukOihArPmYnrKAboraWUIRgb0NOUf61nOF90eMpxp11Ohgbq8+3JID6mmUxkQjAzoqQ/oriEYRdCpq0cEIBgppSMLEIyGuxFCRyKgx4ycY3q8UJVDRy6gdYw8YFp3aUOaGwWAeiV5iFg3mgC58iRfjHpARFT4jEQCIAIgAiACIEIARABEAEQARAiACIAIgAiACAEQARABEAEQIQAiACIAIgAibvMfGKe/xgpKwHYAAAAASUVORK5CYII=","type":"image/png","cache":"public, max-age=31536000, immutable"},"/icon-512.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAPpUlEQVR42u3dvW5UVxcG4OORFUWkiYToSIkooaRAFEEucwsp6VxxA9wAlTvKXEJSIlIgCtqU9CiN5TJSChcpiCw09gwz4/Oz93qfp8ynLzFnznnftc62zdGdB48HgIouzy9chC1WLgGAAgAo5fjeXRdBAQCgAABLAAoA0AEKAAAFAGAJUAAAOkABAKAAACwBCgAABQBgCVAAACgAAEuAAgDQAQoAAAUAYAlQAAAoAABLgAIAQAEAWAIUAAAKAMASoAAAUAAAlgAFAKADFAAACgAgfglQAAA2AABLgAIAQAEAoAAAqot6C6QAAGwAACQtAQoAwAYAQNISoAAAbAAAJC0BCgDABgBA0hKgAABsAAAoAACG6m+BFACADQCApCVAAQDYAABIWgIUAIANAAAFAMDXSr4FUgAANgAAFAAAa+q9BVIAADYAAJKWAAUAYAMAQAEAcKNKb4EUAEBqmbkEIZ69vu8isKP3Lz+7CAmO7jx47CrIelAMe7k8v1AAiHv0gQJQAAh9lIECUADIfZSBDlAACH00gQJQACyd+x9OneCxk6dnI99+JZtAAdBi9At6mm2FYk3QewcogAq5L/HprhJqNIECYJnoF/oUKIPea0ABMF/0C31KNkHXNdB1BygAuQ9NlEGnNaAAmCT65T5qQAEogLj0F/2EN0FfNdBvByiAhqJf7qMJeqwBBYDoh9AaUACIfpiqBhrvAAXA3ukv+qFMDXTaAQpA9IMaUABMn/6iH25fAw12gAIQ/aIfcmugxw5QAJOnv+iHhA5QANJf+sOsNdBOBygA0S/6IbQGeiyAlRtL+kP7tj9TLfzNqcf37toA0tNf9MNSq8Die0B3S4ACMPiDDlAASH/ovwMWrAEFkJj+oh+sAj12gENg6Q+92vL0tXAsrACkP6ADGuUV0IHpL/qhHe28C+rrFZACkP5QvAbm7ABnANIfWMCmZ3POd0F9/TiYApD+oANCKQDpDzpAASD9QQcoAOkv/UEHKADpL/1BB+yho3NgBSD9QQfYAKS/9IeYDkABuG8g9Fm2BCiAjfeB9AcdoACkP5CVALfXyznwymcPxC4B4TngFZDxHzzdCsD47/6AyA6IXQJCC0D6gw7QAYkF4NU/IBkGZwDGf/C8T6GLbwSKKwAvf4DBi6DAApD+gA7I3QAAiCsA4z9gCUgsAOkP6IDcDQCAuAIw/gPzLwHtfyfoyucNYAMIGv8BZlgCFIDxH5AMCsD4D8gQBbDUJ2f8BywBERsAgCUgrgCM/4AlwAYAsMwS0PiPAgQVgPEfkBX1C8A3/wBSxQZg/AckRkwBGP8B2WIDMP4DciOmAIz/gISxARj/AemRXQAA1C8A738AOWMDSNngABmiAIz/gLSxARj/gWaSpOVfB+QQmGgv3j10EYhVpAC8/+Hg9NcBxGZO2Q3A+x92n/11AJl5cuyjJTn61/7hm+efXB9yOANA+u/6v4ICaM71l3He/3BwvusAbnQ9VQocA9gAkP46ABsASH8dQJLuD4F9AygTRbljYXbJn/cvO37hXHADcADAiIO8VYDC2eIVENJfBxBKASD9dQAKoEMOAJgtr3UA9VKo2k8COwAQ/VP/yx0LJ/tw+vnpmb8QBsLS3ypAPQoA6a8DUAAg/XUACgCkvw6gvKM7Dx53+qX7HXA0EsGOhdNcPwfe/vPAl+cXNgCoOYBbBeiUAkD6z/H1/P37I58aCgBqTtz2ABQA5Obspq/N+E+b/J3AiP7xv0jHwtgAICv9b/xqjf8ogJH5NXDS39eMRLIB/M8PAUj/Br9y439JZdLGKyCkP4RSAEj/qbz653sfIi3zXUCIfrABgPSfcvzXaigAyJ39dQAKAIrn45a3/zoABQC5yagDojT7u6AHh8AIxDnH/7U/st8YgQ0A6e/PDgoACRgw/usAFADSX/a5DigApF7k+K8DWJZDYER/Q5fFsTA2AKR/0PivHVEASH9cJRQAci1y/NcBKACkP64Yc3AIjCBra/xfu3SOhbEBIP1dQ/rT8i8CUgBIrkbHfx2AAkD643qiAJBWkeO/DmA6DoERUp1dXsfC2ACQ/kHjv5ZFASD9cbVRAMijyPFfB6AAkP648q1r/IcABofACKAex/+1j8CxMDYApL/PAhQAEidg/PeJoACQNfhcUABImcjx36fDYRwCI1wKfkyOhbEBIP2Dxn+fV1Pa/x5QBYA08alhAwA5UmX899mhAJAg+ATZxiEwgqPm+L/2UToWxgaA9PeZggJAUgSM/z7ZRXTxLUAKABnh88UGANKh9PjvU+Y6h8AIhdCP27EwNgCkf9D473NHASAF8OlPpZcTYAXg+ff8h47/7gEUgPQHd0Iuh8AeeHLH/7VbwrGwDQDpj3sDBYAn3PjvDmEfHZ0AKwDPNrhPbAB4qokf/90taRwCe5hh423jWNgGgPQ3/rt/UAB4enEXsUFfJ8CDV0CeW2Yb/1teL1798O/2e8m7IBsA0p+Kzbc1/d1RCgDpb/zPTX/3VVVeAYl+2O8G8zroRt0dANgApD/Gf3daLgUg/UmtvYPS3/2mAJD+xv/c9HfXKQCkP7np796rwSGw6Df+S//b3oSOhW0ASH/cjSgAPG/G/4Dx3z2pAJD+pKe/O1MBIP2N/7np7/7skUNg0Y/0H/9GdSxsA0D6G/+z0t8dqwDwLIH7VgHgKTL+543/7l4FgOeH6PR3D7fPIbDoN/5L/zluZsfCNgCkP1np765WAHhOjP/R6e/eVgB4QnCHu8MVAJ4N43/Y+O8+b5BDYI8E0n+ZG96xsA0A6W/8z0p/d74CwDNAdPq7/1vgFdDCJt2CPV0h4//U6e9djQ0AAAUAxv+Y8R8FAEh/FAAY/6U/JTgExoDcZRVJf2wAkLiISH8UAAAKAIz/oACgcp1IfxQABI7/0h8FAGZ/UACQMf5LfxQAAAoAjP9wO34SmG87e/J2hv/K6ccTl/q6u8//cIWxAVA5/ef8D3U0/o+Y/sWuMAqAaqEsoaZLf1cYBUDrYVEgoUYZ/6dIfx2AAqD1mJBQrjAKAIz/oAAghvRHAUDi+C/9UQBg9gcFABnjv/RHAQCgAMD4DwoACpP+KABIHP+lPwoAzP6gACBj/Jf+KAAAFADEjP/+ki8UAETWhvRHAUDg+C/9UQBg9gcFADHjPygAMP6DAoCM8V/6owDA7A8KADLGf+lPs45dAoo5e/J22gJ494v0xwYAcel/sU/6z/D1gAKA4ezJ29bS9suve9MBKADo3l7j/9e/7FMHoABgwvG/wdm/5a8QFADSf/zxf9Mv+tcBKACozF/zggKAUvb95h9QAGD8BwUA1cd/6Y8CALM/KAA4yOnHk77G/+7Sv6krjAJARsTN/q4wCgAd0Pf47wqjANABidl0+5c/rjAKgPQOOP140lo2fXP8H+vVf+wVZnH+PgCMjcvM/q4wNgBo0fbx3zd9ogDA7A8KAGLGf1AAYPwHBQAZ47/0RwGA2R8UAGSM/9IfBQBmf1AAEDP+gwIA4z8oAMgY/6U/CgDM/qAAIGP8l/4oADD7gwKAmPEfFAAY/0EBQMb4L/1RAGD2BwUAGeO/9EcBgNkfFADEjP+gAMD4DwoAMsZ/6Y8CALM/KADIGP+lPygAzP6gACBm/AcUAMZ/UACQMf5Lf1AAmP1BAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAK45v3Lz2v/5OnZfR8nMIPrafPnr38pAAAUAAAKAAAFAIACAEABAKAAbsV3gq558/yTi4C7SM4ULIDrPwoAML9Ofwhg8AoIIJYCsL+D+0cBAKAAMMSBO0cBNM2vhPMk456ZU5lfA2cDAKS/DQCPdM9OP574Ot0qKAA82LhJ2NXRnQePe/8zPHu9/lbuw6mfEdvmxbuH9f5QZ0/eGv+l/6SKHQDYAEx5dbScsNIfBUBbT3u9B77NnG0//UveDOyi5iugwVugPVV6KdTOu6DGo1/o7+XGbzHv/RVQhQIYHAMAsxdA7+k/DMPq8vzCRwsQaDUMgw4ACC2AAh3gd0IA0yn5/mf4+ruA7AEAiRtAyQ6wBACSZNcC+NIBndaAvyESmEeN9z/Dph8E8zoIoLyNPwlcowO8BQJkyN4FMHT4OshbIGBqZd7/DLv8LiCvgwDjf9wGUKMDvAUCjP+HF8DQz+sgb4EARi6ArlcBSwAgN25bAF10gCUAmEKx9z/DYX8hTI8/LGYJACTGCAXQ/ipgCQCM/xMWQHergCUAkBWjFUDLq4AlADD+T14AHa0ClgBASoxcAG2uApYAwPg/UwF0sQpYAgD5MEkBtLYKWAIA4/+sBdD4KmAJACTDhAXQTg3cuAToAOCbmVB7/J+8AK5qwO0FkFgAi68ClgDA+L9YASxeA06DAem/ZAFc1UDLHzxAiNUi/9VFVgEvggDj//IFsGANAEj/5Qtg/hqwBAA0VAAz14AOAIz/bRXAVQ00dTcA0l8BlFoFfEsoSH9aLIB5asCLICB8/G+3AGaoAR0Axv/k9G+9AObZBnQASH8FEFcDmw4DdACEpH+4VV9f7ug14EAYktM/efwfhuHoux9/6verP753d5R/z7PXN9wcH051A0h/G0D1hcCBMKSR/t0XwLg1oAMgZPyX/nUKYJQacCAMIenPlb7PALY47HjgxsOAwXkAFEp/43/BDWCUhcAeANLfBhC9ENgDQPrbAEIXAnsASH8bQPRCYA+AGtEv/RXAIU2gA0D6K4DcJtjUAWoApH/vVi7BF5sOCbb8siBHAiD9bQD1dwJ7AEh/BZDbBDoAeol+6a8Axvfzb4+2/K9qAAz+CiC3BnQASH8FoAOAWaNf+iuAJjpADYD0VwA6ABD9CkANANJfAaR1gBqAKaJf+isAHQAGfxSAGgCDPwqg5Q5QAyD6FYAaUAOwa/RLfwVQrQPUAIh+BaAG1ACiX/orADUAcl/0K4DMGtAEiH7RrwDUgBogK/dFvwJQA5oA0Y8CUAOagNKhL/oVgBp4dMD/SxnQe+6LfgXArWpAGdBd6Mt9BcAkTaAPaDDuRb8CYO4aUAwsm/VyXwHQYhPAPOS+AkAZIPdRAGgChD4KAGWA0EcBoBKQ+CgAtAKCHgUAwKRWLgGAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgAABQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAEv6D8v4I+AK37xrAAAAAElFTkSuQmCC","type":"image/png","cache":"public, max-age=31536000, immutable"}};

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
