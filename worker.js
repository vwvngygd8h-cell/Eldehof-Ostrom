const ELDEHOF_BUILD = "6.3.1-CLIMATE-DASHBOARD-WEATHERFIX-20261031";
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
  // Kronskamp near Neustadt-Glewe: stable WGS84 coordinates; no unreliable zip-code geocoding.
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
  // Eldehof's fixed location, shared by live weather and historical normalization.
  const location = {name:"Kronskamp",admin1:"Mecklenburg-Vorpommern",latitude:53.40209,longitude:11.58641,timezone:"Europe/Berlin"};
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

const EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjMuMCDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPconst EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjMuMSDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPGxpbmsgcmVsPSJpY29uIiBocmVmPSJpY29uLTE5Mi5wbmciPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0ic3R5bGVzLmNzcz92PTYuMy4xIj4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwLXNoZWxsIj4KICA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPgogICAgPGRpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPjxzcGFuIGNsYXNzPSJicmFuZC1tYXJrIj7ijII8L3NwYW4+PHNwYW4+RWxkZWhvZjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3VidGl0bGUiPlZlcmJyYXVjaHNidWNoPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJidWlsZC1waWxsIj42LjMuMTwvc3Bhbj4KICA8L2hlYWRlcj4KCiAgPG1haW4+CiAgICA8ZGl2IGlkPSJyZWNvdmVyeUJhbm5lciIgY2xhc3M9ImJhbm5lciB3YXJuaW5nIGhpZGRlbiIgcm9sZT0ic3RhdHVzIj4KICAgICAgPGRpdj48c3Ryb25nPkxva2FsZSBTaWNoZXJoZWl0c2tvcGllIGdlZnVuZGVuPC9zdHJvbmc+PHNwYW4+RGVyIG5vcm1hbGUgTW9uYXRzZGF0ZW5zcGVpY2hlciBpc3QgbGVlciwgYWJlciBlaW5lIGZyw7xoZXJlIGxva2FsZSBLb3BpZSBpc3Qgdm9yaGFuZGVuLjwvc3Bhbj48L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0icmVzdG9yZVNoYWRvd0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldpZWRlcmhlcnN0ZWxsZW48L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IGFjdGl2ZSIgaWQ9ImRhc2hib2FyZFZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGFzaGJvYXJkVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPsOcQkVSU0lDSFQ8L3NwYW4+PGgxIGlkPSJkYXNoYm9hcmRUaXRsZSI+VmVyYnJhdWNoIGF1ZiBlaW5lbiBCbGljazwvaDE+PHA+WsOkaGxlcnN0w6RuZGUsIFfDpHJtZXB1bXBlLCBPc3Ryb20tUHJlaXNlIHVuZCBLbGltYSBhdWYgZWluZW4gQmxpY2suPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJkYXNoYm9hcmRBZGRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBsYXRlc3QtcGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkxFVFpURVIgTU9OQVQ8L3NwYW4+PGgyIGlkPSJsYXRlc3RNb250aFRpdGxlIj5Ob2NoIGtlaW5lIE1vbmF0c3dlcnRlPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJlZGl0TGF0ZXN0QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QgaGlkZGVuIiB0eXBlPSJidXR0b24iPkJlYXJiZWl0ZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCIgaWQ9ImxhdGVzdE1ldHJpY3MiPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJjb21wYXJpc29uLWxpbmUiIGlkPSJsYXRlc3RDb21wYXJpc29uIj48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBvc3Ryb20tcGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPgogICAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+T1NUUk9NPC9zcGFuPjxoMj5QcmVpc8O8YmVyc2ljaHQ8L2gyPjxzbWFsbCBpZD0ib3N0cm9tU3RhdHVzIj5Ob2NoIG5pY2h0IGdlbGFkZW48L3NtYWxsPjwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBpZD0icmVmcmVzaE9zdHJvbUJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPkFrdHVhbGlzaWVyZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJvc3Ryb21TZXR1cEhpbnQiIGNsYXNzPSJlbXB0eS1zdGF0ZSBoaWRkZW4iPjxzdHJvbmc+T3N0cm9tIGlzdCBub2NoIG5pY2h0IGVpbmdlcmljaHRldC48L3N0cm9uZz48c3Bhbj5EZW4gRWxkZWhvZi1BcHAtU2NobMO8c3NlbCBmaW5kZXN0IGR1IHVudGVyIERhdGVuIOKGkiBPc3Ryb20uPC9zcGFuPjxidXR0b24gaWQ9ImdvT3N0cm9tU2V0dGluZ3NCdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5FaW5yaWNodGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ib3N0cm9tRGFzaGJvYXJkIiBjbGFzcz0ib3N0cm9tLWdyaWQiPgogICAgICAgICAgPGFydGljbGUgY2xhc3M9InByaWNlLWNhcmQgY3VycmVudCI+PHNwYW4+QWt0dWVsbGVyIFByZWlzPC9zcGFuPjxzdHJvbmcgaWQ9Im9zdHJvbUN1cnJlbnRQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21DdXJyZW50TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8YXJ0aWNsZSBjbGFzcz0icHJpY2UtY2FyZCBiZXN0Ij48c3BhbiBpZD0ib3N0cm9tQmVzdExhYmVsIj5CZXN0ZXMgWmVpdGZlbnN0ZXI8L3NwYW4+PHN0cm9uZyBpZD0ib3N0cm9tQmVzdFByaWNlIj7igJM8L3N0cm9uZz48c21hbGwgaWQ9Im9zdHJvbUJlc3RNZXRhIj7igJM8L3NtYWxsPjwvYXJ0aWNsZT4KICAgICAgICAgIDxhcnRpY2xlIGNsYXNzPSJwcmljZS1jYXJkIHdvcnN0Ij48c3BhbiBpZD0ib3N0cm9tV29yc3RMYWJlbCI+U2NobGVjaHRlc3RlcyBaZWl0ZmVuc3Rlcjwvc3Bhbj48c3Ryb25nIGlkPSJvc3Ryb21Xb3JzdFByaWNlIj7igJM8L3N0cm9uZz48c21hbGwgaWQ9Im9zdHJvbVdvcnN0TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBwcmljZS1jaGFydC13cmFwIj48Y2FudmFzIGlkPSJvc3Ryb21NaW5pQ2hhcnQiIGFyaWEtbGFiZWw9Ik9zdHJvbSBQcmVpc3ZlcmxhdWYiPjwvY2FudmFzPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgZGFzaGJvYXJkLWNoYXJ0LXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5WRVJMQVVGPC9zcGFuPjxoMj5HZXNhbXR2ZXJicmF1Y2g8L2gyPjwvZGl2PjxidXR0b24gY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiBkYXRhLW5hdj0iYW5hbHlzaXNWaWV3IiB0eXBlPSJidXR0b24iPkF1c3dlcnR1bmcgw7ZmZm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAiPjxjYW52YXMgaWQ9ImRhc2hib2FyZENvbnN1bXB0aW9uQ2hhcnQiIGFyaWEtbGFiZWw9Ikdlc2FtdHZlcmJyYXVjaCBkZXIgbGV0enRlbiBNb25hdGUiPjwvY2FudmFzPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgZGFzaGJvYXJkLWNsaW1hdGUtcGFuZWwiIGlkPSJkYXNoYm9hcmRDbGltYXRlUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPgogICAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S0xJTUEgJmFtcDsgSEVJWlVORzwvc3Bhbj48aDI+V8Okcm1lICZhbXA7IFRlbXBlcmF0dXJlbjwvaDI+PHNtYWxsIGlkPSJkYXNoYm9hcmRDbGltYXRlWWVhciI+QWt0dWVsbGVzIEphaHI8L3NtYWxsPjwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBpZD0iZGFzaGJvYXJkQ2xpbWF0ZURldGFpbHNCdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5EZXRhaWxzIGFuc2VoZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBkYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzIiBpZD0iZGFzaGJvYXJkQ2xpbWF0ZU1ldHJpY3MiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRhc2hib2FyZC1jbGltYXRlLWNoYXJ0LXRvcCI+CiAgICAgICAgICA8c3Ryb25nPkxldHp0ZSBzZWNocyBNb25hdGU8L3N0cm9uZz4KICAgICAgICAgIDxkaXYgY2xhc3M9ImRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCIgcm9sZT0iZ3JvdXAiIGFyaWEtbGFiZWw9IktsaW1hLURpYWdyYW1tIj4KICAgICAgICAgICAgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJhY3RpdmUiIGRhdGEtZGFzaGJvYXJkLWNsaW1hdGUtbW9kZT0iaGVhdCIgYXJpYS1wcmVzc2VkPSJ0cnVlIj5Xw6RybWU8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGRhdGEtZGFzaGJvYXJkLWNsaW1hdGUtbW9kZT0idGVtcGVyYXR1cmUiIGFyaWEtcHJlc3NlZD0iZmFsc2UiPlRlbXBlcmF0dXJlbjwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBkYXNoYm9hcmQtY2xpbWF0ZS1jaGFydC13cmFwIj48Y2FudmFzIGlkPSJkYXNoYm9hcmRDbGltYXRlQ2hhcnQiIGFyaWEtbGFiZWw9IkhlaXp3w6RybWUgdW5kIFdpdHRlcnVuZ3NiZXJlaW5pZ3VuZyBkZXIgbGV0enRlbiBzZWNocyBNb25hdGUiPjwvY2FudmFzPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImRhc2hib2FyZENsaW1hdGVMZWdlbmQiIGNsYXNzPSJkYXNoYm9hcmQtY2xpbWF0ZS1sZWdlbmQiPjwvZGl2PgogICAgICAgIDxwIGlkPSJkYXNoYm9hcmRDbGltYXRlVHJlbmQiIGNsYXNzPSJkYXNoYm9hcmQtY2xpbWF0ZS10cmVuZCI+PC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImRhc2hib2FyZC1jbGltYXRlLWZvb3RlciI+CiAgICAgICAgICA8cCBpZD0iZGFzaGJvYXJkQ2xpbWF0ZVN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0IiByb2xlPSJzdGF0dXMiPjwvcD4KICAgICAgICAgIDxidXR0b24gaWQ9ImRhc2hib2FyZENsaW1hdGVXZWF0aGVyQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+V2V0dGVyZGF0ZW4gbGFkZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iY29uc3VtcHRpb25WaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImNvbnN1bXB0aW9uVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlZFUkJSQVVDSDwvc3Bhbj48aDEgaWQ9ImNvbnN1bXB0aW9uVGl0bGUiPk1vbmF0c3dlcnRlPC9oMT48cD5HZXNhbXQtIHVuZCBBbHRlbnRlaWwtVmVyYnJhdWNoIGVudHN0ZWhlbiBhdXMgZGVuIFrDpGhsZXJzdMOkbmRlbi4gV8Okcm1lcHVtcGUga29tbXQgYXVzIGRlciBteVZBSUxMQU5ULUNTVjsgU2NobGVlL0tsdXMgd2lyZCBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJhZGRSZWNvcmRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdG9vbGJhciI+PHN0cm9uZyBpZD0icmVjb3JkQ291bnQiPjAgTW9uYXRlPC9zdHJvbmc+PHNlbGVjdCBpZD0icmVjb3JkWWVhckZpbHRlciIgYXJpYS1sYWJlbD0iSmFociBmaWx0ZXJuIj48b3B0aW9uIHZhbHVlPSJhbGwiPkFsbGUgSmFocmU8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJyZWNvcmRMaXN0IiBjbGFzcz0icmVjb3JkLWxpc3QiPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJhbmFseXNpc1ZpZXciIGFyaWEtbGFiZWxsZWRieT0iYW5hbHlzaXNUaXRsZSI+CiAgICAgIDxkaXYgY2xhc3M9InBhZ2UtaGVhZCI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+QVVTV0VSVFVORzwvc3Bhbj48aDEgaWQ9ImFuYWx5c2lzVGl0bGUiPlZlcmJyYXVjaCB2ZXJzdGVoZW48L2gxPjxwPkphaHJlc3dlcnRlLCBBdWZ0ZWlsdW5nLCBLb3N0ZW4gdW5kIFfDpHJtZXB1bXBlbi1FZmZpemllbnouPC9wPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGZpbHRlci1wYW5lbCI+CiAgICAgICAgPGxhYmVsPkRldGFpbGphaHI8c2VsZWN0IGlkPSJhbmFseXNpc1llYXIiPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0iYW5hbHlzaXMtYWxsLXllYXJzLWhpbnQiPjxzdHJvbmc+TWVocmphaHJlc3ZlcmdsZWljaDwvc3Ryb25nPjxzcGFuPkFsbGUgdm9yaGFuZGVuZW4gSmFocmUgd2VyZGVuIGdlbWVpbnNhbSBkYXJnZXN0ZWxsdC4gVmVyZ2FuZ2VuZSBKYWhyZSBnZXN0cmljaGVsdCwgZGFzIGFrdHVlbGxlIEphaHIgZHVyY2hnZXpvZ2VuLjwvc3Bhbj48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0ibWV0cmljLWdyaWQgYW5hbHlzaXMtbWV0cmljcyIgaWQ9ImFuYWx5c2lzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkFVRlRFSUxVTkc8L3NwYW4+PGgyPlfDpHJtZXB1bXBlIMK3IEFsdGVudGVpbCDCtyBTY2hsZWUvS2x1czwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ibGVnZW5kIj48c3BhbiBjbGFzcz0iaGVhdCI+V8Okcm1lcHVtcGU8L3NwYW4+PHNwYW4gY2xhc3M9ImFubmV4Ij5BbHRlbnRlaWw8L3NwYW4+PHNwYW4gY2xhc3M9InJlc3QiPlNjaGxlZS9LbHVzPC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImFsbG9jYXRpb25DaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1FSFJKQUhSRVNWRVJHTEVJQ0g8L3NwYW4+PGgyPkdlc2FtdHZlcmJyYXVjaCBuYWNoIE1vbmF0ZW48L2gyPjwvZGl2PjwvZGl2PjxkaXYgaWQ9InllYXJDb21wYXJpc29uTGVnZW5kIiBjbGFzcz0ieWVhci1jb21wYXJpc29uLWxlZ2VuZCI+PC9kaXY+PGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBsYXJnZSI+PGNhbnZhcyBpZD0idG90YWxDaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJvc3Ryb21QcmljZVN0YXRzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTS1QUkVJU0U8L3NwYW4+PGgyPsOYIGtXaC1QcmVpcyDCtyBNb25hdCDCtyBRdWFydGFsIMK3IEphaHI8L2gyPjwvZGl2PjxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21QcmljZVN0YXRzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+T3N0cm9tLVByZWlzZSBha3R1YWxpc2llcmVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EZXIgQXJiZWl0c3ByZWlzIHdpcmQgYXVzIGRlbiB2b24gT3N0cm9tIGdlbGllZmVydGVuIFN0dW5kZW5wcmVpc2VuIHVuZCBkZWluZW0gdGF0c8OkY2hsaWNoZW4gT3N0cm9tLVZlcmJyYXVjaCB2ZXJicmF1Y2hzZ2V3aWNodGV0IGJlcmVjaG5ldC4gUXVhcnRhbHMtIHVuZCBKYWhyZXN3ZXJ0ZSBzaW5kIGRhaGVyIGtlaW4gZWluZmFjaGVyIE1pdHRlbHdlcnQgZGVyIE1vbmF0ZS48L3A+CiAgICAgICAgPHNlY3Rpb24gY2xhc3M9Im1ldHJpYy1ncmlkIGFuYWx5c2lzLW1ldHJpY3MiIGlkPSJvc3Ryb21QcmljZVN0YXRzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9Im9zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0IiBhcmlhLWxhYmVsPSJEdXJjaHNjaG5pdHRsaWNoZXIgT3N0cm9tLUFyYmVpdHNwcmVpcyBwcm8gTW9uYXQiPjwvY2FudmFzPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk1vbmF0PC90aD48dGg+w5ggQXJiZWl0c3ByZWlzPC90aD48dGg+RWZmZWt0aXYgaW5rbC4gRml4a29zdGVuPC90aD48dGg+T3N0cm9tLVZlcmJyYXVjaDwvdGg+PHRoPlN0YXR1czwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0ib3N0cm9tUHJpY2VTdGF0c1RhYmxlIj48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgICAgPHAgaWQ9Im9zdHJvbVByaWNlU3RhdHNTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+PC9wPgogICAgICA8L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9ImNsaW1hdGVBbmFseXNpc1BhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5XSVRURVJVTkdTQkVSRUlOSUdVTkc8L3NwYW4+PGgyPkhlaXp3w6RybWUgJiBXZXR0ZXI8L2gyPjwvZGl2PjxidXR0b24gY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiBpZD0ibG9hZENsaW1hdGVXZWF0aGVyQnRuIiB0eXBlPSJidXR0b24iPldldHRlcmRhdGVuIGxhZGVuPC9idXR0b24+PC9kaXY+PHAgY2xhc3M9Im11dGVkIj5IZWl6Z3JhZHRhZ2UgKEJhc2lzIDE1IMKwQyksIGdldHJlbm50ZSBIZWl6LSB1bmQgV2FybXdhc3NlcnfDpHJtZS4gVmVyZ2xlaWNoIGplIEthbGVuZGVybW9uYXQgbWl0IGRlbiBIZWl6Z3JhZHRhZ2VuIHZvbiAyMDI0IHVuZCAyMDI1LjwvcD48ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBhbmFseXNpcy1tZXRyaWNzIiBpZD0iY2xpbWF0ZU1ldHJpY3MiPjwvZGl2PjxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk1vbmF0PC90aD48dGg+w5ggV2V0dGVyIMKwQzwvdGg+PHRoPlZhaWxsYW50IGF1w59lbiDCsEM8L3RoPjx0aD5SYXVtIMKwQzwvdGg+PHRoPlNwZWljaGVyIMKwQzwvdGg+PHRoPkhHVDwvdGg+PHRoPkhlaXp3w6RybWUga1doPC90aD48dGg+V2FybXdhc3NlciBrV2g8L3RoPjx0aD5XaXR0ZXJ1bmdzYmVyZWluaWd0IGtXaDwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0iY2xpbWF0ZVJvd3MiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj48cCBpZD0iY2xpbWF0ZUluZm8iIGNsYXNzPSJzdGF0dXMtdGV4dCI+PC9wPjxkaXYgaWQ9ImNsaW1hdGVNdWx0aVllYXIiIGNsYXNzPSJjbGltYXRlLXllYXItY29tcGFyaXNvbiI+PC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5Nb25hdGxpY2hlIFN0cm9ta29zdGVuPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJjb3N0Q2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0iY29wUGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlfDhFJNRVBVTVBFPC9zcGFuPjxoMj5BcmJlaXRzemFobDwvaDI+PC9kaXY+PC9kaXY+PHAgY2xhc3M9Im11dGVkIj5XaXJkIG51ciBhdXMgTW9uYXRlbiBtaXQgZG9rdW1lbnRpZXJ0ZXIgZXJ6ZXVndGVyIFfDpHJtZSBiZXJlY2huZXQuPC9wPjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImNvcENoYXJ0Ij48L2NhbnZhcz48L2Rpdj48L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+TU9OQVRFPC9zcGFuPjxoMj5KYWhyZXPDvGJlcnNpY2h0PC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPkdlc2FtdDwvdGg+PHRoPldQPC90aD48dGg+QWx0ZW50ZWlsPC90aD48dGg+U2NobGVlL0tsdXM8L3RoPjx0aD5Lb3N0ZW48L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImFuYWx5c2lzVGFibGUiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj48L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJkYXRhVmlldyIgYXJpYS1sYWJlbGxlZGJ5PSJkYXRhVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkRBVEVOPC9zcGFuPjxoMSBpZD0iZGF0YVRpdGxlIj5CYWNrdXAgJiBFaW5zdGVsbHVuZ2VuPC9oMT48cD5aw6RobGVyc3TDpG5kZSwgbXlWQUlMTEFOVC1JbXBvcnQsIFNpY2hlcnVuZyB1bmQgT3N0cm9tLjwvcD48L2Rpdj48L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+REFURU5RVUFMSVTDhFQ8L3NwYW4+PGgyPk1vbmF0c3dlcnRlIHByw7xmZW48L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIGNvbXBhY3QtbWV0cmljcyIgaWQ9InF1YWxpdHlNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJxdWFsaXR5SXNzdWVzIiBjbGFzcz0iaXNzdWUtbGlzdCI+PC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KCgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJtZXRlclBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDI+R2VzYW10ICYgQWx0ZW50ZWlsPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJhZGRNZXRlckJ0biIgY2xhc3M9InByaW1hcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj4rIEVpbnRyYWdlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RHUgdHLDpGdzdCBudXIgZGllIGJlaWRlbiBha3R1ZWxsZW4gWsOkaGxlcnN0w6RuZGUgZWluLiBFbGRlaG9mIGJlcmVjaG5ldCBkYXJhdXMgYXV0b21hdGlzY2ggZGVuIE1vbmF0c3ZlcmJyYXVjaC4gQXVzZ2FuZ3NwdW5rdCBpc3QgZGVyIDAxLjEwLjIwMjYgbWl0IEdlc2FtdCAzNC4yNTUga1doIHVuZCBBbHRlbnRlaWwgOS4wNDUga1doLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBtZXRlci1sYXRlc3QiIGlkPSJtZXRlckxhdGVzdCI+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibWV0ZXJIaXN0b3J5IiBjbGFzcz0ibWV0ZXItaGlzdG9yeSI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyBtZXRlci1hY3Rpb25zIj48YnV0dG9uIGlkPSJ1bmRvTGF0ZXN0TWV0ZXJCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+TGV0enRlbiBaw6RobGVyc3RhbmQgenVyw7xja25laG1lbjwvYnV0dG9uPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJ2YWlsbGFudEltcG9ydFBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5Xw4RSTUVQVU1QRTwvc3Bhbj48aDI+bXlWQUlMTEFOVC1EYXRlbiBpbXBvcnRpZXJlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5Xw6RobGUgYXJvVEhFUk0gdW5kIHVuaVRPV0VSIGdlbWVpbnNhbSBvZGVyIGRpZSDDpGx0ZXJlIEVsZGVob2YtTW9uYXRzaW1wb3J0LUNTVi4gRGllIFRlbXBlcmF0dXJkYXRlaWVuIGF1cyBTeXN0ZW0sIFpvbmUgMCB1bmQgV2FybXdhc3NlcnNwZWljaGVyIGvDtm5uZW4genVzw6R0emxpY2ggb2RlciBlaW56ZWxuIGltcG9ydGllcnQgd2VyZGVuLiBOdXIgTW9uYXRzYWdncmVnYXRlIHdlcmRlbiBnZXNwZWljaGVydC4gWsOkaGxlcnN0w6RuZGUgdW5kIFByZWlzZSBibGVpYmVuIHVudmVyw6RuZGVydC48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpbGUtYnV0dG9uIHByaW1hcnkiPkNTVi1EYXRlaWVuIGF1c3fDpGhsZW48aW5wdXQgaWQ9InZhaWxsYW50Q3N2RmlsZXNJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSIuY3N2LHRleHQvY3N2LHRleHQvcGxhaW4iIG11bHRpcGxlIGhpZGRlbj48L2xhYmVsPgogICAgICAgIDwvZGl2PgogICAgICAgIDxwIGlkPSJ2YWlsbGFudEltcG9ydFN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij5Ob2NoIGtlaW5lIERhdGVpZW4gYXVzZ2V3w6RobHQuPC9wPgogICAgICA8L3NlY3Rpb24+CgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ic3luY1BhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5HRVLDhFRFLVNZTkM8L3NwYW4+PGgyPkF1ZiBhbGxlbiBHZXLDpHRlbiBha3R1ZWxsPC9oMj48L2Rpdj48c3BhbiBpZD0ic3luY0JhZGdlIiBjbGFzcz0ic3luYy1iYWRnZSI+bmljaHQgZWluZ2VyaWNodGV0PC9zcGFuPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RWxkZWhvZiBzeW5jaHJvbmlzaWVydCBNb25hdHN3ZXJ0ZSwgWsOkaGxlcnN0w6RuZGUsIGltcG9ydGllcnRlIFZhaWxsYW50LVdlcnRlIHVuZCBiZXJlY2huZXRlIE9zdHJvbS1Lb3N0ZW4gdmVyc2NobMO8c3NlbHQgw7xiZXIgZGVuIGJlc3RlaGVuZGVuIENsb3VkZmxhcmUtVHJlc29yLiBOYWNoIGVpbmVyIMOEbmRlcnVuZyB3aXJkIGF1dG9tYXRpc2NoIGhvY2hnZWxhZGVuOyBiZWltIMOWZmZuZW4gb2RlciBadXLDvGNra2VocmVuIGluIGRpZSBBcHAgd2lyZCBhdXRvbWF0aXNjaCBkZXIgbmV1ZXN0ZSBTdGFuZCBnZWxhZGVuLjwvcD4KICAgICAgICA8ZGl2IGlkPSJzeW5jU2V0dXBCb3giPgogICAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkRpZXNlcyBHZXLDpHQgYmVuZW5uZW48aW5wdXQgaWQ9InN5bmNDcmVhdGVEZXZpY2VOYW1lIiB0eXBlPSJ0ZXh0IiBtYXhsZW5ndGg9IjYwIiBwbGFjZWhvbGRlcj0iei4gQi4gaVBhZCBLw7xjaGUiPjwvbGFiZWw+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPjxidXR0b24gaWQ9InN5bmNDcmVhdGVCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkdlcsOkdGUtU3luYyBlaW5yaWNodGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgICA8ZGV0YWlscyBjbGFzcz0ic3luYy1qb2luLWJveCI+PHN1bW1hcnk+RGllc2VzIEdlcsOkdCBtaXQgYmVzdGVoZW5kZW0gRWxkZWhvZiBrb3BwZWxuPC9zdW1tYXJ5PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJzZXR0aW5ncy1ncmlkIj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5UcmVzb3ItSUQ8aW5wdXQgaWQ9InN5bmNKb2luVmF1bHRJZCIgdHlwZT0idGV4dCIgYXV0b2NvbXBsZXRlPSJvZmYiPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+S29wcGx1bmdzY29kZTxpbnB1dCBpZD0ic3luY0pvaW5Db2RlIiB0eXBlPSJ0ZXh0IiBhdXRvY29tcGxldGU9Im9uZS10aW1lLWNvZGUiIHBsYWNlaG9sZGVyPSJYWFhYLVhYWFgtWFhYWCI+PC9sYWJlbD4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5XaWVkZXJoZXJzdGVsbHVuZ3NzY2hsw7xzc2VsPHRleHRhcmVhIGlkPSJzeW5jSm9pblJlY292ZXJ5IiByb3dzPSIzIiBhdXRvY29tcGxldGU9Im9mZiI+PC90ZXh0YXJlYT48L2xhYmVsPgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkRpZXNlcyBHZXLDpHQgYmVuZW5uZW48aW5wdXQgaWQ9InN5bmNKb2luRGV2aWNlTmFtZSIgdHlwZT0idGV4dCIgbWF4bGVuZ3RoPSI2MCIgcGxhY2Vob2xkZXI9InouIEIuIGlQaG9uZSI+PC9sYWJlbD4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxidXR0b24gaWQ9InN5bmNKb2luQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5HZXLDpHQga29wcGVsbjwvYnV0dG9uPgogICAgICAgICAgPC9kZXRhaWxzPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9InN5bmNBY3RpdmVCb3giIGNsYXNzPSJoaWRkZW4iPgogICAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQgc3luYy1tZXRyaWNzIj4KICAgICAgICAgICAgPGFydGljbGU+PHNwYW4+R2Vyw6R0PC9zcGFuPjxzdHJvbmcgaWQ9InN5bmNEZXZpY2VUZXh0Ij7igJM8L3N0cm9uZz48c21hbGwgaWQ9InN5bmNSb2xlVGV4dCI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPlRyZXNvci1WZXJzaW9uPC9zcGFuPjxzdHJvbmcgaWQ9InN5bmNSZXZpc2lvblRleHQiPjA8L3N0cm9uZz48c21hbGwgaWQ9InN5bmNMYXN0VGV4dCI+bm9jaCBuaWU8L3NtYWxsPjwvYXJ0aWNsZT4KICAgICAgICAgICAgPGFydGljbGU+PHNwYW4+QXV0b21hdGlrPC9zcGFuPjxzdHJvbmc+YWt0aXY8L3N0cm9uZz48c21hbGw+YmVpIEFwcC1TdGFydCwgUsO8Y2trZWhyIHVuZCBuYWNoIMOEbmRlcnVuZ2VuPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPjxidXR0b24gaWQ9InN5bmNOb3dCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkpldHp0IHN5bmNocm9uaXNpZXJlbjwvYnV0dG9uPjxidXR0b24gaWQ9InN5bmNQYWlyQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPk5ldWVzIEdlcsOkdCBrb3BwZWxuPC9idXR0b24+PGJ1dHRvbiBpZD0ic3luY0Rpc2Nvbm5lY3RCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+RGllc2VzIEdlcsOkdCB0cmVubmVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgICA8ZGl2IGlkPSJzeW5jUGFpclJlc3VsdCIgY2xhc3M9InN5bmMtcGFpci1yZXN1bHQgaGlkZGVuIj48c3Ryb25nPktvcHBsdW5nc2RhdGVuIGbDvHIgZGFzIG5ldWUgR2Vyw6R0PC9zdHJvbmc+PHNwYW4+VHJlc29yLUlEPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpclZhdWx0Ij7igJM8L2NvZGU+PHNwYW4+Q29kZSAoMTAgTWludXRlbik8L3NwYW4+PGNvZGUgaWQ9InN5bmNQYWlyQ29kZSI+4oCTPC9jb2RlPjxzcGFuPldpZWRlcmhlcnN0ZWxsdW5nc3NjaGzDvHNzZWw8L3NwYW4+PGNvZGUgaWQ9InN5bmNQYWlyUmVjb3ZlcnkiPuKAkzwvY29kZT48c21hbGwgaWQ9InN5bmNQYWlyRXhwaXJ5Ij48L3NtYWxsPjwvZGl2PgogICAgICAgICAgPHAgaWQ9InN5bmNTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+PC9wPgogICAgICAgIDwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlNJQ0hFUlVORzwvc3Bhbj48aDI+UHJpdmF0ZXMgQmFja3VwPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkRhcyBwcml2YXRlIEJhY2t1cCBlbnRow6RsdCBkZWluZSBWZXJicmF1Y2hzZGF0ZW4gdW5kIOKAkyBzb2Zlcm4gZ2VzcGVpY2hlcnQg4oCTIGF1Y2ggZGVuIE9zdHJvbS1BcHAtU2NobMO8c3NlbC4gTmljaHQgw7ZmZmVudGxpY2ggaG9jaGxhZGVuLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij4KICAgICAgICAgIDxidXR0b24gaWQ9ImV4cG9ydEJhY2t1cEJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+QmFja3VwIGV4cG9ydGllcmVuPC9idXR0b24+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpbGUtYnV0dG9uIHNlY29uZGFyeSI+QmFja3VwIGltcG9ydGllcmVuPGlucHV0IGlkPSJpbXBvcnRCYWNrdXBJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSJhcHBsaWNhdGlvbi9qc29uLC5qc29uIiBoaWRkZW4+PC9sYWJlbD4KICAgICAgICAgIDxidXR0b24gaWQ9ImV4cG9ydENzdkJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5DU1YgZXhwb3J0aWVyZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0iYmFja3VwU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ib3N0cm9tU2V0dGluZ3NQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+T1NUUk9NPC9zcGFuPjxoMj5QcmVpc8O8YmVyc2ljaHQgdmVyYmluZGVuPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5FbGRlaG9mLUFwcC1TY2hsw7xzc2VsPGlucHV0IGlkPSJvc3Ryb21BcHBLZXlJbnB1dCIgdHlwZT0icGFzc3dvcmQiIGF1dG9jb21wbGV0ZT0ib2ZmIiBwbGFjZWhvbGRlcj0iQXBwLVNjaGzDvHNzZWwiPjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5aZWl0ZmVuc3RlcjxzZWxlY3QgaWQ9InByZWZlcnJlZFdpbmRvd0hvdXJzSW5wdXQiPjxvcHRpb24gdmFsdWU9IjEiPjEgU3R1bmRlPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iMiI+MiBTdHVuZGVuPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iMyI+MyBTdHVuZGVuPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iNCI+NCBTdHVuZGVuPC9vcHRpb24+PC9zZWxlY3Q+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0ic3dpdGNoLXJvdyI+PGlucHV0IGlkPSJvc3Ryb21BdXRvUmVmcmVzaElucHV0IiB0eXBlPSJjaGVja2JveCI+PHNwYW4+QXV0b21hdGlzY2ggYWxsZSAxMCBNaW51dGVuIGFrdHVhbGlzaWVyZW48L3NwYW4+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzYXZlT3N0cm9tQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5TcGVpY2hlcm4gJiBwcsO8ZmVuPC9idXR0b24+PGJ1dHRvbiBpZD0icmVmcmVzaE9zdHJvbUhpc3RvcnlCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+SGlzdG9yaXNjaGUgUHJlaXNlIGxhZGVuPC9idXR0b24+PGJ1dHRvbiBpZD0iZGlzY29ubmVjdE9zdHJvbUJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5WZXJiaW5kdW5nIGVudGZlcm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGlkPSJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgICA8cCBpZD0ib3N0cm9tSGlzdG9yeVN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij5IaXN0b3Jpc2NoZSBQcmVpc2Ugbm9jaCBuaWNodCBnZXByw7xmdC48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5GYWxsYmFjay1XZXJ0ZTwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BcmJlaXRzcHJlaXMg4oKsL2tXaDxpbnB1dCBpZD0iZmFsbGJhY2tQcmljZUlucHV0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5Nb25hdGxpY2hlIEZpeGtvc3RlbiDigqw8aW5wdXQgaWQ9ImRlZmF1bHRCYXNlRmVlSW5wdXQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAxIj48L2xhYmVsPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9InNhdmVDb3N0U2V0dGluZ3NCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuPC9idXR0b24+CiAgICAgIDwvc2VjdGlvbj4KICAgIDwvc2VjdGlvbj4KICA8L21haW4+CgogIDxuYXYgY2xhc3M9ImJvdHRvbS1uYXYiIGFyaWEtbGFiZWw9IkhhdXB0bmF2aWdhdGlvbiI+CiAgICA8YnV0dG9uIGNsYXNzPSJhY3RpdmUiIGRhdGEtbmF2PSJkYXNoYm9hcmRWaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKMgjwvc3Bhbj7DnGJlcnNpY2h0PC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtbmF2PSJjb25zdW1wdGlvblZpZXciIHR5cGU9ImJ1dHRvbiI+PHNwYW4+4pakPC9zcGFuPlZlcmJyYXVjaDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iYW5hbHlzaXNWaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKWpTwvc3Bhbj5BdXN3ZXJ0dW5nPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtbmF2PSJkYXRhVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7impk8L3NwYW4+RGF0ZW48L2J1dHRvbj4KICA8L25hdj4KPC9kaXY+Cgo8ZGl2IGlkPSJyZWNvcmRNb2RhbCIgY2xhc3M9Im1vZGFsIGhpZGRlbiIgcm9sZT0iZGlhbG9nIiBhcmlhLW1vZGFsPSJ0cnVlIiBhcmlhLWxhYmVsbGVkYnk9InJlY29yZE1vZGFsVGl0bGUiPgogIDxkaXYgY2xhc3M9Im1vZGFsLWJhY2tkcm9wIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbD48L2Rpdj4KICA8Zm9ybSBjbGFzcz0ibW9kYWwtY2FyZCIgaWQ9InJlY29yZEZvcm0iPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+TU9OQVQgQkVBUkJFSVRFTjwvc3Bhbj48aDIgaWQ9InJlY29yZE1vZGFsVGl0bGUiPk1vbmF0IGJlYXJiZWl0ZW48L2gyPjwvZGl2PjxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iaWNvbi1idXR0b24iIGRhdGEtY2xvc2UtcmVjb3JkLW1vZGFsIGFyaWEtbGFiZWw9IlNjaGxpZcOfZW4iPsOXPC9idXR0b24+PC9kaXY+CiAgICA8aW5wdXQgaWQ9ImVkaXRpbmdNb250aE9yaWdpbmFsIiB0eXBlPSJoaWRkZW4iPgogICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+TW9uYXQ8aW5wdXQgaWQ9InJlY29yZE1vbnRoIiB0eXBlPSJtb250aCIgcmVhZG9ubHk+PC9sYWJlbD4KICAgICAgPHNwYW4+PC9zcGFuPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5HZXNhbXR2ZXJicmF1Y2gga1doPGlucHV0IGlkPSJyZWNvcmRUb3RhbCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkFsdGVudGVpbCBrV2g8aW5wdXQgaWQ9InJlY29yZEFubmV4IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+V8Okcm1lcHVtcGUga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0UHVtcCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPsOYIFN0cm9tcHJlaXMgY3Qva1doPGlucHV0IGlkPSJyZWNvcmRQcmljZUN0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+Rml4a29zdGVuIOKCrDxpbnB1dCBpZD0icmVjb3JkQmFzZUZlZSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0iZGVyaXZlZFByZXZpZXciIGNsYXNzPSJkZXJpdmVkLXByZXZpZXciPlNjaGxlZS9LbHVzOiDigJM8L2Rpdj4KICAgIDxwIGlkPSJyZWNvcmRTb3VyY2VIaW50IiBjbGFzcz0ibXV0ZWQgY29tcGFjdC1ub3RlIj48L3A+CiAgICA8ZGV0YWlscyBjbGFzcz0iZGV0YWlscy1jYXJkIj48c3VtbWFyeT5Xw6RybWVwdW1wZW4tRGV0YWlscyAob3B0aW9uYWwpPC9zdW1tYXJ5PjxkaXYgY2xhc3M9ImZvcm0tZ3JpZCBkZXRhaWwtZ3JpZCI+PGxhYmVsIGNsYXNzPSJmaWVsZCI+RXJ6ZXVndGUgV8Okcm1lIGtXaDxpbnB1dCBpZD0icmVjb3JkSGVhdEdlbmVyYXRlZCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPkhlaXpzdHJvbSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPldhcm13YXNzZXJzdHJvbSBrV2g8aW5wdXQgaWQ9InJlY29yZERod0VsZWN0cmljaXR5IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PGxhYmVsIGNsYXNzPSJmaWVsZCI+SGVpenfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRpbmdIZWF0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PGxhYmVsIGNsYXNzPSJmaWVsZCI+V2FybXdhc3NlcnfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZERod0hlYXQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48L2Rpdj48L2RldGFpbHM+CiAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5Ob3Rpejx0ZXh0YXJlYSBpZD0icmVjb3JkTm90ZSIgcm93cz0iMyIgbWF4bGVuZ3RoPSI4MDAiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgIDxwIGlkPSJyZWNvcmRWYWxpZGF0aW9uIiBjbGFzcz0idmFsaWRhdGlvbi10ZXh0Ij48L3A+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj48c3BhbiBjbGFzcz0ic3BhY2VyIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iIGRhdGEtY2xvc2UtcmVjb3JkLW1vZGFsPkFiYnJlY2hlbjwvYnV0dG9uPjxidXR0b24gY2xhc3M9InByaW1hcnkiIHR5cGU9InN1Ym1pdCI+w4RuZGVydW5nZW4gc3BlaWNoZXJuPC9idXR0b24+PC9kaXY+CiAgPC9mb3JtPgo8L2Rpdj4KCjxkaXYgaWQ9Im1ldGVyTW9kYWwiIGNsYXNzPSJtb2RhbCBoaWRkZW4iIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbGxlZGJ5PSJtZXRlck1vZGFsVGl0bGUiPgogIDxkaXYgY2xhc3M9Im1vZGFsLWJhY2tkcm9wIiBkYXRhLWNsb3NlLW1ldGVyLW1vZGFsPjwvZGl2PgogIDxmb3JtIGNsYXNzPSJtb2RhbC1jYXJkIiBpZD0ibWV0ZXJGb3JtIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlrDhEhMRVJTVMOETkRFPC9zcGFuPjxoMiBpZD0ibWV0ZXJNb2RhbFRpdGxlIj5OZXVlIEFibGVzdW5nPC9oMj48L2Rpdj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imljb24tYnV0dG9uIiBkYXRhLWNsb3NlLW1ldGVyLW1vZGFsIGFyaWEtbGFiZWw9IlNjaGxpZcOfZW4iPsOXPC9idXR0b24+PC9kaXY+CiAgICA8cCBpZD0ibWV0ZXJQcmV2aW91cyIgY2xhc3M9Im1ldGVyLXByZXZpb3VzIj48L3A+CiAgICA8cCBpZD0ibWV0ZXJUYXJnZXRNb250aCIgY2xhc3M9Im11dGVkIj48L3A+CiAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BYmxlc2VkYXR1bTxpbnB1dCBpZD0ibWV0ZXJEYXRlIiB0eXBlPSJkYXRlIiByZXF1aXJlZD48L2xhYmVsPgogICAgICA8c3Bhbj48L3NwYW4+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkdlc2FtdC1aw6RobGVyc3RhbmQga1doPGlucHV0IGlkPSJtZXRlclRvdGFsIiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2g8aW5wdXQgaWQ9Im1ldGVyQW5uZXgiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIiByZXF1aXJlZD48L2xhYmVsPgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJtZXRlclByZXZpZXciIGNsYXNzPSJkZXJpdmVkLXByZXZpZXciPk1vbmF0c3ZlcmJyw6R1Y2hlIHdlcmRlbiBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9kaXY+CiAgICA8cCBjbGFzcz0ibXV0ZWQgY29tcGFjdC1ub3RlIj5EaWUgV8Okcm1lcHVtcGUgd2lyZCBuaWNodCBoaWVyIGVpbmdldHJhZ2VuLiBTaWUga29tbXQgYXVzc2NobGllw59saWNoIGF1cyBkZW0gbXlWQUlMTEFOVC1DU1YtSW1wb3J0LjwvcD4KICAgIDxwIGlkPSJtZXRlclZhbGlkYXRpb24iIGNsYXNzPSJ2YWxpZGF0aW9uLXRleHQiPjwvcD4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWFjdGlvbnMiPjxzcGFuIGNsYXNzPSJzcGFjZXIiPjwvc3Bhbj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbD5BYmJyZWNoZW48L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJzdWJtaXQiPlrDpGhsZXJzdMOkbmRlIHNwZWljaGVybjwvYnV0dG9uPjwvZGl2PgogIDwvZm9ybT4KPC9kaXY+Cgo8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9InRvYXN0IGhpZGRlbiIgcm9sZT0ic3RhdHVzIiBhcmlhLWxpdmU9InBvbGl0ZSI+PC9kaXY+CjxzY3JpcHQgc3JjPSJhcHAuanM/dj02LjMuMSI+PC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=","type":"text/html; charset=utf-8","cache":"no-cache"},"/styles.css":{"body":"OnJvb3R7CiAgY29sb3Itc2NoZW1lOmRhcms7CiAgLS1iZzojMDYxMDFjOwogIC0tcGFuZWw6IzBjMWEyYTsKICAtLXBhbmVsMjojMTAyMjM1OwogIC0tbGluZTpyZ2JhKDE3MSwxOTgsMjIwLC4xNCk7CiAgLS10ZXh0OiNmNGY4ZmI7CiAgLS1tdXRlZDojOTRhOGJhOwogIC0tZ3JlZW46IzcyZGM1NzsKICAtLW9yYW5nZTojZmY5ZjQzOwogIC0tYmx1ZTojNGQ5Y2ZmOwogIC0teWVsbG93OiNmMmQxNWY7CiAgLS1yZWQ6I2ZmNmI2YjsKICAtLXNoYWRvdzowIDE4cHggNTVweCByZ2JhKDAsMCwwLC4yNCk7CiAgLS1yYWRpdXM6MjBweDsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbHtiYWNrZ3JvdW5kOnZhcigtLWJnKTttaW4taGVpZ2h0OjEwMCU7Zm9udC1mYW1pbHk6SW50ZXIsLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixzYW5zLXNlcmlmOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQpib2R5e21hcmdpbjowO2JhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCB0b3AgcmlnaHQscmdiYSg2MCwxMjAsMTcwLC4xMCksdHJhbnNwYXJlbnQgMzUlKSx2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7bWluLWhlaWdodDoxMDB2aH0KYnV0dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXR9CmJ1dHRvbntjdXJzb3I6cG9pbnRlcn0KYnV0dG9uOmRpc2FibGVke29wYWNpdHk6LjQ4O2N1cnNvcjpub3QtYWxsb3dlZH0KLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQouYXBwLXNoZWxse21heC13aWR0aDoxMTgwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjAgMjJweCAxMTJweH0KLnRvcGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6Y2FsYygxNnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKSAwIDE4cHg7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MzA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQodG8gYm90dG9tLHJnYmEoNiwxNiwyOCwuOTgpLHJnYmEoNiwxNiwyOCwuODYpLHJnYmEoNiwxNiwyOCwwKSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCl9Ci5icmFuZHtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0Ojg1MDtsZXR0ZXItc3BhY2luZzotLjAzZW19LmJyYW5kLW1hcmt7ZGlzcGxheTppbmxpbmUtZ3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6MzZweDtoZWlnaHQ6MzZweDtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxZTYzMzMsIzJmOGU0OSk7Ym94LXNoYWRvdzowIDZweCAyNHB4IHJnYmEoNTMsMTkwLDkxLC4xOCl9Ci5zdWJ0aXRsZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWxlZnQ6NDZweDttYXJnaW4tdG9wOi00cHh9LmJ1aWxkLXBpbGx7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4xMik7Y29sb3I6I2I5ZjVhYTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTE0LDIyMCw4NywuMjIpO3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLXJhZGl1czo5OTlweH0KbWFpbntkaXNwbGF5OmJsb2NrfS52aWV3e2Rpc3BsYXk6bm9uZTthbmltYXRpb246ZmFkZSAuMThzIGVhc2V9LnZpZXcuYWN0aXZle2Rpc3BsYXk6YmxvY2t9QGtleWZyYW1lcyBmYWRle2Zyb217b3BhY2l0eTouNTt0cmFuc2Zvcm06dHJhbnNsYXRlWSg0cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5wYWdlLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDoyMnB4O21hcmdpbjoxOHB4IDAgMjRweH0ucGFnZS1oZWFkIGgxe2ZvbnQtc2l6ZTpjbGFtcCgyOHB4LDV2dyw0NHB4KTttYXJnaW46M3B4IDAgN3B4O2xpbmUtaGVpZ2h0OjEuMDU7bGV0dGVyLXNwYWNpbmc6LS4wNGVtfS5wYWdlLWhlYWQgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7bWF4LXdpZHRoOjY4MHB4O2xpbmUtaGVpZ2h0OjEuNX0uZXllYnJvd3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xNmVtO2ZvbnQtd2VpZ2h0Ojg1MDtjb2xvcjojN2Y5ZGI0O21hcmdpbi1ib3R0b206NXB4fQoucGFuZWx7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHJnYmEoMTUsMzEsNDgsLjk2KSxyZ2JhKDEwLDI0LDM5LC45OCkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjE4cHg7Ym94LXNoYWRvdzp2YXIoLS1zaGFkb3cpfQoucGFuZWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE4cHh9LnBhbmVsLWhlYWQgaDJ7bWFyZ2luOjJweCAwIDJweDtmb250LXNpemU6MjFweDtsZXR0ZXItc3BhY2luZzotLjAyNWVtfS5wYW5lbC1oZWFkIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0KLnByaW1hcnksLnNlY29uZGFyeSwuZGFuZ2VyLC5maWxlLWJ1dHRvbnthcHBlYXJhbmNlOm5vbmU7Ym9yZGVyLXJhZGl1czoxM3B4O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnQ7cGFkZGluZzoxMXB4IDE1cHg7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLXRleHQpO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjhweDt0ZXh0LWRlY29yYXRpb246bm9uZTttaW4taGVpZ2h0OjQ0cHh9LnByaW1hcnl7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyZjhlNDksIzFmNmMzOCk7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMjgpO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDQ0LDE2MSw3NywuMTgpfS5wcmltYXJ5OmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMDYpfS5zZWNvbmRhcnksLmZpbGUtYnV0dG9ue2JhY2tncm91bmQ6IzEyMjYzYTtib3JkZXItY29sb3I6cmdiYSgxNzAsMjAwLDIyNCwuMTQpO2NvbG9yOiNkY2U5ZjN9LnNlY29uZGFyeTpob3ZlciwuZmlsZS1idXR0b246aG92ZXJ7YmFja2dyb3VuZDojMTczMDQ5fS5kYW5nZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xMCk7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjI1KTtjb2xvcjojZmZhYWE5fS5jb21wYWN0e21pbi1oZWlnaHQ6MzZweDtwYWRkaW5nOjhweCAxMXB4O2ZvbnQtc2l6ZToxM3B4fS5pY29uLWJ1dHRvbntib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjOWQ3ZTI7Zm9udC1zaXplOjMwcHg7bGluZS1oZWlnaHQ6MTtwYWRkaW5nOjAgNnB4fQoubWV0cmljLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNSxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxNnB4O21pbi13aWR0aDowfS5tZXRyaWMtZ3JpZCBhcnRpY2xlIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbTo3cHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZTpjbGFtcCgxOXB4LDN2dywyNnB4KTtsaW5lLWhlaWdodDoxLjE7ZGlzcGxheTpibG9jazt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Lm1ldHJpYy1ncmlkIGFydGljbGUgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojN2Y5NmFhO2ZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NnB4O2xpbmUtaGVpZ2h0OjEuMzV9LmNvbXBhcmlzb24tbGluZXttYXJnaW46MTVweCAwIDA7Y29sb3I6I2I4YzhkNTtmb250LXNpemU6MTNweH0uY29tcGFyaXNvbi1saW5lLnBvc2l0aXZle2NvbG9yOiNmZmIxYTh9LmNvbXBhcmlzb24tbGluZS5uZWdhdGl2ZXtjb2xvcjojYTVlNjlhfS5jb21wYXJpc29uLWxpbmUubmV1dHJhbHtjb2xvcjojYjhjOGQ1fQoub3N0cm9tLXBhbmVse292ZXJmbG93OmhpZGRlbn0ub3N0cm9tLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ucHJpY2UtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMGIxYjJiO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MThweH0ucHJpY2UtY2FyZDpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowIGF1dG8gMCAwO3dpZHRoOjRweDtiYWNrZ3JvdW5kOiM2ZDg1OTl9LnByaWNlLWNhcmQuYmVzdDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ncmVlbil9LnByaWNlLWNhcmQud29yc3Q6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tcmVkKX0ucHJpY2UtY2FyZC5jdXJyZW50OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLWJsdWUpfS5wcmljZS1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9LnByaWNlLWNhcmQgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjI3cHg7bWFyZ2luOjhweCAwIDRweH0ucHJpY2UtY2FyZCBzbWFsbHtjb2xvcjojOWNiMGMwfS5lbXB0eS1zdGF0ZXtib3JkZXI6MXB4IGRhc2hlZCByZ2JhKDE3MCwyMDAsMjI0LC4yKTtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjAyKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6OXB4IDE0cHg7YWxpZ24taXRlbXM6Y2VudGVyfS5lbXB0eS1zdGF0ZSBzdHJvbmd7d2lkdGg6MTAwJX0uZW1wdHktc3RhdGUgc3Bhbntjb2xvcjp2YXIoLS1tdXRlZCk7ZmxleDoxO21pbi13aWR0aDoyMDBweH0ucHJpY2UtY2hhcnQtd3JhcHttYXJnaW4tdG9wOjE2cHh9Ci5jaGFydC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDoyNjBweDt3aWR0aDoxMDAlO21pbi13aWR0aDowfS5jaGFydC13cmFwLmxhcmdle2hlaWdodDozNDBweH0uY2hhcnQtd3JhcCBjYW52YXN7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtkaXNwbGF5OmJsb2NrfS5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjI2MHB4fS5sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNXB4O21hcmdpbjotNnB4IDAgMTRweDtjb2xvcjojYjhjNmQyO2ZvbnQtc2l6ZToxMnB4fS5sZWdlbmQgc3BhbjpiZWZvcmV7Y29udGVudDoiIjtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjNweDttYXJnaW4tcmlnaHQ6NnB4fS5sZWdlbmQgLmhlYXQ6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tb3JhbmdlKX0ubGVnZW5kIC5hbm5leDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ibHVlKX0ubGVnZW5kIC5yZXN0OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyl9Ci5yZWNvcmQtdG9vbGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MTRweH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0LC5maWx0ZXItcGFuZWwgc2VsZWN0e2JhY2tncm91bmQ6IzBiMWEyYTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEwcHggMTJweH0ucmVjb3JkLWxpc3R7ZGlzcGxheTpncmlkO2dhcDoxMHB4fS5yZWNvcmQtcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6bWlubWF4KDE1MHB4LDEuM2ZyKSByZXBlYXQoNCxtaW5tYXgoOTBweCwuODVmcikpIGF1dG87Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGExOTI4O2JvcmRlci1yYWRpdXM6MTVweDtwYWRkaW5nOjEzcHggMTRweH0ucmVjb3JkLXJvdzpob3ZlcntiYWNrZ3JvdW5kOiMwZTIwMzJ9LnJlY29yZC1tb250aCBzdHJvbmd7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTVweH0ucmVjb3JkLW1vbnRoIHNtYWxse2Rpc3BsYXk6YmxvY2s7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6M3B4fS5yZWNvcmQtdmFsdWUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOiM3Zjk2YWE7Zm9udC1zaXplOjEwcHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wOGVtfS5yZWNvcmQtdmFsdWUgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kfS5yZWNvcmQtcm93LmludmFsaWR7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjMpfQouZmlsdGVyLXBhbmVse2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczplbmR9LmZpbHRlci1wYW5lbCBsYWJlbHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWluLXdpZHRoOjE1MHB4fS5hbmFseXNpcy1tZXRyaWNze21hcmdpbi1ib3R0b206MThweH0uYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDUsbWlubWF4KDAsMWZyKSl9Ci50YWJsZS1zY3JvbGx7b3ZlcmZsb3c6YXV0bztib3JkZXItcmFkaXVzOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzIwcHh9dGgsdGR7cGFkZGluZzoxMnB4IDEzcHg7dGV4dC1hbGlnbjpyaWdodDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmb250LXNpemU6MTNweH10aDpmaXJzdC1jaGlsZCx0ZDpmaXJzdC1jaGlsZHt0ZXh0LWFsaWduOmxlZnR9dGh7Zm9udC1zaXplOjExcHg7Y29sb3I6Izg4YTBiNTtsZXR0ZXItc3BhY2luZzouMDVlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7YmFja2dyb3VuZDojMGExOTI4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MH10Ym9keSB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLmNvbXBhY3QtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSl9Lmlzc3VlLWxpc3R7ZGlzcGxheTpncmlkO2dhcDo4cHg7bWFyZ2luLXRvcDoxNHB4fS5pc3N1ZXtkaXNwbGF5OmZsZXg7Z2FwOjEycHg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTJweCAxM3B4O2JvcmRlci1yYWRpdXM6MTNweDtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0uaXNzdWUud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yMil9Lmlzc3VlLmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4yNSl9Lmlzc3VlIGRpdnttaW4td2lkdGg6MH0uaXNzdWUgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEzcHh9Lmlzc3VlIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6M3B4fS5tdXRlZHtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS41NX0uYWN0aW9uLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5zdGF0dXMtdGV4dHttaW4taGVpZ2h0OjEuNGVtO21hcmdpbjoxMnB4IDAgMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHh9LnN0YXR1cy10ZXh0Lm9re2NvbG9yOiNhNWU2OWF9LnN0YXR1cy10ZXh0LmVycm9ye2NvbG9yOiNmZmFhYTl9LnNldHRpbmdzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTNweDttYXJnaW46MTRweCAwfS5maWVsZHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjojOWRiMGMwO2ZvbnQtc2l6ZToxMnB4fS5maWVsZCBpbnB1dCwuZmllbGQgc2VsZWN0LC5maWVsZCB0ZXh0YXJlYXt3aWR0aDoxMDAlO2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTcxLDE5OCwyMjAsLjE2KTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEycHg7b3V0bGluZTpub25lfS5maWVsZCBpbnB1dDpmb2N1cywuZmllbGQgc2VsZWN0OmZvY3VzLC5maWVsZCB0ZXh0YXJlYTpmb2N1c3tib3JkZXItY29sb3I6cmdiYSg3NywxNTYsMjU1LC41NSk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NywxNTYsMjU1LC4wOCl9LnN3aXRjaC1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjExcHggMTNweDtjb2xvcjojYzdkNWRmfS5zd2l0Y2gtcm93IGlucHV0e3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7YWNjZW50LWNvbG9yOiMzYzlhNTN9Ci5iYW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTZweDttYXJnaW46MTJweCAwIDE4cHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxNXB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGQyMDMyfS5iYW5uZXIud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yOCk7YmFja2dyb3VuZDpyZ2JhKDI0MiwyMDksOTUsLjA2KX0uYmFubmVyIHN0cm9uZywuYmFubmVyIHNwYW57ZGlzcGxheTpibG9ja30uYmFubmVyIHNwYW57Y29sb3I6I2IzYzBjYTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjNweH0KLmJvdHRvbS1uYXZ7cG9zaXRpb246Zml4ZWQ7ei1pbmRleDo0MDtsZWZ0OjUwJTtib3R0b206bWF4KDEycHgsZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7d2lkdGg6bWluKDYyMHB4LGNhbGMoMTAwJSAtIDI0cHgpKTtiYWNrZ3JvdW5kOnJnYmEoOCwyMCwzMywuOTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTYpO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjdweDtib3gtc2hhZG93OjAgMTZweCA1MHB4IHJnYmEoMCwwLDAsLjQyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxNnB4KX0uYm90dG9tLW5hdiBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojODU5OWFhO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjlweCA4cHg7ZGlzcGxheTpncmlkO2dhcDozcHg7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MDttaW4td2lkdGg6MH0uYm90dG9tLW5hdiBidXR0b24gc3Bhbntmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfS5ib3R0b20tbmF2IGJ1dHRvbi5hY3RpdmV7YmFja2dyb3VuZDojMTUzMTQ3O2NvbG9yOiNmNGY4ZmJ9Ci5tb2RhbHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7cGFkZGluZzoxOHB4fS5tb2RhbC1iYWNrZHJvcHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNzIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDVweCl9Lm1vZGFsLWNhcmR7cG9zaXRpb246cmVsYXRpdmU7d2lkdGg6bWluKDc2MHB4LDEwMCUpO21heC1oZWlnaHQ6Y2FsYygxMDB2aCAtIDM2cHgpO292ZXJmbG93OmF1dG87YmFja2dyb3VuZDojMGIxYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTgpO2JvcmRlci1yYWRpdXM6MjJweDtwYWRkaW5nOjIycHg7Ym94LXNoYWRvdzowIDMwcHggOTBweCByZ2JhKDAsMCwwLC41NSl9Lm1vZGFsLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxOHB4fS5tb2RhbC1oZWFkIGgye21hcmdpbjoycHggMCAwfS5mb3JtLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0uZGVyaXZlZC1wcmV2aWV3e21hcmdpbjoxNHB4IDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTJweCAxNHB4O2ZvbnQtd2VpZ2h0OjgwMH0uZGVyaXZlZC1wcmV2aWV3LmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zNSk7Y29sb3I6I2ZmYWFhOX0uZGV0YWlscy1jYXJke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbjoxMnB4IDA7YmFja2dyb3VuZDojMDgxNzI1fS5kZXRhaWxzLWNhcmQgc3VtbWFyeXtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjEycHggMTRweDtjb2xvcjojYzdkNWRmO2ZvbnQtd2VpZ2h0OjcwMH0uZGV0YWlscy1jYXJkIC5kZXRhaWwtZ3JpZHtwYWRkaW5nOjAgMTRweCAxNHB4fS52YWxpZGF0aW9uLXRleHR7bWluLWhlaWdodDoxLjJlbTtjb2xvcjojZmZhYWE5O2ZvbnQtc2l6ZToxMnB4fS5tb2RhbC1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OXB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjE2cHh9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntmbGV4OjF9Ci50b2FzdHtwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjE1MDtsZWZ0OjUwJTtib3R0b206MTAwcHg7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7YmFja2dyb3VuZDojMTkzNjRkO2NvbG9yOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIwMCwyMjAsMjM2LC4xNik7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTFweCAxNXB4O2JveC1zaGFkb3c6MCAxNnB4IDUwcHggcmdiYSgwLDAsMCwuNCk7bWF4LXdpZHRoOm1pbig5MHZ3LDU2MHB4KTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpey5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9LnJlY29yZC1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxNTBweCwxLjJmcikgcmVwZWF0KDIsbWlubWF4KDk1cHgsLjhmcikpIGF1dG99LnJlY29yZC1yb3cgLnJlY29yZC12YWx1ZTpudGgtb2YtdHlwZSg0KSwucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVlOm50aC1vZi10eXBlKDUpe2Rpc3BsYXk6bm9uZX0ub3N0cm9tLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnByaWNlLWNhcmQuY3VycmVudHtncmlkLWNvbHVtbjoxLy0xfS5jb21wYWN0LW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfX0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmFwcC1zaGVsbHtwYWRkaW5nOjAgMTJweCAxMDRweH0udG9wYmFye3BhZGRpbmctbGVmdDo0cHg7cGFkZGluZy1yaWdodDo0cHh9LmJyYW5ke2ZvbnQtc2l6ZToyMXB4fS5icmFuZC1tYXJre3dpZHRoOjMzcHg7aGVpZ2h0OjMzcHh9LnN1YnRpdGxle21hcmdpbi1sZWZ0OjQzcHh9LnBhZ2UtaGVhZHthbGlnbi1pdGVtczpzdHJldGNoO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjttYXJnaW4tdG9wOjlweH0ucGFnZS1oZWFkIC5wcmltYXJ5e3dpZHRoOjEwMCV9LnBhZ2UtaGVhZCBoMXtmb250LXNpemU6MzFweH0ucGFuZWx7cGFkZGluZzoxNnB4O2JvcmRlci1yYWRpdXM6MTdweDttYXJnaW4tYm90dG9tOjEzcHh9LnBhbmVsLWhlYWR7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5wYW5lbC1oZWFkIGgye2ZvbnQtc2l6ZToxOHB4fS5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsbWlubWF4KDAsMWZyKSk7Z2FwOjlweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtwYWRkaW5nOjEzcHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZToyMHB4fS5vc3Ryb20tZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5wcmljZS1jYXJkLmN1cnJlbnR7Z3JpZC1jb2x1bW46YXV0b30ucHJpY2UtY2FyZHtwYWRkaW5nOjE1cHh9LnByaWNlLWNhcmQgc3Ryb25ne2ZvbnQtc2l6ZToyNHB4fS5jaGFydC13cmFwLC5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjIyNXB4fS5jaGFydC13cmFwLmxhcmdle2hlaWdodDoyNzBweH0ucmVjb3JkLXRvb2xiYXJ7YWxpZ24taXRlbXM6c3RyZXRjaH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0e21heC13aWR0aDoxNDVweH0ucmVjb3JkLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjlweH0ucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVle2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9LnJlY29yZC1yb3cgLmVkaXQtcmVjb3Jke2dyaWQtY29sdW1uOjI7Z3JpZC1yb3c6MX0ucmVjb3JkLW1vbnRoIHNtYWxse21heC13aWR0aDoyMzBweH0uZmlsdGVyLXBhbmVse2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtwYWRkaW5nOjE0cHh9LmZpbHRlci1wYW5lbCBsYWJlbHttaW4td2lkdGg6MH0uc2V0dGluZ3MtZ3JpZCwuZm9ybS1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmRldGFpbHMtY2FyZCAuZGV0YWlsLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uYWN0aW9uLXJvdz4qe2ZsZXg6MSAxIDE1MHB4fS5ib3R0b20tbmF2e3dpZHRoOmNhbGMoMTAwJSAtIDE2cHgpO2JvdHRvbTptYXgoOHB4LGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7Ym9yZGVyLXJhZGl1czoxN3B4fS5ib3R0b20tbmF2IGJ1dHRvbntmb250LXNpemU6MTBweDtwYWRkaW5nOjhweCAzcHh9LmJvdHRvbS1uYXYgYnV0dG9uIHNwYW57Zm9udC1zaXplOjE4cHh9Lm1vZGFse3BhZGRpbmc6OHB4fS5tb2RhbC1jYXJke3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE4cHg7bWF4LWhlaWdodDpjYWxjKDEwMHZoIC0gMTZweCl9Lm1vZGFsLWFjdGlvbnN7ZmxleC13cmFwOndyYXB9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntkaXNwbGF5Om5vbmV9Lm1vZGFsLWFjdGlvbnMgYnV0dG9ue2ZsZXg6MSAxIDEyMHB4fS5iYW5uZXJ7YWxpZ24taXRlbXM6c3RyZXRjaDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59LmJhbm5lciBidXR0b257YWxpZ24tc2VsZjpmbGV4LXN0YXJ0fX0KQG1lZGlhKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsqe3Njcm9sbC1iZWhhdmlvcjphdXRvIWltcG9ydGFudDthbmltYXRpb246bm9uZSFpbXBvcnRhbnQ7dHJhbnNpdGlvbjpub25lIWltcG9ydGFudH19CgovKiBFbGRlaG9mIDYuMC4xIOKAkyBsb2thbGVyIG15VkFJTExBTlQtSW1wb3J0ICovCiN2YWlsbGFudEltcG9ydFBhbmVsIC5hY3Rpb24tcm93e21hcmdpbi10b3A6MTRweH0KI3ZhaWxsYW50SW1wb3J0U3RhdHVzLm9re2NvbG9yOiNhNWU2OWF9CiN2YWlsbGFudEltcG9ydFN0YXR1cy5lcnJvcntjb2xvcjojZmZhYWE5fQoKLyogRWxkZWhvZiA2LjEuMCDigJMgWsOkaGxlcnN0w6RuZGUgYWxzIGVpbnppZ2UgbWFudWVsbGUgVmVyYnJhdWNoc2VpbmdhYmUgKi8KLnJlY29yZC1zdGF0dXMtYmFkZ2V7anVzdGlmeS1zZWxmOmVuZDtmb250LXNpemU6MTFweDtjb2xvcjojOWRiMGMwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzo2cHggOHB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDojMDgxNzI1fQoubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfQoubWV0ZXItaGlzdG9yeXtkaXNwbGF5OmdyaWQ7Z2FwOjdweDttYXJnaW46MTRweCAwfS5tZXRlci1oaXN0b3J5LXJvd3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxMDBweCwxZnIpIHJlcGVhdCgyLG1pbm1heCgxMTBweCwxZnIpKSBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjEwcHggMTJweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiMwODE3MjU7Zm9udC1zaXplOjEycHh9Lm1ldGVyLWhpc3Rvcnktcm93IHNwYW4sLm1ldGVyLWhpc3Rvcnktcm93IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0ubWV0ZXItaGlzdG9yeS1yb3cgc3Ryb25ne2ZvbnQtc2l6ZToxMnB4fS5tZXRlci1hY3Rpb25ze21hcmdpbi10b3A6MTJweH0ubWV0ZXItcHJldmlvdXN7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1O2NvbG9yOiNiOWM3ZDI7bGluZS1oZWlnaHQ6MS41fS5jb21wYWN0LW5vdGV7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfS5tZXRlci1sYXRlc3QubWV0cmljLWdyaWQgYXJ0aWNsZTpmaXJzdC1jaGlsZHtncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0ubWV0ZXItaGlzdG9yeS1yb3cgc3BhbntncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvdyBzbWFsbHtkaXNwbGF5Om5vbmV9LnJlY29yZC1zdGF0dXMtYmFkZ2V7Zm9udC1zaXplOjEwcHh9fQoKLyogRWxkZWhvZiA2LjEuMSDigJMgTW9uYXRzd2VydGUgd2llZGVyIGJlYXJiZWl0YmFyICovCi5maWVsZCBpbnB1dFtyZWFkb25seV17b3BhY2l0eTouNzI7Y3Vyc29yOmRlZmF1bHQ7YmFja2dyb3VuZDojMGIxNzIyfS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kO3doaXRlLXNwYWNlOm5vd3JhcH0KCi8qIEVsZGVob2YgNi4yLjAgKi8KLmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e2Rpc3BsYXk6Z3JpZDtnYXA6NXB4O2ZsZXg6MTttaW4td2lkdGg6MjQwcHg7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDojMGIxYTJhfS5hbmFseXNpcy1hbGwteWVhcnMtaGludCBzdHJvbmd7Zm9udC1zaXplOjEzcHh9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50IHNwYW57Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2xpbmUtaGVpZ2h0OjEuNH0ueWVhci1jb21wYXJpc29uLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHggMTZweDttYXJnaW46LTRweCAwIDEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgc3BhbntkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2NvbG9yOiNiOGM2ZDI7Zm9udC1zaXplOjEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgaXtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDoyOHB4O2hlaWdodDowO2JvcmRlci10b3A6M3B4IHNvbGlkIGN1cnJlbnRDb2xvcn0ueWVhci1jb21wYXJpc29uLWxlZ2VuZCAucGFzdCBpe2JvcmRlci10b3Atc3R5bGU6ZGFzaGVkfS5zeW5jLWJhZGdle2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGIxYTJhO2NvbG9yOnZhcigtLW11dGVkKTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6ODAwfS5zeW5jLWJhZGdlLm9re2NvbG9yOiNhNWU2OWE7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMyl9LnN5bmMtYmFkZ2UuYnVzeXtjb2xvcjojOWZkMGZmO2JvcmRlci1jb2xvcjpyZ2JhKDc3LDE1NiwyNTUsLjM1KX0uc3luYy1iYWRnZS5lcnJvcntjb2xvcjojZmZhYWE5O2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zKX0uc3luYy1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfS5zeW5jLWpvaW4tYm94e21hcmdpbi10b3A6MTRweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nLXRvcDoxMnB4fS5zeW5jLWpvaW4tYm94IHN1bW1hcnl7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6I2RjZTlmMztmb250LXdlaWdodDo4MDB9LnN5bmMtcGFpci1yZXN1bHR7ZGlzcGxheTpncmlkO2dhcDo3cHg7bWFyZ2luLXRvcDoxNHB4O3BhZGRpbmc6MTRweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzcsMTU2LDI1NSwuMjgpO2JhY2tncm91bmQ6IzBhMWQzMDtib3JkZXItcmFkaXVzOjE0cHh9LnN5bmMtcGFpci1yZXN1bHQgc3Bhbiwuc3luYy1wYWlyLXJlc3VsdCBzbWFsbHtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjExcHh9LnN5bmMtcGFpci1yZXN1bHQgY29kZXtkaXNwbGF5OmJsb2NrO3dvcmQtYnJlYWs6YnJlYWstYWxsO2NvbG9yOiNkYmVlZmY7YmFja2dyb3VuZDojMDcxNDIxO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6OHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH1AbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsuZmlsdGVyLXBhbmVse2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e21pbi13aWR0aDowfS5zeW5jLW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnN5bmMtbWV0cmljcy5tZXRyaWMtZ3JpZCBhcnRpY2xlOmxhc3QtY2hpbGR7Z3JpZC1jb2x1bW46MS8tMX19CgoucHJpY2UtcnVubmluZ3tkaXNwbGF5OmlubGluZS1ibG9jazttYXJnaW4tbGVmdDo1cHg7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDpyZ2JhKDc3LDE1NiwyNTUsLjEyKTtjb2xvcjojOWZkMGZmO2ZvbnQtc2l6ZTo5cHg7Zm9udC13ZWlnaHQ6ODAwO3ZlcnRpY2FsLWFsaWduOm1pZGRsZX0ucHJpY2Utc3RhdHMtbm90ZXtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9CgovKiBFbGRlaG9mIDYuMy4xIOKAkyBLbGltYS1Db2NrcGl0OiByZXNwb25zaXZlIGFuZCBsZWdpYmxlIGFjcm9zcyBpT1MsIEFuZHJvaWQgYW5kIGRlc2t0b3AuICovCi5kYXNoYm9hcmQtY2xpbWF0ZS1wYW5lbHtvdmVyZmxvdzpoaWRkZW59Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzLm1ldHJpYy1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSk7bWFyZ2luLWJvdHRvbToxOHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtY2hhcnQtdG9we2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7bWFyZ2luOjEwcHggMH0KLmRhc2hib2FyZC1jbGltYXRlLWNoYXJ0LXRvcD5zdHJvbmd7Zm9udC1zaXplOjE0cHg7Y29sb3I6I2NjZGFlNX0KLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaHtkaXNwbGF5OmlubGluZS1mbGV4O2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTNweDtwYWRkaW5nOjRweDtnYXA6M3B4fQouZGFzaGJvYXJkLWNsaW1hdGUtc3dpdGNoIGJ1dHRvbntib3JkZXI6MDtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojOWViMmM0O2ZvbnQ6aW5oZXJpdDtmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7cGFkZGluZzo5cHggMTNweDtjdXJzb3I6cG9pbnRlcn0KLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6IzFiM2I1MTtjb2xvcjojZWVmYWZmfQouZGFzaGJvYXJkLWNsaW1hdGUtc3dpdGNoIGJ1dHRvbjpmb2N1cy12aXNpYmxle291dGxpbmU6MnB4IHNvbGlkICM4M2M3ZWM7b3V0bGluZS1vZmZzZXQ6MnB4fQouZGFzaGJvYXJkLWNsaW1hdGUtY2hhcnQtd3JhcC5jaGFydC13cmFwe2hlaWdodDoyMzVweH0KLmRhc2hib2FyZC1jbGltYXRlLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjlweCAxNXB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiNiNWM3ZDU7bWFyZ2luLXRvcDoxMHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtbGVnZW5kIHNwYW46OmJlZm9yZXtjb250ZW50OiIiO3dpZHRoOjEwcHg7aGVpZ2h0OjEwcHg7Ym9yZGVyLXJhZGl1czozcHg7ZGlzcGxheTppbmxpbmUtYmxvY2s7YmFja2dyb3VuZDp2YXIoLS1sZWdlbmQtY29sb3IpO21hcmdpbi1yaWdodDo2cHg7dmVydGljYWwtYWxpZ246YmFzZWxpbmV9Ci5kYXNoYm9hcmQtY2xpbWF0ZS10cmVuZHtjb2xvcjojYjhjYmQ4O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNDU7bWFyZ2luOjEwcHggMCAwO21pbi1oZWlnaHQ6MThweH0KLmRhc2hib2FyZC1jbGltYXRlLWZvb3RlcntkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2dhcDoxMnB4O2ZsZXgtd3JhcDp3cmFwO21hcmdpbi10b3A6OHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtZm9vdGVyIC5zdGF0dXMtdGV4dHtmbGV4OjEgMSAxNjBweDttYXJnaW46MDtmb250LXNpemU6MTJweH0KI2NsaW1hdGVBbmFseXNpc1BhbmVse3Njcm9sbC1tYXJnaW4tdG9wOjEwMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsKIC5kYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0KIC5kYXNoYm9hcmQtY2xpbWF0ZS1jaGFydC13cmFwLmNoYXJ0LXdyYXB7aGVpZ2h0OjIxNXB4fQogLmRhc2hib2FyZC1jbGltYXRlLXBhbmVsIC5wYW5lbC1oZWFke2FsaWduLWl0ZW1zOmZsZXgtc3RhcnR9CiAuZGFzaGJvYXJkLWNsaW1hdGUtcGFuZWwgLnBhbmVsLWhlYWQgYnV0dG9ue21heC13aWR0aDo0MCU7d2hpdGUtc3BhY2U6bm9ybWFsfQogLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCBidXR0b257cGFkZGluZzo5cHggMTBweDtmb250LXNpemU6MTJweH0KIC5kYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIgYnV0dG9ue3dpZHRoOjEwMCV9Cn0K","type":"text/css; charset=utf-8","cache":"no-cache"},"/app.js":{"body":"KCgpID0+IHsKICAidXNlIHN0cmljdCI7CgogIGNvbnN0IEFQUF9CVUlMRCA9ICI2LjMuMS1DTElNQVRFLURBU0hCT0FSRC1XRUFUSEVSRklYLTIwMjYxMDMxIjsKICBjb25zdCBEQVRBX0tFWSA9ICJlbGRlaG9mLXYzLXJlY29yZHMiOwogIGNvbnN0IFNFVFRJTkdTX0tFWSA9ICJlbGRlaG9mLXYzLXNldHRpbmdzIjsKICBjb25zdCBWQUlMTEFOVF9NT05USFNfS0VZID0gImVsZGVob2YtdjMtdmFpbGxhbnQtbW9udGhzLXYzODAiOwogIGNvbnN0IE9TVFJPTV9DQUNIRV9LRVkgPSAiZWxkZWhvZi12My1vc3Ryb20tbGl2ZS1jYWNoZSI7CiAgY29uc3QgT1NUUk9NX0NPTlRST0xfS0VZID0gImVsZGVob2YtdjUtb3N0cm9tLWNvbnRyb2wtdjU0MSI7CiAgY29uc3QgU0hBRE9XX0tFWSA9ICJlbGRlaG9mLXY2LXJlY29yZHMtc2hhZG93IjsKICBjb25zdCBTSEFET1dfTUVUQV9LRVkgPSAiZWxkZWhvZi12Ni1yZWNvcmRzLXNoYWRvdy1tZXRhIjsKICBjb25zdCBMQVNUX0JBQ0tVUF9LRVkgPSAiZWxkZWhvZi12Ni1sYXN0LWJhY2t1cC1hdCI7CiAgY29uc3QgTUVURVJfS0VZID0gImVsZGVob2YtdjYtbWV0ZXItcmVhZGluZ3MtdjYxMCI7CiAgY29uc3QgTUVURVJfTUVUQV9LRVkgPSAiZWxkZWhvZi12Ni1tZXRlci1yZWFkaW5ncy11cGRhdGVkLXY2MjAiOwogIGNvbnN0IEhJU1RPUllfU0VFRF9LRVkgPSAiZWxkZWhvZi12Ni1oaXN0b3J5LXNlZWQtdjYxMCI7CiAgY29uc3QgU1lOQ19TVEFURV9LRVkgPSAiZWxkZWhvZi12Ni1zeW5jLXN0YXRlLXY2MjAiOwogIGNvbnN0IFNZTkNfU0VDUkVUX0xFR0FDWV9LRVkgPSAiZWxkZWhvZi12Ni1zeW5jLXNlY3JldC12NjIwIjsKICBjb25zdCBTWU5DX1BBWUxPQURfU0NIRU1BID0gImVsZGVob2Ytc3luYy1wYXlsb2FkLXY2MjAiOwogIGNvbnN0IFNZTkNfRU5WRUxPUEVfU0NIRU1BID0gImVsZGVob2YtZW5jcnlwdGVkLXN5bmMtdjEiOwogIGNvbnN0IE9TVFJPTV9ISVNUT1JZX0tFWSA9ICJlbGRlaG9mLXY2LW9zdHJvbS1oaXN0b3J5LXN0YXR1cy12NjIwIjsKICBjb25zdCBPU1RST01fUFJJQ0VfU1RBVFNfS0VZID0gImVsZGVob2YtdjYtb3N0cm9tLXByaWNlLXN0YXRzLXY2MjEiOwogIGNvbnN0IE1PTlRIUyA9IFsiSmFuIiwiRmViIiwiTcOkciIsIkFwciIsIk1haSIsIkp1biIsIkp1bCIsIkF1ZyIsIlNlcCIsIk9rdCIsIk5vdiIsIkRleiJdOwogIGNvbnN0IENPTE9SUyA9IHsgdG90YWw6IiM3MmRjNTciLCBoZWF0OiIjZmY5ZjQzIiwgYW5uZXg6IiM0ZDljZmYiLCByZXN0OiIjZjJkMTVmIiwgY29tcGFyZToiIzljN2RmZiIsIGNvc3Q6IiM1ZmM3YzIiLCBncmlkOiJyZ2JhKDE3MSwxOTgsMjIwLC4xNCkiLCB0ZXh0OiIjOTRhOGJhIiB9OwogIGNvbnN0IFlFQVJfQ09MT1JTID0gWyIjNzJkYzU3IiwiIzRkOWNmZiIsIiM5YzdkZmYiLCIjZmY5ZjQzIiwiI2YyZDE1ZiIsIiM1ZmM3YzIiLCIjZmY3YjhhIl07CiAgY29uc3QgSElTVE9SSUNBTF9TRUVEID0geyJoZWF0UHVtcCI6eyIyMDIzLTEyIjoxNTUwLCIyMDI0LTAxIjoxOTgwLCIyMDI0LTAyIjoxMTEzLCIyMDI0LTAzIjo5MDcsIjIwMjQtMDQiOjUzNSwiMjAyNC0wNSI6MTU2LCIyMDI0LTA2IjoxMTAsIjIwMjQtMDciOjExMCwiMjAyNC0wOCI6MTA4LCIyMDI0LTA5IjoxOTgsIjIwMjQtMTAiOjQ5MCwiMjAyNC0xMSI6MTAwMywiMjAyNC0xMiI6MTMwNSwiMjAyNS0wMSI6MTY5NCwiMjAyNS0wMiI6MTQ3OCwiMjAyNS0wMyI6MTAwNSwiMjAyNS0wNCI6NDk4LCIyMDI1LTA1IjozNjcsIjIwMjUtMDYiOjEzNywiMjAyNS0wNyI6MTA2LCIyMDI1LTA4IjoxMjgsIjIwMjUtMDkiOjE4NSwiMjAyNS0xMCI6NjA3LCIyMDI1LTExIjoxMDQwLCIyMDI1LTEyIjoxMjY1LCIyMDI2LTAxIjoxODU1LCIyMDI2LTAyIjoxNDg4LCIyMDI2LTAzIjo4OTUsIjIwMjYtMDQiOjY1NiwiMjAyNi0wNSI6MzAwLCIyMDI2LTA2IjoxMjYsIjIwMjYtMDciOjEyOCwiMjAyNi0wOCI6MTIxLCIyMDI2LTA5IjoxMzd9LCJhbm5leCI6eyIyMDI0LTAxIjoyMTAsIjIwMjQtMDIiOjIxMCwiMjAyNC0wMyI6MjE5LCIyMDI0LTA0IjoyMDAsIjIwMjQtMDUiOjIyMiwiMjAyNC0wNiI6MTY0LCIyMDI0LTA3IjoyMTksIjIwMjQtMDgiOjIwMSwiMjAyNC0wOSI6MTkyLCIyMDI0LTEwIjoyMzcsIjIwMjQtMTEiOjIyNywiMjAyNC0xMiI6MjY2LCIyMDI1LTAxIjoyNjEsIjIwMjUtMDIiOjIzNSwiMjAyNS0wMyI6MjIxLCIyMDI1LTA0IjoyMzgsIjIwMjUtMDUiOjIyMSwiMjAyNS0wNiI6MjM3LCIyMDI1LTA3IjoyNDAsIjIwMjUtMDgiOjIzMiwiMjAyNS0wOSI6MzA4LCIyMDI1LTEwIjoyMjAsIjIwMjUtMTEiOjIzNywiMjAyNS0xMiI6MjczLCIyMDI2LTAxIjoyNDAsIjIwMjYtMDIiOjIyNSwiMjAyNi0wMyI6MjcwLCIyMDI2LTA0IjoyMTUsIjIwMjYtMDUiOjIyMCwiMjAyNi0wNiI6MjUwLCIyMDI2LTA3IjoyMTAsIjIwMjYtMDgiOjI0MCwiMjAyNi0wOSI6MjY1fSwidG90YWwiOnsiMjAyNC0wMSI6MjQ1MCwiMjAyNC0wMiI6MTYxNSwiMjAyNC0wMyI6MTMyMCwiMjAyNC0wNCI6OTMzLCIyMDI0LTA1Ijo3MzEsIjIwMjQtMDYiOjU4NywiMjAyNC0wNyI6NjIwLCIyMDI0LTA4Ijo1NDAsIjIwMjQtMDkiOjYxMiwiMjAyNC0xMCI6MTAxOSwiMjAyNC0xMSI6MTUyMSwiMjAyNC0xMiI6MTg1NywiMjAyNS0wMSI6MjI4MiwiMjAyNS0wMiI6MjAyMywiMjAyNS0wMyI6MTQxNCwiMjAyNS0wNCI6OTYwLCIyMDI1LTA1Ijo5MzMsIjIwMjUtMDYiOjc1MSwiMjAyNS0wNyI6NjgwLCIyMDI1LTA4Ijo2NzYsIjIwMjUtMDkiOjgxNCwiMjAyNS0xMCI6MTEwNSwiMjAyNS0xMSI6MTYxNSwiMjAyNS0xMiI6MTg1MCwiMjAyNi0wMSI6MjQ1MCwiMjAyNi0wMiI6MjA2MCwiMjAyNi0wMyI6MTU5NywiMjAyNi0wNCI6MTA1MSwiMjAyNi0wNSI6NzY3LCIyMDI2LTA2Ijo2NjIsIjIwMjYtMDciOjYwOCwiMjAyNi0wOCI6Njg1LCIyMDI2LTA5Ijo2NTV9fTsKICBjb25zdCBCQVNFTElORV9NRVRFUl9SRUFESU5HID0ge2RhdGU6IjIwMjYtMTAtMDEiLHRvdGFsOjM0MjU1LGFubmV4OjkwNDUsbm90ZToiU3RhcnR3ZXJ0IGbDvHIgZGllIGF1dG9tYXRpc2NoZSBCZXJlY2hudW5nIGFiIE9rdG9iZXIgMjAyNiJ9OwogIGNvbnN0ICQgPSBpZCA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CgogIGxldCBzZXR0aW5ncyA9IGxvYWRTZXR0aW5ncygpOwogIGxldCByZWNvcmRzID0gbG9hZFJlY29yZHMoKTsKICBsZXQgdmFpbGxhbnRNb250aHMgPSBsb2FkVmFpbGxhbnRNb250aHMoKTsKICBsZXQgb3N0cm9tTGl2ZSA9IGxvYWRPc3Ryb21DYWNoZSgpOwogIGxldCBvc3Ryb21CdXN5ID0gZmFsc2U7CiAgbGV0IG9zdHJvbVRpbWVyID0gbnVsbDsKICBsZXQgdG9hc3RUaW1lciA9IG51bGw7CiAgbGV0IHJlc2l6ZVRpbWVyID0gbnVsbDsKICBsZXQgY3VycmVudFZpZXcgPSAiZGFzaGJvYXJkVmlldyI7CiAgbGV0IG1ldGVyUmVhZGluZ3MgPSBsb2FkTWV0ZXJSZWFkaW5ncygpOwogIGxldCBzeW5jU3RhdGUgPSBsb2FkU3luY1N0YXRlKCk7CiAgbGV0IHN5bmNCdXN5ID0gZmFsc2U7CiAgbGV0IHN5bmNBcHBseWluZyA9IGZhbHNlOwogIGxldCBzeW5jRGVib3VuY2VUaW1lciA9IG51bGw7CiAgbGV0IHN5bmNQb2xsVGltZXIgPSBudWxsOwogIGxldCBvc3Ryb21IaXN0b3J5QnVzeSA9IGZhbHNlOwogIGxldCBvc3Ryb21QcmljZVN0YXRzID0gbG9hZE9zdHJvbVByaWNlU3RhdHMoKTsKICBsZXQgb3N0cm9tUHJpY2VTdGF0c0J1c3kgPSBmYWxzZTsKCiAgLyogQ2xpbWF0ZSA2LjM6IFZhaWxsYW50IGhvdXJseSBkYXRhIGFyZSByZWR1Y2VkIHRvIHByaXZhY3ktcHJlc2VydmluZyBtb250aGx5IGFnZ3JlZ2F0ZXMuICovCiAgY29uc3QgQ0xJTUFURV9NT05USF9LRVk9ImVsZGVob2YtdjYtY2xpbWF0ZS1tb250aHMtdjYzMCI7CiAgY29uc3QgQ0xJTUFURV9XRUFUSEVSX0tFWT0iZWxkZWhvZi12Ni1jbGltYXRlLXdlYXRoZXItdjYzMCI7CiAgbGV0IGNsaW1hdGVNb250aHM9bG9hZENsaW1hdGVNb250aHMoKTsKICBsZXQgY2xpbWF0ZVdlYXRoZXI9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShDTElNQVRFX1dFQVRIRVJfS0VZKSx7fSk7CiAgbGV0IGNsaW1hdGVCdXN5PWZhbHNlOwogIGZ1bmN0aW9uIGNsaW1hdGVOdW1iZXIocmF3KXtyZXR1cm4gcmF3PT1udWxsfHxyYXc9PT0iIj9udWxsOihOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdykpP051bWJlcihyYXcpOm51bGwpO30KICBmdW5jdGlvbiBjbGltYXRlU2FuaXRpemUoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCB4IG9mIEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKXsKICAgICAgY29uc3QgbW9udGg9U3RyaW5nKHg/Lm1vbnRofHwiIik7CiAgICAgIGlmKCEvXlxkezR9LSgwWzEtOV18MVswLTJdKSQvLnRlc3QobW9udGgpKWNvbnRpbnVlOwogICAgICBjb25zdCByb3c9e21vbnRoLHVwZGF0ZWRBdDpTdHJpbmcoeC51cGRhdGVkQXR8fCIiKX07CiAgICAgIGZvcihjb25zdCBrIG9mIFsib3V0ZG9vck1lYW4iLCJvdXRkb29yTWluIiwib3V0ZG9vck1heCIsIm91dGRvb3JIb3VycyIsInJvb21NZWFuIiwicm9vbUhvdXJzIiwic2V0cG9pbnRNZWFuIiwic2V0cG9pbnRIb3VycyIsImRod01lYW4iLCJkaHdIb3VycyJdKXJvd1trXT1jbGltYXRlTnVtYmVyKHhba10pOwogICAgICBtYXAuc2V0KG1vbnRoLHJvdyk7CiAgICB9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gbG9hZENsaW1hdGVNb250aHMoKXtyZXR1cm4gY2xpbWF0ZVNhbml0aXplKHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oQ0xJTUFURV9NT05USF9LRVkpLFtdKSk7fQogIGZ1bmN0aW9uIHNhdmVDbGltYXRlTW9udGhzKGl0ZW1zKXsKICAgIGNsaW1hdGVNb250aHM9Y2xpbWF0ZVNhbml0aXplKGl0ZW1zKTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKENMSU1BVEVfTU9OVEhfS0VZLEpTT04uc3RyaW5naWZ5KGNsaW1hdGVNb250aHMpKTsKICAgIGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoMTIwMCk7CiAgfQogIGZ1bmN0aW9uIGNsaW1hdGVQcmV2aWV3KGZpbGVzKXsKICAgIGNvbnN0IGNvbHM9eyJzeXN0ZW0tdGVtcGVyYXR1cmUiOltbIk91dGRvb3JUZW1wZXJhdHVyZSIsIm91dGRvb3IiXV0sInpvbmUtdGVtcGVyYXR1cmUiOltbIkN1cnJlbnRSb29tVGVtcGVyYXR1cmUiLCJyb29tIl0sWyJNYW51YWxNb2RlU2V0cG9pbnRIZWF0aW5nIiwic2V0cG9pbnQiXV0sImRody10ZW1wZXJhdHVyZSI6W1siRGh3VGFua1RlbXBlcmF0dXJlIiwiZGh3Il1dfTsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgZmlsZSBvZiBmaWxlcy5maWx0ZXIoZj0+Y29sc1tmLnR5cGVdKSl7CiAgICAgIGZvcihjb25zdCByIG9mIGZpbGUucm93cyl7CiAgICAgICAgaWYoIW1hcC5oYXMoci5tb250aEtleSkpbWFwLnNldChyLm1vbnRoS2V5LHttb250aDpyLm1vbnRoS2V5LHNlcmllczp7fX0pOwogICAgICAgIGNvbnN0IGJ1Y2tldD1tYXAuZ2V0KHIubW9udGhLZXkpOwogICAgICAgIGZvcihjb25zdCBbY29sdW1uLGtpbmRdIG9mIGNvbHNbZmlsZS50eXBlXSl7CiAgICAgICAgICBjb25zdCB2YWx1ZT1yLnZhbHVlc1tjb2x1bW5dOwogICAgICAgICAgaWYoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpY29udGludWU7CiAgICAgICAgICBpZighYnVja2V0LnNlcmllc1traW5kXSlidWNrZXQuc2VyaWVzW2tpbmRdPW5ldyBNYXAoKTsKICAgICAgICAgIGNvbnN0IG9sZD1idWNrZXQuc2VyaWVzW2tpbmRdLmdldChyLmRhdGVUaW1lKTsKICAgICAgICAgIGlmKG9sZCE9PXVuZGVmaW5lZCYmTWF0aC5hYnMob2xkLXZhbHVlKT4uMDUpdGhyb3cgRXJyb3IoIkFid2VpY2hlbmRlIGRvcHBlbHRlIFRlbXBlcmF0dXJtZXNzdW5nZW4gaW4gIityLm1vbnRoS2V5KTsKICAgICAgICAgIGJ1Y2tldC5zZXJpZXNba2luZF0uc2V0KHIuZGF0ZVRpbWUsdmFsdWUpOwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgcmV0dXJuIFsuLi5tYXAudmFsdWVzKCldLm1hcChiPT57CiAgICAgIGNvbnN0IHJvdz17bW9udGg6Yi5tb250aCx1cGRhdGVkQXQ6c3RhbXB9OwogICAgICBmb3IoY29uc3Qga2luZCBvZiBbIm91dGRvb3IiLCJyb29tIiwic2V0cG9pbnQiLCJkaHciXSl7CiAgICAgICAgY29uc3Qgdj1bLi4uKGIuc2VyaWVzW2tpbmRdPy52YWx1ZXMoKXx8W10pXTsKICAgICAgICBpZighdi5sZW5ndGgpY29udGludWU7CiAgICAgICAgcm93W2tpbmQrIk1lYW4iXT1NYXRoLnJvdW5kKHYucmVkdWNlKChhLHgpPT5hK3gsMCkvdi5sZW5ndGgqMTAwKS8xMDA7CiAgICAgICAgcm93W2tpbmQrIkhvdXJzIl09di5sZW5ndGg7CiAgICAgICAgaWYoa2luZD09PSJvdXRkb29yIil7cm93Lm91dGRvb3JNaW49TWF0aC5taW4oLi4udik7cm93Lm91dGRvb3JNYXg9TWF0aC5tYXgoLi4udik7fQogICAgICB9CiAgICAgIHJldHVybiByb3c7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gY2xpbWF0ZUltcG9ydChpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcChjbGltYXRlTW9udGhzLm1hcChyPT5bci5tb250aCxyXSkpOwogICAgZm9yKGNvbnN0IHJvdyBvZiBpdGVtcyltYXAuc2V0KHJvdy5tb250aCx7Li4ubWFwLmdldChyb3cubW9udGgpLC4uLnJvd30pOwogICAgc2F2ZUNsaW1hdGVNb250aHMoWy4uLm1hcC52YWx1ZXMoKV0pOwogIH0KICBmdW5jdGlvbiBtb250aGx5VmFpbGxhbnRJbXBvcnRzKGZpbGVzKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgZmlsZSBvZiBmaWxlcy5maWx0ZXIoZj0+Zi50eXBlPT09Im1vbnRobHktZW5lcmd5IikpewogICAgICBmb3IoY29uc3Qgcm93IG9mIGZpbGUucm93cyl7CiAgICAgICAgY29uc3QgcmF3PXJvdy52YWx1ZXMsbT1yb3cubW9udGhLZXk7CiAgICAgICAgaWYocmF3LmNvbXBsZXRlIT09dHJ1ZXx8cmF3LmVzdGltYXRlZD09PXRydWV8fG0+Y3VycmVudE1vbnRoS2V5KCkpY29udGludWU7CiAgICAgICAgY29uc3QgZmllbGRzPVsiZWxlY3RyaWNpdHlLV2giLCJoZWF0R2VuZXJhdGVkS1doIiwiaGVhdGluZ0VsZWN0cmljaXR5S1doIiwiZGh3RWxlY3RyaWNpdHlLV2giLCJoZWF0aW5nSGVhdEtXaCIsImRod0hlYXRLV2giXTsKICAgICAgICBpZihmaWVsZHMuc29tZShrPT4hTnVtYmVyLmlzRmluaXRlKHJhd1trXSl8fHJhd1trXTwwKSljb250aW51ZTsKICAgICAgICBjb25zdCB5ZWFyPU51bWJlcihtLnNsaWNlKDAsNCkpLG1vbnRoPU51bWJlcihtLnNsaWNlKDUpKTsKICAgICAgICBtYXAuc2V0KG0se21vbnRoOm0sZWxlY3RyaWNpdHlLV2g6cmF3LmVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2g6cmF3LmhlYXRHZW5lcmF0ZWRLV2gsaGVhdGluZ0VsZWN0cmljaXR5S1doOnJhdy5oZWF0aW5nRWxlY3RyaWNpdHlLV2gsZGh3RWxlY3RyaWNpdHlLV2g6cmF3LmRod0VsZWN0cmljaXR5S1doLGhlYXRpbmdIZWF0S1doOnJhdy5oZWF0aW5nSGVhdEtXaCxkaHdIZWF0S1doOnJhdy5kaHdIZWF0S1doLGNvbXBsZXRlOnRydWUsY292ZXJhZ2VTdGFydDptKyItMDEiLGNvdmVyYWdlRW5kOm0rIi0iK1N0cmluZyhuZXcgRGF0ZSh5ZWFyLG1vbnRoLDApLmdldERhdGUoKSkucGFkU3RhcnQoMiwiMCIpLGJsb2NrZWQ6ZmFsc2V9KTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIFsuLi5tYXAudmFsdWVzKCldOwogIH0KICBjb25zdCBjbGltYXRlRm10PSh2LGQ9MCk9Pk51bWJlci5pc0Zpbml0ZSh2KT9udW0odixkKToi4oCTIjsKICBmdW5jdGlvbiBjbGltYXRlV2VhdGhlckZvcihtb250aCl7cmV0dXJuIGNsaW1hdGVXZWF0aGVyPy5bbW9udGguc2xpY2UoMCw0KV0/Lm1vbnRocz8uZmluZCh4PT54Lm1vbnRoPT09bW9udGgpfHxudWxsO30KICBmdW5jdGlvbiBjbGltYXRlUm93c0Zvcih5ZWFyKXsKICAgIGNvbnN0IHJlZmVyZW5jZT1uZXcgTWFwKCk7CiAgICBmb3IobGV0IGk9MTtpPD0xMjtpKyspewogICAgICBjb25zdCBtbT1TdHJpbmcoaSkucGFkU3RhcnQoMiwiMCIpOwogICAgICBjb25zdCBoaXN0PVsyMDI0LDIwMjVdLm1hcCh5PT5jbGltYXRlV2VhdGhlckZvcih5KyItIittbSkpLmZpbHRlcih3PT53Py5jb21wbGV0ZSYmTnVtYmVyLmlzRmluaXRlKHcuaGRkMTUpKTsKICAgICAgaWYoaGlzdC5sZW5ndGg9PT0yKXJlZmVyZW5jZS5zZXQobW0sKGhpc3RbMF0uaGRkMTUraGlzdFsxXS5oZGQxNSkvMik7CiAgICB9CiAgICByZXR1cm4gQXJyYXkuZnJvbSh7bGVuZ3RoOjEyfSwoXyxpKT0+ewogICAgICBjb25zdCBtb250aD15ZWFyKyItIitTdHJpbmcoaSsxKS5wYWRTdGFydCgyLCIwIik7CiAgICAgIGNvbnN0IHI9cmVjb3JkRm9yTW9udGgobW9udGgpLHc9Y2xpbWF0ZVdlYXRoZXJGb3IobW9udGgpLHNlbnNvcj1jbGltYXRlTW9udGhzLmZpbmQoeD0+eC5tb250aD09PW1vbnRoKSx2YWxpZD13Py5jb21wbGV0ZSYmTnVtYmVyLmlzRmluaXRlKHcuaGRkMTUpOwogICAgICBjb25zdCBoZWF0PU51bWJlci5pc0Zpbml0ZShyPy5oZWF0aW5nSGVhdCk/ci5oZWF0aW5nSGVhdDpudWxsOwogICAgICBjb25zdCBkaHc9TnVtYmVyLmlzRmluaXRlKHI/LmRod0hlYXQpP3IuZGh3SGVhdDpudWxsOwogICAgICBjb25zdCBiYXNlbGluZT1yZWZlcmVuY2UuZ2V0KG1vbnRoLnNsaWNlKDUpKTsKICAgICAgY29uc3Qgbm9ybWFsaXplZD1oZWF0IT09bnVsbCYmdmFsaWQmJncuaGRkMTU+MSYmTnVtYmVyLmlzRmluaXRlKGJhc2VsaW5lKT9oZWF0KmJhc2VsaW5lL3cuaGRkMTU6bnVsbDsKICAgICAgcmV0dXJuIHttb250aCx3LHNlbnNvcixoZWF0LGRodyx2YWxpZCxub3JtYWxpemVkfTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQ2xpbWF0ZU11bHRpWWVhcigpewogICAgY29uc3QgZWw9JCgiY2xpbWF0ZU11bHRpWWVhciIpO2lmKCFlbClyZXR1cm47CiAgICBjb25zdCBhdmFpbGFibGU9Wy4uLm5ldyBTZXQocmVjb3Jkcy5tYXAocj0+TnVtYmVyKHIubW9udGg/LnNsaWNlKDAsNCkpKSldLmZpbHRlcih5PT55Pj0yMDI0JiZ5PD1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkpLnNvcnQoKTsKICAgIGNvbnN0IGNhbmRpZGF0ZXM9YXZhaWxhYmxlLm1hcCh5PT4oe3llYXI6eSxyb3dzOmNsaW1hdGVSb3dzRm9yKHkpfSkpLmZpbHRlcih4PT54LnJvd3MuZmlsdGVyKHI9PnIubm9ybWFsaXplZCE9PW51bGwpLmxlbmd0aD49Myk7CiAgICBpZihjYW5kaWRhdGVzLmxlbmd0aDwyKXtlbC50ZXh0Q29udGVudD0iRGVyIGRpcmVrdGUgSmFocmVzdmVyZ2xlaWNoIGVyc2NoZWludCwgc29iYWxkIG1pbmRlc3RlbnMgendlaSBKYWhyZSBqZXdlaWxzIGRyZWkgdm9sbHN0w6RuZGlnZSB2ZXJnbGVpY2hiYXJlIE1vbmF0ZSBtaXQgSGVpenfDpHJtZSB1bmQgV2V0dGVyZGF0ZW4gYmVzaXR6ZW4uIjtyZXR1cm47fQogICAgY29uc3QgbW9udGhzPUFycmF5LmZyb20oe2xlbmd0aDoxMn0sKF8saSk9PmkrMSkuZmlsdGVyKG09PmNhbmRpZGF0ZXMuZXZlcnkoYz0+Yy5yb3dzW20tMV0/Lm5vcm1hbGl6ZWQhPT1udWxsKSk7CiAgICBpZihtb250aHMubGVuZ3RoPDMpe2VsLnRleHRDb250ZW50PSJGw7xyIGRpZXNlIEphaHJlIGdpYnQgZXMgbm9jaCBuaWNodCBnZW7DvGdlbmQgZ2VtZWluc2FtZSBNb25hdGUuIEZlaGxlbmRlIFZhaWxsYW50LVfDpHJtZS0gb2RlciBXZXR0ZXJ3ZXJ0ZSBlcmfDpG56ZW4uIjtyZXR1cm47fQogICAgY29uc3QgYmFzZVllYXI9Y2FuZGlkYXRlc1swXS55ZWFyLGJhc2VIZWF0PW1vbnRocy5yZWR1Y2UoKHMsbSk9PnMrY2FuZGlkYXRlc1swXS5yb3dzW20tMV0ubm9ybWFsaXplZCwwKTsKICAgIGNvbnN0IGhlYWRlcj0nPHAgY2xhc3M9Im11dGVkIj5EaXJla3R2ZXJnbGVpY2ggbnVyIGdsZWljaGVyLCB2b2xsc3TDpG5kaWcgZXJmYXNzdGVyIE1vbmF0ZTogJyttb250aHMubWFwKG09Pk1PTlRIU1ttLTFdKS5qb2luKCIsICIpKycuIFdhcm13YXNzZXIgaXN0IGF1c2dlc2NobG9zc2VuLjwvcD4nOwogICAgY29uc3QgdGFibGU9JzxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPkphaHI8L3RoPjx0aD5IZWl6d8Okcm1lIGdlbWVzc2VuIGtXaDwvdGg+PHRoPldpdHRlcnVuZ3NiZXJlaW5pZ3Qga1doPC90aD48dGg+R2VnZW7DvGJlciAnK2Jhc2VZZWFyKyc8L3RoPjwvdHI+PC90aGVhZD48dGJvZHk+JysKICAgICAgY2FuZGlkYXRlcy5tYXAoYz0+ewogICAgICAgIGNvbnN0IG9yaWdpbmFsPW1vbnRocy5yZWR1Y2UoKHMsbSk9PnMrYy5yb3dzW20tMV0uaGVhdCwwKTsKICAgICAgICBjb25zdCBhZGp1c3RlZD1tb250aHMucmVkdWNlKChzLG0pPT5zK2Mucm93c1ttLTFdLm5vcm1hbGl6ZWQsMCk7CiAgICAgICAgY29uc3QgZGVsdGE9YmFzZUhlYXQ+MD8oYWRqdXN0ZWQvYmFzZUhlYXQtMSkqMTAwOm51bGw7CiAgICAgICAgcmV0dXJuICc8dHI+PHRkPicrYy55ZWFyKyc8L3RkPjx0ZD4nK251bShvcmlnaW5hbCkrJzwvdGQ+PHRkPicrbnVtKGFkanVzdGVkKSsnPC90ZD48dGQ+JysoZGVsdGE9PT1udWxsPyLigJMiOnBjdChkZWx0YSkpKyc8L3RkPjwvdHI+JzsKICAgICAgfSkuam9pbigiIikrJzwvdGJvZHk+PC90YWJsZT48L2Rpdj4nOwogICAgZWwuaW5uZXJIVE1MPWhlYWRlcit0YWJsZTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckNsaW1hdGVBbmFseXNpcygpewogICAgaWYoISQoImNsaW1hdGVNZXRyaWNzIikpcmV0dXJuOwogICAgY29uc3QgeWVhcj1OdW1iZXIoJCgiYW5hbHlzaXNZZWFyIikudmFsdWUpfHxuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkscm93cz1jbGltYXRlUm93c0Zvcih5ZWFyKTsKICAgIGNvbnN0IGg9cm93cy5maWx0ZXIoeD0+eC5oZWF0IT09bnVsbCksdz1yb3dzLmZpbHRlcih4PT54LmRodyE9PW51bGwpLG49cm93cy5maWx0ZXIoeD0+eC5ub3JtYWxpemVkIT09bnVsbCksd2VhdGhlcj1yb3dzLmZpbHRlcih4PT54LnZhbGlkKTsKICAgIGNvbnN0IG1ldHJpY3M9WwogICAgICBbIkhlaXp3w6RybWUiLGgubGVuZ3RoP2NsaW1hdGVGbXQoaC5yZWR1Y2UoKHMseCk9PnMreC5oZWF0LDApKSsiIGtXaCI6IuKAkyIsaC5sZW5ndGgrIiBNb25hdGUiXSwKICAgICAgWyJXYXJtd2Fzc2Vyd8Okcm1lIix3Lmxlbmd0aD9jbGltYXRlRm10KHcucmVkdWNlKChzLHgpPT5zK3guZGh3LDApKSsiIGtXaCI6IuKAkyIsIm9obmUgV2l0dGVydW5nc2JlcmVpbmlndW5nIl0sCiAgICAgIFsiSGVpemdyYWR0YWdlIix3ZWF0aGVyLmxlbmd0aD9jbGltYXRlRm10KHdlYXRoZXIucmVkdWNlKChzLHgpPT5zK3gudy5oZGQxNSwwKSkrIiBLwrdkIjoi4oCTIiwiQmFzaXMgMTUgwrBDOyB2b2xsc3TDpG5kaWdlIE1vbmF0ZSJdLAogICAgICBbIkJlcmVpbmlndGUgSGVpenfDpHJtZSIsbi5sZW5ndGg/Y2xpbWF0ZUZtdChuLnJlZHVjZSgocyx4KT0+cyt4Lm5vcm1hbGl6ZWQsMCkpKyIga1doIjoi4oCTIixuLmxlbmd0aCsiIHZlcmdsZWljaGJhcmUgTW9uYXRlIl0KICAgIF07CiAgICAkKCJjbGltYXRlTWV0cmljcyIpLmlubmVySFRNTD1tZXRyaWNzLm1hcCgoW2EsYixjXSk9Pic8YXJ0aWNsZT48c3Bhbj4nK2VzY2FwZUh0bWwoYSkrJzwvc3Bhbj48c3Ryb25nPicrZXNjYXBlSHRtbChiKSsnPC9zdHJvbmc+PHNtYWxsPicrZXNjYXBlSHRtbChjKSsnPC9zbWFsbD48L2FydGljbGU+Jykuam9pbigiIik7CiAgICAkKCJjbGltYXRlUm93cyIpLmlubmVySFRNTD1yb3dzLm1hcCh4PT4nPHRyPjx0ZD4nK2VzY2FwZUh0bWwobW9udGhMYWJlbCh4Lm1vbnRoLGZhbHNlKSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4Lnc/Lm1lYW5UZW1wLDEpKyc8L3RkPjx0ZD4nK2NsaW1hdGVGbXQoeC5zZW5zb3I/Lm91dGRvb3JNZWFuLDEpKyc8L3RkPjx0ZD4nK2NsaW1hdGVGbXQoeC5zZW5zb3I/LnJvb21NZWFuLDEpKyc8L3RkPjx0ZD4nK2NsaW1hdGVGbXQoeC5zZW5zb3I/LmRod01lYW4sMSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LnZhbGlkP3gudy5oZGQxNTpudWxsKSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHguaGVhdCkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LmRodykrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4Lm5vcm1hbGl6ZWQpKyc8L3RkPjwvdHI+Jykuam9pbigiIik7CiAgICByZW5kZXJDbGltYXRlTXVsdGlZZWFyKCk7CiAgICAkKCJjbGltYXRlSW5mbyIpLnRleHRDb250ZW50PShjbGltYXRlQnVzeT8iSGlzdG9yaXNjaGUgV2V0dGVyZGF0ZW4gd2VyZGVuIGdlbGFkZW4g4oCmICI6IiIpKyhuLmxlbmd0aD9uLmxlbmd0aCsiIHdpdHRlcnVuZ3NiZXJlaW5pZ3RlIE1vbmF0ZS4iOiJCaXR0ZSBoaXN0b3Jpc2NoZSBXZXR0ZXJkYXRlbiBsYWRlbi4gIikrIlJlZmVyZW56IGplIEthbGVuZGVybW9uYXQ6IEhlaXpncmFkdGFnZSAyMDI0LzIwMjUuIE51ciBnbGVpY2hlIFplaXRyw6R1bWUgdmVyZ2xlaWNoZW4sIFdhcm13YXNzZXIgZ2V0cmVubnQuIjsKICB9CiAgYXN5bmMgZnVuY3Rpb24gbG9hZENsaW1hdGVXZWF0aGVyKCl7CiAgICBpZihjbGltYXRlQnVzeSlyZXR1cm47CiAgICBpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXt0b2FzdCgiRWxkZWhvZi1BcHAtU2NobMO8c3NlbCB1bnRlciBEYXRlbiDihpIgT3N0cm9tIHNwZWljaGVybiIpO3JldHVybjt9CiAgICBjbGltYXRlQnVzeT10cnVlO2NsaW1hdGVXZWF0aGVyRXJyb3I9IiI7cmVuZGVyQ2xpbWF0ZUFuYWx5c2lzKCk7cmVuZGVyRGFzaGJvYXJkQ2xpbWF0ZSgpOwogICAgdHJ5ewogICAgICBjb25zdCB5ZWFycz1bLi4ubmV3IFNldChbLi4ucmVjb3Jkcy5tYXAocj0+TnVtYmVyKHIubW9udGguc2xpY2UoMCw0KSkpLDIwMjQsMjAyNV0pXS5maWx0ZXIoeT0+eT49MjAyMyYmeTw9bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpKS5zb3J0KCk7CiAgICAgIGZvcihjb25zdCB5ZWFyIG9mIHllYXJzKXsKICAgICAgICBpZihjbGltYXRlV2VhdGhlcj8uW3llYXJdPy5jb21wbGV0ZSYmRGF0ZS5ub3coKS1EYXRlLnBhcnNlKGNsaW1hdGVXZWF0aGVyW3llYXJdLmNhY2hlZEF0fHwiIik8OTAqODY0MDBlMyljb250aW51ZTsKICAgICAgICBjb25zdCByZXNwb25zZT1hd2FpdCBmZXRjaCgiL2FwaS93ZWF0aGVyL2FyY2hpdmU/eWVhcj0iK3llYXIse2hlYWRlcnM6eyJ4LWVsZGVob2Yta2V5IjpzZXR0aW5ncy5vc3Ryb21BcHBLZXl9LGNhY2hlOiJuby1zdG9yZSJ9KTsKICAgICAgICBjb25zdCBwYXlsb2FkPWF3YWl0IHJlc3BvbnNlLmpzb24oKTsKICAgICAgICBpZighcmVzcG9uc2Uub2spdGhyb3cgRXJyb3IocGF5bG9hZC5lcnJvcnx8Ikhpc3RvcmlzY2hlIFdldHRlcmRhdGVuIGZlaGxlbiIpOwogICAgICAgIGNsaW1hdGVXZWF0aGVyW3llYXJdPXBheWxvYWQ7CiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oQ0xJTUFURV9XRUFUSEVSX0tFWSxKU09OLnN0cmluZ2lmeShjbGltYXRlV2VhdGhlcikpOwogICAgICAgIHJlbmRlckNsaW1hdGVBbmFseXNpcygpO3JlbmRlckRhc2hib2FyZENsaW1hdGUoKTsKICAgICAgfQogICAgICB0b2FzdCgiV2V0dGVyaGlzdG9yaWUgYWt0dWFsaXNpZXJ0Iik7CiAgICB9Y2F0Y2goZSl7Y2xpbWF0ZVdlYXRoZXJFcnJvcj1lLm1lc3NhZ2U7dG9hc3QoIldldHRlcjogIitlLm1lc3NhZ2UpO30KICAgIGZpbmFsbHl7Y2xpbWF0ZUJ1c3k9ZmFsc2U7cmVuZGVyQ2xpbWF0ZUFuYWx5c2lzKCk7cmVuZGVyRGFzaGJvYXJkQ2xpbWF0ZSgpO30KICB9CgogIGZ1bmN0aW9uIHNhZmVKc29uUGFyc2UodmFsdWUsIGZhbGxiYWNrPW51bGwpeyB0cnl7cmV0dXJuIEpTT04ucGFyc2UodmFsdWUpO31jYXRjaHtyZXR1cm4gZmFsbGJhY2s7fSB9CiAgZnVuY3Rpb24gbnVsbGFibGVOdW1iZXIodmFsdWUpeyBpZih2YWx1ZT09PSIifHx2YWx1ZT09PW51bGx8fHZhbHVlPT09dW5kZWZpbmVkKXJldHVybiBudWxsOyBjb25zdCBuPU51bWJlcih2YWx1ZSk7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUobik/bjpudWxsOyB9CiAgZnVuY3Rpb24gc29ydGVkKGl0ZW1zPXJlY29yZHMpeyByZXR1cm4gWy4uLml0ZW1zXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOyB9CiAgZnVuY3Rpb24gY3VycmVudE1vbnRoS2V5KCl7IGNvbnN0IGQ9bmV3IERhdGUoKTsgcmV0dXJuIGAke2QuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsIjAiKX1gOyB9CiAgZnVuY3Rpb24gbW9udGhMYWJlbChtb250aCxsb25nPXRydWUpeyBjb25zdCBbeSxtXT1TdHJpbmcobW9udGgpLnNwbGl0KCItIikubWFwKE51bWJlcik7IGlmKCF5fHwhbSlyZXR1cm4gbW9udGg7IHJldHVybiBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLGxvbmc/e21vbnRoOiJsb25nIix5ZWFyOiJudW1lcmljIn06e21vbnRoOiJzaG9ydCIseWVhcjoiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUoeSxtLTEsMSkpOyB9CiAgZnVuY3Rpb24gbnVtKHZhbHVlLGRpZ2l0cz0wKXsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIodmFsdWUpKT9uZXcgSW50bC5OdW1iZXJGb3JtYXQoImRlLURFIix7bWluaW11bUZyYWN0aW9uRGlnaXRzOmRpZ2l0cyxtYXhpbXVtRnJhY3Rpb25EaWdpdHM6ZGlnaXRzfSkuZm9ybWF0KE51bWJlcih2YWx1ZSkpOiLigJMiOyB9CiAgZnVuY3Rpb24gZXVybyh2YWx1ZSl7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHZhbHVlKSk/bmV3IEludGwuTnVtYmVyRm9ybWF0KCJkZS1ERSIse3N0eWxlOiJjdXJyZW5jeSIsY3VycmVuY3k6IkVVUiJ9KS5mb3JtYXQoTnVtYmVyKHZhbHVlKSk6IuKAkyI7IH0KICBmdW5jdGlvbiBwY3QodmFsdWUpeyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcih2YWx1ZSkpP2Ake3ZhbHVlPjA/IisiOiIifSR7bnVtKHZhbHVlLDEpfSAlYDoi4oCTIjsgfQogIGZ1bmN0aW9uIGVzY2FwZUh0bWwodmFsdWUpeyByZXR1cm4gU3RyaW5nKHZhbHVlPz8iIikucmVwbGFjZSgvWyY8PiInXS9nLGNoPT4oeyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwiXCIiOiImcXVvdDsiLCInIjoiJiMzOTsifVtjaF0pKTsgfQogIGZ1bmN0aW9uIGNzdkNlbGwodmFsdWUpeyBjb25zdCBzPVN0cmluZyh2YWx1ZT8/IiIpOyByZXR1cm4gYCIke3MucmVwbGFjZSgvIi9nLCciIicpfSJgOyB9CiAgZnVuY3Rpb24gZGF0ZVN0YW1wKCl7IGNvbnN0IGQ9bmV3IERhdGUoKTsgcmV0dXJuIGAke2QuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsIjAiKX0tJHtTdHJpbmcoZC5nZXREYXRlKCkpLnBhZFN0YXJ0KDIsIjAiKX1gOyB9CgogIGZ1bmN0aW9uIHNhbml0aXplUmVjb3JkKHJhdyl7CiAgICBjb25zdCBtb250aD1TdHJpbmcocmF3Py5tb250aHx8IiIpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0kLy50ZXN0KG1vbnRoKSlyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7CiAgICAgIG1vbnRoLAogICAgICBoZWF0UHVtcDpudWxsYWJsZU51bWJlcihyYXcuaGVhdFB1bXApLAogICAgICBhbm5leDpudWxsYWJsZU51bWJlcihyYXcuYW5uZXgpLAogICAgICB0b3RhbDpudWxsYWJsZU51bWJlcihyYXcudG90YWwpLAogICAgICBwcmljZUN0Om51bGxhYmxlTnVtYmVyKHJhdy5wcmljZUN0ID8/IHJhdy5hdmVyYWdlUHJpY2VDdCksCiAgICAgIGJhc2VGZWU6bnVsbGFibGVOdW1iZXIocmF3LmJhc2VGZWUpLAogICAgICBub3RlOlN0cmluZyhyYXcubm90ZXx8IiIpLnRyaW0oKS5zbGljZSgwLDgwMCksCiAgICAgIGhlYXRHZW5lcmF0ZWQ6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRHZW5lcmF0ZWQpLAogICAgICBoZWF0aW5nRWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRpbmdFbGVjdHJpY2l0eSksCiAgICAgIGRod0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKHJhdy5kaHdFbGVjdHJpY2l0eSksCiAgICAgIGhlYXRpbmdIZWF0Om51bGxhYmxlTnVtYmVyKHJhdy5oZWF0aW5nSGVhdCksCiAgICAgIGRod0hlYXQ6bnVsbGFibGVOdW1iZXIocmF3LmRod0hlYXQpLAogICAgICBoZWF0UHVtcFNvdXJjZTpTdHJpbmcocmF3LmhlYXRQdW1wU291cmNlfHwiIikuc2xpY2UoMCw2MCksCiAgICAgIGhlYXRQdW1wVXBkYXRlZEF0OnJhdy5oZWF0UHVtcFVwZGF0ZWRBdD9TdHJpbmcocmF3LmhlYXRQdW1wVXBkYXRlZEF0KTpudWxsLAogICAgICBtZXRlclJlYWRpbmdEYXRlOnJhdy5tZXRlclJlYWRpbmdEYXRlP1N0cmluZyhyYXcubWV0ZXJSZWFkaW5nRGF0ZSk6bnVsbCwKICAgICAgcHJldmlvdXNNZXRlclJlYWRpbmdEYXRlOnJhdy5wcmV2aW91c01ldGVyUmVhZGluZ0RhdGU/U3RyaW5nKHJhdy5wcmV2aW91c01ldGVyUmVhZGluZ0RhdGUpOm51bGwsCiAgICAgIHRvdGFsTWV0ZXJSZWFkaW5nOm51bGxhYmxlTnVtYmVyKHJhdy50b3RhbE1ldGVyUmVhZGluZyksCiAgICAgIGFubmV4TWV0ZXJSZWFkaW5nOm51bGxhYmxlTnVtYmVyKHJhdy5hbm5leE1ldGVyUmVhZGluZyksCiAgICAgIG1ldGVyU291cmNlOlN0cmluZyhyYXcubWV0ZXJTb3VyY2V8fCIiKS5zbGljZSgwLDYwKSwKICAgICAgcHJpY2VTb3VyY2U6U3RyaW5nKHJhdy5wcmljZVNvdXJjZXx8IiIpLnNsaWNlKDAsODApLAogICAgICBwcmljZVVwZGF0ZWRBdDpyYXcucHJpY2VVcGRhdGVkQXQ/U3RyaW5nKHJhdy5wcmljZVVwZGF0ZWRBdCk6bnVsbCwKICAgICAgb3N0cm9tVmFyaWFibGVDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy5vc3Ryb21WYXJpYWJsZUNvc3RFdXIpLAogICAgICBvc3Ryb21Ub3RhbENvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3Lm9zdHJvbVRvdGFsQ29zdEV1ciksCiAgICAgIG9zdHJvbUNvbnN1bXB0aW9uS1doOm51bGxhYmxlTnVtYmVyKHJhdy5vc3Ryb21Db25zdW1wdGlvbktXaCksCiAgICAgIG9zdHJvbVByaWNlQ29tcGxldGU6Qm9vbGVhbihyYXcub3N0cm9tUHJpY2VDb21wbGV0ZSksCiAgICAgIHVwZGF0ZWRBdDpyYXcudXBkYXRlZEF0P1N0cmluZyhyYXcudXBkYXRlZEF0KTpudWxsLAogICAgICBjbG9zZWQ6Qm9vbGVhbihyYXcuY2xvc2VkKSwKICAgICAgY2xvc2VkQXQ6cmF3LmNsb3NlZEF0P1N0cmluZyhyYXcuY2xvc2VkQXQpOm51bGwKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplUmVjb3JkcyhpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHJhdyBvZiBBcnJheS5pc0FycmF5KGl0ZW1zKT9pdGVtczpbXSl7IGNvbnN0IHI9c2FuaXRpemVSZWNvcmQocmF3KTsgaWYociltYXAuc2V0KHIubW9udGgscik7IH0KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOwogIH0KICBmdW5jdGlvbiBkZXJpdmVkKHIpeyBpZighW3I/LmhlYXRQdW1wLHI/LmFubmV4LHI/LnRvdGFsXS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpKXJldHVybiBudWxsOyByZXR1cm4gci50b3RhbC1yLmhlYXRQdW1wLXIuYW5uZXg7IH0KICBmdW5jdGlvbiBjb21wbGV0ZShyKXsgY29uc3QgcmVzdD1kZXJpdmVkKHIpOyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0Pj0wOyB9CiAgZnVuY3Rpb24gcmVjb3JkQ29zdChyKXsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShyPy5vc3Ryb21Ub3RhbENvc3RFdXIpJiZyPy5vc3Ryb21QcmljZUNvbXBsZXRlKXJldHVybiBOdW1iZXIoci5vc3Ryb21Ub3RhbENvc3RFdXIpOwogICAgaWYoIU51bWJlci5pc0Zpbml0ZShyPy50b3RhbCkpcmV0dXJuIG51bGw7CiAgICBjb25zdCBwcmljZT1OdW1iZXIuaXNGaW5pdGUoci5wcmljZUN0KT9yLnByaWNlQ3QvMTAwOk51bWJlcihzZXR0aW5ncy5mYWxsYmFja1ByaWNlfHwwLjMyKTsKICAgIGNvbnN0IGJhc2U9TnVtYmVyLmlzRmluaXRlKHIuYmFzZUZlZSk/ci5iYXNlRmVlOk51bWJlcihzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZXx8MCk7CiAgICByZXR1cm4gci50b3RhbCpwcmljZStiYXNlOwogIH0KICBmdW5jdGlvbiByZWNvcmRDb3Aocil7IHJldHVybiBOdW1iZXIocj8uaGVhdFB1bXApPjAmJk51bWJlci5pc0Zpbml0ZShOdW1iZXIocj8uaGVhdEdlbmVyYXRlZCkpP051bWJlcihyLmhlYXRHZW5lcmF0ZWQpL051bWJlcihyLmhlYXRQdW1wKTpudWxsOyB9CgogIGZ1bmN0aW9uIHJhd1NldHRpbmdzKCl7IGNvbnN0IHY9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTRVRUSU5HU19LRVkpLHt9KTsgcmV0dXJuIHYmJnR5cGVvZiB2PT09Im9iamVjdCImJiFBcnJheS5pc0FycmF5KHYpP3Y6e307IH0KICBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKXsKICAgIGNvbnN0IHJhdz1yYXdTZXR0aW5ncygpOwogICAgcmV0dXJuIHsKICAgICAgLi4ucmF3LAogICAgICBmYWxsYmFja1ByaWNlOk51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3LmZhbGxiYWNrUHJpY2UpKT9OdW1iZXIocmF3LmZhbGxiYWNrUHJpY2UpOk51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3LnByaWNlKSk/TnVtYmVyKHJhdy5wcmljZSk6MC4zMiwKICAgICAgZGVmYXVsdEJhc2VGZWU6TnVtYmVyLmlzRmluaXRlKE51bWJlcihyYXcuZGVmYXVsdEJhc2VGZWUpKT9OdW1iZXIocmF3LmRlZmF1bHRCYXNlRmVlKTowLAogICAgICBvc3Ryb21BcHBLZXk6U3RyaW5nKHJhdy5vc3Ryb21BcHBLZXl8fCIiKSwKICAgICAgb3N0cm9tQXV0b1JlZnJlc2g6cmF3Lm9zdHJvbUF1dG9SZWZyZXNoIT09ZmFsc2UsCiAgICAgIHByZWZlcnJlZFdpbmRvd0hvdXJzOlsxLDIsMyw0XS5pbmNsdWRlcyhOdW1iZXIocmF3LnByZWZlcnJlZFdpbmRvd0hvdXJzKSk/TnVtYmVyKHJhdy5wcmVmZXJyZWRXaW5kb3dIb3Vycyk6MwogICAgfTsKICB9CiAgZnVuY3Rpb24gc2F2ZVNldHRpbmdzKCl7CiAgICBjb25zdCBwcmV2aW91cz1yYXdTZXR0aW5ncygpOwogICAgY29uc3QgbWVyZ2VkPXsuLi5wcmV2aW91cywKICAgICAgZmFsbGJhY2tQcmljZTpOdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZSl8fDAsCiAgICAgIGRlZmF1bHRCYXNlRmVlOk51bWJlcihzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZSl8fDAsCiAgICAgIG9zdHJvbUFwcEtleTpTdHJpbmcoc2V0dGluZ3Mub3N0cm9tQXBwS2V5fHwiIiksCiAgICAgIG9zdHJvbUF1dG9SZWZyZXNoOnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoIT09ZmFsc2UsCiAgICAgIHByZWZlcnJlZFdpbmRvd0hvdXJzOlsxLDIsMyw0XS5pbmNsdWRlcyhOdW1iZXIoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnMpKT9OdW1iZXIoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnMpOjMKICAgIH07CiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTRVRUSU5HU19LRVksSlNPTi5zdHJpbmdpZnkobWVyZ2VkKSk7CiAgICBzZXR0aW5ncz17Li4uc2V0dGluZ3MsLi4ubWVyZ2VkfTsKICB9CgogIGZ1bmN0aW9uIHJlYWRQcmltYXJ5UmVjb3JkcygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShEQVRBX0tFWSksbnVsbCk7IHJldHVybiBBcnJheS5pc0FycmF5KHJhdyk/c2FuaXRpemVSZWNvcmRzKHJhdyk6bnVsbDsgfQogIGZ1bmN0aW9uIHJlYWRTaGFkb3dSZWNvcmRzKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNIQURPV19LRVkpLG51bGwpOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3Nhbml0aXplUmVjb3JkcyhyYXcpOltdOyB9CiAgZnVuY3Rpb24gbG9hZFJlY29yZHMoKXsKICAgIGNvbnN0IHByaW1hcnk9cmVhZFByaW1hcnlSZWNvcmRzKCk7CiAgICBpZihwcmltYXJ5IT09bnVsbClyZXR1cm4gcHJpbWFyeTsKICAgIGZvcihjb25zdCBrZXkgb2YgWyJlbGRlaG9mLXYxLWRhdGEiLCJlbmVyaGF1cy12MS1kYXRhIl0pewogICAgICBjb25zdCBsZWdhY3k9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpLG51bGwpOwogICAgICBpZihBcnJheS5pc0FycmF5KGxlZ2FjeSkpewogICAgICAgIGNvbnN0IG1pZ3JhdGVkPXNhbml0aXplUmVjb3JkcyhsZWdhY3kpOwogICAgICAgIGlmKG1pZ3JhdGVkLmxlbmd0aClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShEQVRBX0tFWSxKU09OLnN0cmluZ2lmeShtaWdyYXRlZCkpOwogICAgICAgIHJldHVybiBtaWdyYXRlZDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIFtdOwogIH0KICBmdW5jdGlvbiBzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb249IsOEbmRlcnVuZyIsYWxsb3dFbXB0eT1mYWxzZX09e30pewogICAgY29uc3QgY2xlYW49c2FuaXRpemVSZWNvcmRzKG5leHQpOwogICAgY29uc3QgcHJldmlvdXM9cmVhZFByaW1hcnlSZWNvcmRzKCl8fFtdOwogICAgaWYoIWFsbG93RW1wdHkgJiYgcHJldmlvdXMubGVuZ3RoPjAgJiYgY2xlYW4ubGVuZ3RoPT09MCl0aHJvdyBuZXcgRXJyb3IoIkxlZXJlciBNb25hdHNiZXN0YW5kIHdpcmQgYXVzIFNpY2hlcmhlaXRzZ3LDvG5kZW4gbmljaHQgYXV0b21hdGlzY2ggZ2VzcGVpY2hlcnQuIik7CiAgICBpZihwcmV2aW91cy5sZW5ndGgpewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTSEFET1dfS0VZLEpTT04uc3RyaW5naWZ5KHByZXZpb3VzKSk7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNIQURPV19NRVRBX0tFWSxKU09OLnN0cmluZ2lmeSh7c2F2ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkscmVhc29uLHJlY29yZHM6cHJldmlvdXMubGVuZ3RofSkpOwogICAgfQogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkoY2xlYW4pKTsKICAgIHJlY29yZHM9Y2xlYW47CiAgICB1cGRhdGVSZWNvdmVyeUJhbm5lcigpOwogICAgaWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygpOwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZU1ldGVyUmVhZGluZyhyYXcpewogICAgY29uc3QgZGF0ZT1TdHJpbmcocmF3Py5kYXRlfHwiIik7CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcihyYXc/LnRvdGFsKSxhbm5leD1udWxsYWJsZU51bWJlcihyYXc/LmFubmV4KTsKICAgIGlmKCEvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChkYXRlKXx8IU51bWJlci5pc0Zpbml0ZSh0b3RhbCl8fCFOdW1iZXIuaXNGaW5pdGUoYW5uZXgpfHx0b3RhbDwwfHxhbm5leDwwKXJldHVybiBudWxsOwogICAgcmV0dXJuIHtkYXRlLHRvdGFsLGFubmV4LG5vdGU6U3RyaW5nKHJhdz8ubm90ZXx8IiIpLnNsaWNlKDAsMTgwKSx1cGRhdGVkQXQ6cmF3Py51cGRhdGVkQXQ/U3RyaW5nKHJhdy51cGRhdGVkQXQpOm51bGx9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZU1ldGVyUmVhZGluZ3MoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pe2NvbnN0IHI9c2FuaXRpemVNZXRlclJlYWRpbmcocmF3KTtpZihyKW1hcC5zZXQoci5kYXRlLHIpO30KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLmRhdGUubG9jYWxlQ29tcGFyZShiLmRhdGUpKTsKICB9CiAgZnVuY3Rpb24gbG9hZE1ldGVyUmVhZGluZ3MoKXtyZXR1cm4gc2FuaXRpemVNZXRlclJlYWRpbmdzKHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oTUVURVJfS0VZKSxbXSkpO30KICBmdW5jdGlvbiBzYXZlTWV0ZXJSZWFkaW5ncyhuZXh0LHt0b3VjaD10cnVlLHRpbWVzdGFtcD1udWxsfT17fSl7bWV0ZXJSZWFkaW5ncz1zYW5pdGl6ZU1ldGVyUmVhZGluZ3MobmV4dCk7bG9jYWxTdG9yYWdlLnNldEl0ZW0oTUVURVJfS0VZLEpTT04uc3RyaW5naWZ5KG1ldGVyUmVhZGluZ3MpKTtpZih0b3VjaClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShNRVRFUl9NRVRBX0tFWSx0aW1lc3RhbXB8fG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7aWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygpO30KICBmdW5jdGlvbiBsYXRlc3RNZXRlclJlYWRpbmcoKXtyZXR1cm4gbWV0ZXJSZWFkaW5ncy5hdCgtMSl8fG51bGw7fQogIGZ1bmN0aW9uIGRhdGVMYWJlbCh2YWx1ZSl7Y29uc3QgZD1uZXcgRGF0ZShgJHt2YWx1ZX1UMTI6MDA6MDBgKTtyZXR1cm4gTnVtYmVyLmlzTmFOKGQudmFsdWVPZigpKT92YWx1ZTpuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtkYXk6IjItZGlnaXQiLG1vbnRoOiIyLWRpZ2l0Iix5ZWFyOiJudW1lcmljIn0pLmZvcm1hdChkKTt9CiAgZnVuY3Rpb24gbmV4dE1vbnRoRmlyc3QoZGF0ZSl7Y29uc3QgW3ksbV09U3RyaW5nKGRhdGUpLnNwbGl0KCItIikubWFwKE51bWJlcik7Y29uc3QgZD1uZXcgRGF0ZSh5LG0sMSk7cmV0dXJuIGAke2QuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsIjAiKX0tMDFgO30KICBmdW5jdGlvbiBhcHBseUhpc3RvcmljYWxTZWVkKCl7CiAgICBpZihsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZX1NFRURfS0VZKSlyZXR1cm47CiAgICBjb25zdCBtYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICBjb25zdCBtb250aHM9Wy4uLm5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKEhJU1RPUklDQUxfU0VFRC50b3RhbCksLi4uT2JqZWN0LmtleXMoSElTVE9SSUNBTF9TRUVELmFubmV4KSwuLi5PYmplY3Qua2V5cyhISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXApXSldLnNvcnQoKTsKICAgIGZvcihjb25zdCBtb250aCBvZiBtb250aHMpewogICAgICBjb25zdCByPW1hcC5nZXQobW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGh9KTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQudG90YWwsbW9udGgpKXIudG90YWw9SElTVE9SSUNBTF9TRUVELnRvdGFsW21vbnRoXTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQuYW5uZXgsbW9udGgpKXIuYW5uZXg9SElTVE9SSUNBTF9TRUVELmFubmV4W21vbnRoXTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXAsbW9udGgpKXsKICAgICAgICBjb25zdCBzZWVkPUhJU1RPUklDQUxfU0VFRC5oZWF0UHVtcFttb250aF07CiAgICAgICAgY29uc3Qga2VlcEV4aXN0aW5nPU51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSYmTWF0aC5hYnMoci5oZWF0UHVtcC1zZWVkKTw9MjsKICAgICAgICBpZigha2VlcEV4aXN0aW5nKXIuaGVhdFB1bXA9c2VlZDsKICAgICAgICBpZighci5oZWF0UHVtcFNvdXJjZSlyLmhlYXRQdW1wU291cmNlPSJoaXN0b3JpY2FsLXVzZXItZGF0YSI7CiAgICAgIH0KICAgICAgaWYobW9udGg9PT0iMjAyNC0wMyIpewogICAgICAgIGNvbnN0IG5vdGU9IlrDpGhsZXJ3ZWNoc2VsIEdlc2FtdHN0cm9tIGFtIDAxLjA0LjIwMjQ6IGFsdGVyIFrDpGhsZXIgNjIuMjk2IGtXaCwgbmV1ZXIgWsOkaGxlciAxOTcga1doOyBNb25hdHN2ZXJicmF1Y2gga29ycmVrdCBtaXQgMS4zMjAga1doIGJlcsO8Y2tzaWNodGlndC4iOwogICAgICAgIGlmKCFTdHJpbmcoci5ub3RlfHwiIikuaW5jbHVkZXMoIlrDpGhsZXJ3ZWNoc2VsIEdlc2FtdHN0cm9tIikpci5ub3RlPXIubm90ZT9gJHtyLm5vdGV9IOKAoiAke25vdGV9YDpub3RlOwogICAgICB9CiAgICAgIGlmKG1vbnRoPT09IjIwMjMtMTIiJiYhci5ub3RlKXIubm90ZT0iSGlzdG9yaXNjaCBpc3QgZsO8ciBEZXplbWJlciAyMDIzIG51ciBkZXIgV8Okcm1lcHVtcGVudmVyYnJhdWNoIGRva3VtZW50aWVydC4iOwogICAgICBtYXAuc2V0KG1vbnRoLHIpOwogICAgfQogICAgc2F2ZVJlY29yZHMoWy4uLm1hcC52YWx1ZXMoKV0se3JlYXNvbjoiSGlzdG9yaXNjaGUgVmVyYnJhdWNoc2RhdGVuIDIwMjTigJMwOS8yMDI2IMO8YmVybm9tbWVuIn0pOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWV9TRUVEX0tFWSxuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpOwogIH0KICBmdW5jdGlvbiBlbnN1cmVNZXRlckJhc2VsaW5lKCl7CiAgICBpZihtZXRlclJlYWRpbmdzLnNvbWUocj0+ci5kYXRlPT09QkFTRUxJTkVfTUVURVJfUkVBRElORy5kYXRlKSlyZXR1cm47CiAgICBpZihtZXRlclJlYWRpbmdzLmxlbmd0aD09PTApc2F2ZU1ldGVyUmVhZGluZ3MoW0JBU0VMSU5FX01FVEVSX1JFQURJTkddLHt0b3VjaDpmYWxzZX0pOwogIH0KICBmdW5jdGlvbiBsb2FkVmFpbGxhbnRNb250aHMoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oVkFJTExBTlRfTU9OVEhTX0tFWSksW10pOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3JhdzpbXTsgfQogIGZ1bmN0aW9uIHNhdmVWYWlsbGFudE1vbnRocygpeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShWQUlMTEFOVF9NT05USFNfS0VZLEpTT04uc3RyaW5naWZ5KEFycmF5LmlzQXJyYXkodmFpbGxhbnRNb250aHMpP3ZhaWxsYW50TW9udGhzOltdKSk7IGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoKTsgfQogIGZ1bmN0aW9uIGxvYWRPc3Ryb21DYWNoZSgpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShPU1RST01fQ0FDSEVfS0VZKSxudWxsKTsgcmV0dXJuIHJhdyYmcmF3LmdlbmVyYXRlZEF0P3JhdzpudWxsOyB9CiAgZnVuY3Rpb24gc2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQpeyBvc3Ryb21MaXZlPXBheWxvYWR8fG51bGw7IGlmKHBheWxvYWQpbG9jYWxTdG9yYWdlLnNldEl0ZW0oT1NUUk9NX0NBQ0hFX0tFWSxKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7IGVsc2UgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oT1NUUk9NX0NBQ0hFX0tFWSk7IGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoMTgwMCk7IH0KICBmdW5jdGlvbiBzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdChyYXcpewogICAgY29uc3QgbW9udGg9U3RyaW5nKHJhdz8ubW9udGh8fCIiKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChtb250aCkpcmV0dXJuIG51bGw7CiAgICByZXR1cm4gewogICAgICBtb250aCwKICAgICAgd2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2g6bnVsbGFibGVOdW1iZXIocmF3LndlaWdodGVkQXZlcmFnZUN0UGVyS1doID8/IHJhdy5wcmljZUN0KSwKICAgICAgdG90YWxLV2g6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsS1doID8/IHJhdy5vc3Ryb21Db25zdW1wdGlvbktXaCksCiAgICAgIHZhcmlhYmxlQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcudmFyaWFibGVDb3N0RXVyID8/IHJhdy5vc3Ryb21WYXJpYWJsZUNvc3RFdXIpLAogICAgICBmaXhlZENvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3LmZpeGVkQ29zdEV1ciA/PyByYXcuYmFzZUZlZSksCiAgICAgIHRvdGFsQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcudG90YWxDb3N0RXVyID8/IHJhdy5vc3Ryb21Ub3RhbENvc3RFdXIpLAogICAgICBjb21wbGV0ZTpCb29sZWFuKHJhdy5jb21wbGV0ZSA/PyByYXcub3N0cm9tUHJpY2VDb21wbGV0ZSksCiAgICAgIHBhcnRpYWw6Qm9vbGVhbihyYXcucGFydGlhbCksCiAgICAgIHVwZGF0ZWRBdDpTdHJpbmcocmF3LnVwZGF0ZWRBdHx8cmF3LnByaWNlVXBkYXRlZEF0fHwiIikKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHJhdyBvZiBBcnJheS5pc0FycmF5KGl0ZW1zKT9pdGVtczpbXSl7Y29uc3QgaXRlbT1zYW5pdGl6ZU9zdHJvbVByaWNlU3RhdChyYXcpO2lmKGl0ZW0pbWFwLnNldChpdGVtLm1vbnRoLGl0ZW0pO30KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOwogIH0KICBmdW5jdGlvbiBsb2FkT3N0cm9tUHJpY2VTdGF0cygpeyByZXR1cm4gc2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oT1NUUk9NX1BSSUNFX1NUQVRTX0tFWSksW10pKTsgfQogIGZ1bmN0aW9uIHNhdmVPc3Ryb21QcmljZVN0YXRzKGl0ZW1zKXsgb3N0cm9tUHJpY2VTdGF0cz1zYW5pdGl6ZU9zdHJvbVByaWNlU3RhdHMoaXRlbXMpO2xvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9QUklDRV9TVEFUU19LRVksSlNPTi5zdHJpbmdpZnkob3N0cm9tUHJpY2VTdGF0cykpO2lmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoMTIwMCk7IH0KICBmdW5jdGlvbiB1cHNlcnRPc3Ryb21QcmljZVN0YXQobW9udGgsZGF0YSx7cGFydGlhbD1mYWxzZX09e30pewogICAgaWYoIS9eXGR7NH0tXGR7Mn0kLy50ZXN0KFN0cmluZyhtb250aHx8IiIpKSlyZXR1cm47CiAgICBjb25zdCBtYXA9bmV3IE1hcChvc3Ryb21QcmljZVN0YXRzLm1hcChpdGVtPT5baXRlbS5tb250aCxpdGVtXSkpOwogICAgbWFwLnNldChtb250aCxzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdCh7CiAgICAgIG1vbnRoLHdlaWdodGVkQXZlcmFnZUN0UGVyS1doOk51bWJlcihkYXRhPy53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCksdG90YWxLV2g6TnVtYmVyKGRhdGE/LnRvdGFsS1doKSx2YXJpYWJsZUNvc3RFdXI6TnVtYmVyKGRhdGE/LnZhcmlhYmxlQ29zdEV1ciksZml4ZWRDb3N0RXVyOk51bWJlcihkYXRhPy5maXhlZENvc3RFdXIpLHRvdGFsQ29zdEV1cjpOdW1iZXIoZGF0YT8udG90YWxDb3N0RXVyKSxjb21wbGV0ZTpCb29sZWFuKGRhdGE/LmNvbXBsZXRlKSxwYXJ0aWFsLHVwZGF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkKICAgIH0pKTsKICAgIHNhdmVPc3Ryb21QcmljZVN0YXRzKFsuLi5tYXAudmFsdWVzKCldKTsKICB9CgogIGZ1bmN0aW9uIHVwZGF0ZVJlY292ZXJ5QmFubmVyKCl7CiAgICBjb25zdCBwcmltYXJ5PXJlYWRQcmltYXJ5UmVjb3JkcygpOwogICAgY29uc3Qgc2hhZG93PXJlYWRTaGFkb3dSZWNvcmRzKCk7CiAgICBjb25zdCBzaG93PSghcHJpbWFyeXx8cHJpbWFyeS5sZW5ndGg9PT0wKSYmc2hhZG93Lmxlbmd0aD4wOwogICAgJCgicmVjb3ZlcnlCYW5uZXIiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFzaG93KTsKICB9CiAgZnVuY3Rpb24gcmVzdG9yZVNoYWRvdygpewogICAgY29uc3Qgc2hhZG93PXJlYWRTaGFkb3dSZWNvcmRzKCk7CiAgICBpZighc2hhZG93Lmxlbmd0aClyZXR1cm47CiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShEQVRBX0tFWSxKU09OLnN0cmluZ2lmeShzaGFkb3cpKTsKICAgIHJlY29yZHM9c2hhZG93OwogICAgdG9hc3QoYCR7c2hhZG93Lmxlbmd0aH0gTW9uYXRzd2VydGUgd2llZGVyaGVyZ2VzdGVsbHRgKTsKICAgIHJlbmRlckFsbCgpOwogIH0KCiAgZnVuY3Rpb24gdG9hc3QobWVzc2FnZSl7IGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTsgJCgidG9hc3QiKS50ZXh0Q29udGVudD1tZXNzYWdlOyAkKCJ0b2FzdCIpLmNsYXNzTGlzdC5yZW1vdmUoImhpZGRlbiIpOyB0b2FzdFRpbWVyPXNldFRpbWVvdXQoKCk9PiQoInRvYXN0IikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIiksMjYwMCk7IH0KICBmdW5jdGlvbiBzZXRTdGF0dXMoaWQsdGV4dCxraW5kPSIiKXsgY29uc3QgZWw9JChpZCk7IGVsLnRleHRDb250ZW50PXRleHR8fCIiOyBlbC5jbGFzc05hbWU9YHN0YXR1cy10ZXh0ICR7a2luZH1gLnRyaW0oKTsgfQoKICBmdW5jdGlvbiBzd2l0Y2hWaWV3KGlkKXsKICAgIGN1cnJlbnRWaWV3PWlkOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLnZpZXciKS5mb3JFYWNoKHY9PnYuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIix2LmlkPT09aWQpKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5ib3R0b20tbmF2IFtkYXRhLW5hdl0iKS5mb3JFYWNoKGI9PmIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIixiLmRhdGFzZXQubmF2PT09aWQpKTsKICAgIHdpbmRvdy5zY3JvbGxUbyh7dG9wOjAsYmVoYXZpb3I6Imluc3RhbnQifSk7CiAgICBpZihpZD09PSJhbmFseXNpc1ZpZXciKXJlbmRlckFuYWx5c2lzKCk7CiAgICBpZihpZD09PSJjb25zdW1wdGlvblZpZXciKXJlbmRlclJlY29yZHMoKTsKICAgIGlmKGlkPT09ImRhdGFWaWV3IilyZW5kZXJEYXRhKCk7CiAgICBpZihpZD09PSJkYXNoYm9hcmRWaWV3IilyZW5kZXJEYXNoYm9hcmQoKTsKICB9CgogIGZ1bmN0aW9uIHllYXJzKCl7IHJldHVybiBbLi4ubmV3IFNldChyZWNvcmRzLm1hcChyPT5OdW1iZXIoci5tb250aC5zbGljZSgwLDQpKSkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkpXS5zb3J0KChhLGIpPT5iLWEpOyB9CiAgZnVuY3Rpb24gbGF0ZXN0UmVjb3JkKCl7IHJldHVybiBzb3J0ZWQoKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKS5hdCgtMSl8fHNvcnRlZCgpLmF0KC0xKXx8bnVsbDsgfQogIGZ1bmN0aW9uIHJlY29yZEZvck1vbnRoKG1vbnRoKXsgcmV0dXJuIHJlY29yZHMuZmluZChyPT5yLm1vbnRoPT09bW9udGgpfHxudWxsOyB9CgoKICAvKiBFbGRlaG9mIDYuMy4xOiBjbGltYXRlIG92ZXJ2aWV3LCBiYXNlZCBleGNsdXNpdmVseSBvbiBleGlzdGluZyBsb2NhbC9zeW5jZWQgbW9udGhseSBkYXRhLiAqLwogIGxldCBkYXNoYm9hcmRDbGltYXRlTW9kZT0iaGVhdCI7CiAgbGV0IGNsaW1hdGVXZWF0aGVyRXJyb3I9IiI7CiAgZnVuY3Rpb24gZGFzaGJvYXJkQ2xpbWF0ZURhdGEoKXsKICAgIGNvbnN0IGtleXM9Wy4uLm5ldyBTZXQoWy4uLnJlY29yZHMubWFwKHI9PnIubW9udGgpLC4uLmNsaW1hdGVNb250aHMubWFwKHI9PnIubW9udGgpXSldCiAgICAgIC5maWx0ZXIoaz0+L15cZHs0fS1cZHsyfSQvLnRlc3QoaykpLnNvcnQoKTsKICAgIGNvbnN0IGVuZD1rZXlzLmF0KC0xKXx8Y3VycmVudE1vbnRoS2V5KCk7CiAgICBjb25zdCB5ZWFyPU51bWJlcihlbmQuc2xpY2UoMCw0KSksbW9udGg9TnVtYmVyKGVuZC5zbGljZSg1LDcpKTsKICAgIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6Nn0sKF8saSk9PnsKICAgICAgY29uc3QgZD1uZXcgRGF0ZSh5ZWFyLG1vbnRoLTYraSwxKTsKICAgICAgY29uc3Qga2V5PWQuZ2V0RnVsbFllYXIoKSsiLSIrU3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIik7CiAgICAgIGNvbnN0IHY9Y2xpbWF0ZVJvd3NGb3IoZC5nZXRGdWxsWWVhcigpKVtkLmdldE1vbnRoKCldOwogICAgICBjb25zdCByZWNvcmQ9cmVjb3JkRm9yTW9udGgoa2V5KTsKICAgICAgY29uc3QgcGFydGlhbD1TdHJpbmcocmVjb3JkPy5oZWF0UHVtcFNvdXJjZXx8IiIpLmluY2x1ZGVzKCJwYXJ0aWFsIik7CiAgICAgIGNvbnN0IG91dGRvb3I9TnVtYmVyLmlzRmluaXRlKHYuc2Vuc29yPy5vdXRkb29yTWVhbik/di5zZW5zb3Iub3V0ZG9vck1lYW46CiAgICAgICAgTnVtYmVyLmlzRmluaXRlKHYudz8ubWVhblRlbXApP3Yudy5tZWFuVGVtcDpudWxsOwogICAgICByZXR1cm4ge21vbnRoOmtleSxsYWJlbDpNT05USFNbZC5nZXRNb250aCgpXSxoZWF0OnBhcnRpYWw/bnVsbDp2LmhlYXQsCiAgICAgICAgbm9ybWFsaXplZDpwYXJ0aWFsP251bGw6di5ub3JtYWxpemVkLG91dGRvb3IsCiAgICAgICAgcm9vbTpOdW1iZXIuaXNGaW5pdGUodi5zZW5zb3I/LnJvb21NZWFuKT92LnNlbnNvci5yb29tTWVhbjpudWxsLAogICAgICAgIHN0b3JhZ2U6TnVtYmVyLmlzRmluaXRlKHYuc2Vuc29yPy5kaHdNZWFuKT92LnNlbnNvci5kaHdNZWFuOm51bGwscGFydGlhbH07CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyRGFzaGJvYXJkQ2xpbWF0ZSgpewogICAgaWYoISQoImRhc2hib2FyZENsaW1hdGVQYW5lbCIpKXJldHVybjsKICAgIGNvbnN0IHllYXI9bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpOwogICAgY29uc3Qgcm93cz1jbGltYXRlUm93c0Zvcih5ZWFyKS5maWx0ZXIocj0+IVN0cmluZyhyZWNvcmRGb3JNb250aChyLm1vbnRoKT8uaGVhdFB1bXBTb3VyY2V8fCIiKS5pbmNsdWRlcygicGFydGlhbCIpKTsKICAgIGNvbnN0IHZhbGlkPWtleT0+cm93cy5maWx0ZXIoeD0+TnVtYmVyLmlzRmluaXRlKHhba2V5XSkpOwogICAgY29uc3QgaGVhdGluZz12YWxpZCgiaGVhdCIpLHdhdGVyPXZhbGlkKCJkaHciKSxub3JtYWxpemVkPXZhbGlkKCJub3JtYWxpemVkIik7CiAgICBjb25zdCB3ZWF0aGVyPXJvd3MuZmlsdGVyKHg9PngudmFsaWQpOwogICAgY29uc3Qgc3VtPShpdGVtcyxrZXkpPT5pdGVtcy5yZWR1Y2UoKG4scik9Pm4rcltrZXldLDApOwogICAgY29uc3QgbWV0cmljcz1bCiAgICAgIFsiSGVpenfDpHJtZSIsaGVhdGluZy5sZW5ndGg/bnVtKHN1bShoZWF0aW5nLCJoZWF0IiksMCkrIiBrV2giOiLigJMiLGhlYXRpbmcubGVuZ3RoKyIgZXJmYXNzdGUgTW9uYXRlIl0sCiAgICAgIFsiV2FybXdhc3NlciIsd2F0ZXIubGVuZ3RoP251bShzdW0od2F0ZXIsImRodyIpLDApKyIga1doIjoi4oCTIix3YXRlci5sZW5ndGgrIiBlcmZhc3N0ZSBNb25hdGUiXSwKICAgICAgWyJIZWl6Z3JhZHRhZ2UiLHdlYXRoZXIubGVuZ3RoP251bSh3ZWF0aGVyLnJlZHVjZSgobixyKT0+bityLncuaGRkMTUsMCksMCkrIiBLwrdkIjoi4oCTIix3ZWF0aGVyLmxlbmd0aCsiIFdldHRlcm1vbmF0ZSJdLAogICAgICBbIldpdHRlcnVuZ3NiZXJlaW5pZ3QiLG5vcm1hbGl6ZWQubGVuZ3RoP251bShzdW0obm9ybWFsaXplZCwibm9ybWFsaXplZCIpLDApKyIga1doIjoi4oCTIixub3JtYWxpemVkLmxlbmd0aCsiIHZlcmdsZWljaGJhcmUgTW9uYXRlIl0KICAgIF07CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlWWVhciIpLnRleHRDb250ZW50PSJKYW51YXIgYmlzICIrTU9OVEhTW25ldyBEYXRlKCkuZ2V0TW9udGgoKV0rIiAiK3llYXIrIiDCtyBudXIgZXJmYXNzdGUsIHZvbGxzdMOkbmRpZ2UgV2VydGUiOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZU1ldHJpY3MiKS5pbm5lckhUTUw9bWV0cmljcy5tYXAobT0+IjxhcnRpY2xlPjxzcGFuPiIrZXNjYXBlSHRtbChtWzBdKSsiPC9zcGFuPjxzdHJvbmc+Iitlc2NhcGVIdG1sKG1bMV0pKyI8L3N0cm9uZz48c21hbGw+Iitlc2NhcGVIdG1sKG1bMl0pKyI8L3NtYWxsPjwvYXJ0aWNsZT4iKS5qb2luKCIiKTsKICAgIGNvbnN0IGxhdGVzdD1oZWF0aW5nLmF0KC0xKTsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdCYmY2xpbWF0ZVJvd3NGb3IoeWVhci0xKVtOdW1iZXIobGF0ZXN0Lm1vbnRoLnNsaWNlKDUsNykpLTFdOwogICAgY29uc3QgZGVsdGE9bGF0ZXN0JiZOdW1iZXIuaXNGaW5pdGUocHJldmlvdXM/LmhlYXQpJiZwcmV2aW91cy5oZWF0PjA/KGxhdGVzdC5oZWF0L3ByZXZpb3VzLmhlYXQtMSkqMTAwOm51bGw7CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlVHJlbmQiKS50ZXh0Q29udGVudD1OdW1iZXIuaXNGaW5pdGUoZGVsdGEpPwogICAgICBtb250aExhYmVsKGxhdGVzdC5tb250aCxmYWxzZSkrIiBnZWdlbsO8YmVyIFZvcmphaHIgKEhlaXp3w6RybWUsIG5pY2h0IGJlcmVpbmlndCk6ICIrcGN0KGRlbHRhKToKICAgICAgIlZvcmphaHJlc3RyZW5kIGVyc2NoZWludCBiZWkgdmVyZ2xlaWNoYmFyZW4gSGVpenfDpHJtZS1Nb25hdGVuLiI7CiAgICBjb25zdCByZWFkeT1Cb29sZWFuKGNsaW1hdGVXZWF0aGVyPy5bMjAyNF0/LmNvbXBsZXRlJiZjbGltYXRlV2VhdGhlcj8uWzIwMjVdPy5jb21wbGV0ZSk7CiAgICBjb25zdCBidXR0b249JCgiZGFzaGJvYXJkQ2xpbWF0ZVdlYXRoZXJCdG4iKTsKICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHJlYWR5JiYhY2xpbWF0ZVdlYXRoZXJFcnJvcik7CiAgICBidXR0b24uZGlzYWJsZWQ9Y2xpbWF0ZUJ1c3k7CiAgICBidXR0b24udGV4dENvbnRlbnQ9Y2xpbWF0ZUJ1c3k/IldldHRlciB3aXJkIGdlbGFkZW4g4oCmIjoiV2V0dGVyZGF0ZW4gbGFkZW4iOwogICAgY29uc3QgZGF0YT1kYXNoYm9hcmRDbGltYXRlRGF0YSgpOwogICAgY29uc3QgcGFydGlhbD1kYXRhLnNvbWUocj0+ci5wYXJ0aWFsKTsKICAgICQoImRhc2hib2FyZENsaW1hdGVTdGF0dXMiKS50ZXh0Q29udGVudD0oY2xpbWF0ZVdlYXRoZXJFcnJvcj8iV2V0dGVyOiAiK2NsaW1hdGVXZWF0aGVyRXJyb3I6CiAgICAgICFyZWFkeT8iSGlzdG9yaXNjaGUgV2V0dGVyZGF0ZW4gZmVobGVuLiBGw7xyIGRpZSBCZXJlaW5pZ3VuZyBiaXR0ZSBsYWRlbi4iOiJXZXR0ZXJyZWZlcmVueiAyMDI0LzIwMjUgdm9yaGFuZGVuLiIpKwogICAgICAocGFydGlhbD8iIEVpbiBsYXVmZW5kZXIgVGVpbG1vbmF0IGlzdCB2b24gZGVyIEhlaXp3w6RybWVzdW1tZSBhdXNnZXNjaGxvc3Nlbi4iOiIiKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRhc2hib2FyZC1jbGltYXRlLW1vZGVdIikuZm9yRWFjaChidG49PnsKICAgICAgY29uc3QgYWN0aXZlPWJ0bi5kYXRhc2V0LmRhc2hib2FyZENsaW1hdGVNb2RlPT09ZGFzaGJvYXJkQ2xpbWF0ZU1vZGU7CiAgICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLGFjdGl2ZSk7CiAgICAgIGJ0bi5zZXRBdHRyaWJ1dGUoImFyaWEtcHJlc3NlZCIsU3RyaW5nKGFjdGl2ZSkpOwogICAgfSk7CiAgICBkcmF3RGFzaGJvYXJkQ2xpbWF0ZUNoYXJ0KGRhdGEpOwogIH0KICBmdW5jdGlvbiBkcmF3RGFzaGJvYXJkQ2xpbWF0ZUNoYXJ0KGRhdGE9ZGFzaGJvYXJkQ2xpbWF0ZURhdGEoKSl7CiAgICBjb25zdCBjYW52YXM9JCgiZGFzaGJvYXJkQ2xpbWF0ZUNoYXJ0IiksYz1jYW52YXNTZXR1cChjYW52YXMpOwogICAgaWYoIWMpcmV0dXJuOwogICAgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7CiAgICBjb25zdCBsZWZ0PTQ2LHJpZ2h0PTEyLHRvcD0xNyxib3R0b209MzQscGxvdFc9d2lkdGgtbGVmdC1yaWdodCxwbG90SD1oZWlnaHQtdG9wLWJvdHRvbTsKICAgIGNvbnN0IHg9aT0+bGVmdCtwbG90VyooaSsuNSkvZGF0YS5sZW5ndGg7CiAgICBjb25zdCBoZWF0TW9kZT1kYXNoYm9hcmRDbGltYXRlTW9kZT09PSJoZWF0IjsKICAgIGNvbnN0IHNlcmllcz1oZWF0TW9kZT9bCiAgICAgIHtrZXk6ImhlYXQiLG5hbWU6IkhlaXp3w6RybWUiLGNvbG9yOkNPTE9SUy5oZWF0fSwKICAgICAge2tleToibm9ybWFsaXplZCIsbmFtZToiV2l0dGVydW5nc2JlcmVpbmlndCIsY29sb3I6Q09MT1JTLmNvbXBhcmV9CiAgICBdOlsKICAgICAge2tleToib3V0ZG9vciIsbmFtZToiQXXDn2VudGVtcGVyYXR1ciIsY29sb3I6Q09MT1JTLmJsdWV8fCIjNGQ5Y2ZmIn0sCiAgICAgIHtrZXk6InJvb20iLG5hbWU6IlJhdW10ZW1wZXJhdHVyIixjb2xvcjoiIzVmYzdjMiJ9LAogICAgICB7a2V5OiJzdG9yYWdlIixuYW1lOiJXYXJtd2Fzc2Vyc3BlaWNoZXIiLGNvbG9yOiIjZjJkMTVmIn0KICAgIF07CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlTGVnZW5kIikuaW5uZXJIVE1MPXNlcmllcy5tYXAocz0+IjxzcGFuIHN0eWxlPVwiLS1sZWdlbmQtY29sb3I6IitzLmNvbG9yKyJcIj4iK2VzY2FwZUh0bWwocy5uYW1lKSsoaGVhdE1vZGU/IiDCtyBrV2giOiIgwrcgwrBDIikrIjwvc3Bhbj4iKS5qb2luKCIiKTsKICAgIGNhbnZhcy5zZXRBdHRyaWJ1dGUoImFyaWEtbGFiZWwiLGhlYXRNb2RlPyJIZWl6d8Okcm1lIHVuZCB3aXR0ZXJ1bmdzYmVyZWluaWd0ZSBIZWl6d8Okcm1lIGRlciBsZXR6dGVuIHNlY2hzIE1vbmF0ZSI6CiAgICAgICJBdcOfZW4tLCBSYXVtLSB1bmQgV2FybXdhc3NlcnNwZWljaGVydGVtcGVyYXR1cmVuIGRlciBsZXR6dGVuIHNlY2hzIE1vbmF0ZSIpOwogICAgY29uc3QgdmFscz1kYXRhLmZsYXRNYXAocm93PT5zZXJpZXMubWFwKHM9PnJvd1tzLmtleV0pKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTsKICAgIGlmKCF2YWxzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsaGVhdE1vZGU/Ik5vY2gga2VpbmUgSGVpenfDpHJtZWRhdGVuIjoiTm9jaCBrZWluZSBUZW1wZXJhdHVyZGF0ZW4iKTtyZXR1cm47fQogICAgbGV0IGxvPWhlYXRNb2RlPzA6TWF0aC5mbG9vcihNYXRoLm1pbiguLi52YWxzKS0zKSxoaT1NYXRoLmNlaWwoTWF0aC5tYXgoLi4udmFscykqMS4xKyAoaGVhdE1vZGU/MTo0KSk7CiAgICBpZihoaTw9bG8paGk9bG8rMTsKICAgIGNvbnN0IHk9dj0+dG9wK3Bsb3RIKigxLSh2LWxvKS8oaGktbG8pKTsKICAgIGN0eC5saW5lV2lkdGg9MTtjdHguZm9udD0iMTFweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjtjdHgudGV4dEFsaWduPSJsZWZ0IjsKICAgIGZvcihsZXQgaz0wO2s8PTQ7aysrKXsKICAgICAgY29uc3Qgdj1sbysoaGktbG8pKigxLWsvNCkseXk9dG9wK3Bsb3RIKmsvNDsKICAgICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkO2N0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKGxlZnQseXkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseXkpO2N0eC5zdHJva2UoKTsKICAgICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZmlsbFRleHQobnVtKHYsMCksMyx5eSszKTsKICAgIH0KICAgIGN0eC50ZXh0QWxpZ249ImNlbnRlciI7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDsKICAgIGRhdGEuZm9yRWFjaCgocixpKT0+Y3R4LmZpbGxUZXh0KHIubGFiZWwrKHIucGFydGlhbD8iKiI6IiIpLHgoaSksaGVpZ2h0LTkpKTsKICAgIGlmKGhlYXRNb2RlKXsKICAgICAgY29uc3Qgdz1NYXRoLm1pbigzNixwbG90Vy9kYXRhLmxlbmd0aCouNDIpOwogICAgICBkYXRhLmZvckVhY2goKHIsaSk9PntpZighTnVtYmVyLmlzRmluaXRlKHIuaGVhdCkpcmV0dXJuO2N0eC5maWxsU3R5bGU9Q09MT1JTLmhlYXQ7CiAgICAgICAgY29uc3QgeXk9eShyLmhlYXQpO2N0eC5maWxsUmVjdCh4KGkpLXcvMix5eSx3LHkoMCkteXkpOwogICAgICB9KTsKICAgIH0KICAgIGNvbnN0IGxpbmVzPWhlYXRNb2RlP3Nlcmllcy5zbGljZSgxKTpzZXJpZXM7CiAgICBsaW5lcy5mb3JFYWNoKHM9PnsKICAgICAgY3R4LnN0cm9rZVN0eWxlPXMuY29sb3I7Y3R4LmZpbGxTdHlsZT1zLmNvbG9yO2N0eC5saW5lV2lkdGg9Mi44OwogICAgICBsZXQgcHJldj1mYWxzZTtjdHguYmVnaW5QYXRoKCk7CiAgICAgIGRhdGEuZm9yRWFjaCgocm93LGkpPT57CiAgICAgICAgY29uc3Qgdj1yb3dbcy5rZXldOwogICAgICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUodikpe3ByZXY9ZmFsc2U7cmV0dXJuO30KICAgICAgICBpZighcHJldiljdHgubW92ZVRvKHgoaSkseSh2KSk7ZWxzZSBjdHgubGluZVRvKHgoaSkseSh2KSk7CiAgICAgICAgcHJldj10cnVlOwogICAgICB9KTsKICAgICAgY3R4LnN0cm9rZSgpOwogICAgICBkYXRhLmZvckVhY2goKHIsaSk9PntpZighTnVtYmVyLmlzRmluaXRlKHJbcy5rZXldKSlyZXR1cm47Y3R4LmJlZ2luUGF0aCgpO2N0eC5hcmMoeChpKSx5KHJbcy5rZXldKSwzLjMsMCxNYXRoLlBJKjIpO2N0eC5maWxsKCk7fSk7CiAgICB9KTsKICAgIGN0eC50ZXh0QWxpZ249ImxlZnQiOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRGFzaGJvYXJkKCl7CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0UmVjb3JkKCk7CiAgICAkKCJsYXRlc3RNb250aFRpdGxlIikudGV4dENvbnRlbnQ9bGF0ZXN0P21vbnRoTGFiZWwobGF0ZXN0Lm1vbnRoKToiTm9jaCBrZWluZSBNb25hdHN3ZXJ0ZSI7CiAgICAkKCJlZGl0TGF0ZXN0QnRuIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhbGF0ZXN0KTsKICAgIGlmKGxhdGVzdCkkKCJlZGl0TGF0ZXN0QnRuIikuZGF0YXNldC5tb250aD1sYXRlc3QubW9udGg7CiAgICBjb25zdCByZXN0PWxhdGVzdD9kZXJpdmVkKGxhdGVzdCk6bnVsbDsKICAgIGNvbnN0IG1ldHJpY3M9bGF0ZXN0P1sKICAgICAgWyJHZXNhbXQiLGAke251bShsYXRlc3QudG90YWwsMSl9IGtXaGAsbGF0ZXN0Lm1ldGVyUmVhZGluZ0RhdGU/YGF1cyBaw6RobGVyc3RhbmQgJHtkYXRlTGFiZWwobGF0ZXN0Lm1ldGVyUmVhZGluZ0RhdGUpfWA6ImRva3VtZW50aWVydCJdLAogICAgICBbIlfDpHJtZXB1bXBlIixgJHtudW0obGF0ZXN0LmhlYXRQdW1wLDEpfSBrV2hgLE51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZsYXRlc3QudG90YWw+MCYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC5oZWF0UHVtcCk/YCR7bnVtKGxhdGVzdC5oZWF0UHVtcC9sYXRlc3QudG90YWwqMTAwLDEpfSAlIEFudGVpbGA6IuKAkyJdLAogICAgICBbIkFsdGVudGVpbCIsYCR7bnVtKGxhdGVzdC5hbm5leCwxKX0ga1doYCxsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZT9gWsOkaGxlciAke251bShsYXRlc3QuYW5uZXhNZXRlclJlYWRpbmcsMCl9IGtXaGA6TnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LmFubmV4KT9gJHtudW0obGF0ZXN0LmFubmV4L2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoi4oCTIl0sCiAgICAgIFsiU2NobGVlL0tsdXMiLGAke251bShyZXN0LDEpfSBrV2hgLE51bWJlci5pc0Zpbml0ZShyZXN0KSYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wP2Ake251bShyZXN0L2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoiYXV0b21hdGlzY2giXSwKICAgICAgWyJLb3N0ZW4iLGV1cm8ocmVjb3JkQ29zdChsYXRlc3QpKSxsYXRlc3Qub3N0cm9tUHJpY2VDb21wbGV0ZT9gT3N0cm9tIGV4YWt0IMK3ICR7bnVtKGxhdGVzdC5wcmljZUN0LDIpfSBjdC9rV2hgOk51bWJlci5pc0Zpbml0ZShsYXRlc3QucHJpY2VDdCk/YCR7bnVtKGxhdGVzdC5wcmljZUN0LDIpfSBjdC9rV2hgOiJGYWxsYmFjay1QcmVpcyJdCiAgICBdOltbIkdlc2FtdCIsIuKAkyIsIk1vbmF0IGVpbnRyYWdlbiJdLFsiV8Okcm1lcHVtcGUiLCLigJMiLCIiXSxbIkFsdGVudGVpbCIsIuKAkyIsIiJdLFsiU2NobGVlL0tsdXMiLCLigJMiLCIiXSxbIktvc3RlbiIsIuKAkyIsIiJdXTsKICAgICQoImxhdGVzdE1ldHJpY3MiKS5pbm5lckhUTUw9bWV0cmljcy5tYXAoKFtsYWJlbCx2YWx1ZSxzbWFsbF0pPT5gPGFydGljbGU+PHNwYW4+JHtsYWJlbH08L3NwYW4+PHN0cm9uZz4ke3ZhbHVlfTwvc3Ryb25nPjxzbWFsbD4ke3NtYWxsfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgY29uc3QgY29tcGFyZT1sYXRlc3Q/cmVjb3JkRm9yTW9udGgoYCR7TnVtYmVyKGxhdGVzdC5tb250aC5zbGljZSgwLDQpKS0xfS0ke2xhdGVzdC5tb250aC5zbGljZSg1LDcpfWApOm51bGw7CiAgICBjb25zdCBkZWx0YT1sYXRlc3QmJmNvbXBhcmUmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoY29tcGFyZS50b3RhbCkmJmNvbXBhcmUudG90YWwhPT0wPyhsYXRlc3QudG90YWwtY29tcGFyZS50b3RhbCkvY29tcGFyZS50b3RhbCoxMDA6bnVsbDsKICAgIGNvbnN0IGNvbXA9JCgibGF0ZXN0Q29tcGFyaXNvbiIpOwogICAgY29tcC5jbGFzc05hbWU9ImNvbXBhcmlzb24tbGluZSBuZXV0cmFsIjsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShkZWx0YSkpewogICAgICBjb21wLnRleHRDb250ZW50PWBadW0gZ2xlaWNoZW4gTW9uYXQgZGVzIFZvcmphaHJlczogJHtwY3QoZGVsdGEpfSAoJHtudW0obGF0ZXN0LnRvdGFsLWNvbXBhcmUudG90YWwsMSl9IGtXaCkuYDsKICAgICAgY29tcC5jbGFzc05hbWU9YGNvbXBhcmlzb24tbGluZSAke2RlbHRhPjA/InBvc2l0aXZlIjpkZWx0YTwwPyJuZWdhdGl2ZSI6Im5ldXRyYWwifWA7CiAgICB9ZWxzZSBjb21wLnRleHRDb250ZW50PWxhdGVzdD8iRsO8ciBkaWVzZW4gTW9uYXQgaXN0IG5vY2gga2VpbiB2b2xsc3TDpG5kaWdlciBWb3JqYWhyZXN2ZXJnbGVpY2ggdm9yaGFuZGVuLiI6IlRyYWdlIGRlbiBlcnN0ZW4gTW9uYXRzd2VydCBlaW4uIjsKICAgIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpOwogICAgcmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7CiAgICByZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJSZWNvcmRzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3Qgc2VsZWN0PSQoInJlY29yZFllYXJGaWx0ZXIiKTsKICAgIGNvbnN0IGN1cnJlbnQ9c2VsZWN0LnZhbHVlfHwiYWxsIjsKICAgIHNlbGVjdC5pbm5lckhUTUw9JzxvcHRpb24gdmFsdWU9ImFsbCI+QWxsZSBKYWhyZTwvb3B0aW9uPicreXMubWFwKHk9PmA8b3B0aW9uIHZhbHVlPSIke3l9Ij4ke3l9PC9vcHRpb24+YCkuam9pbigiIik7CiAgICBzZWxlY3QudmFsdWU9eXMuaW5jbHVkZXMoTnVtYmVyKGN1cnJlbnQpKT9jdXJyZW50OiJhbGwiOwogICAgY29uc3QgZmlsdGVyZWQ9c29ydGVkKCkucmV2ZXJzZSgpLmZpbHRlcihyPT5zZWxlY3QudmFsdWU9PT0iYWxsInx8ci5tb250aC5zdGFydHNXaXRoKGAke3NlbGVjdC52YWx1ZX0tYCkpOwogICAgJCgicmVjb3JkQ291bnQiKS50ZXh0Q29udGVudD1gJHtmaWx0ZXJlZC5sZW5ndGh9ICR7ZmlsdGVyZWQubGVuZ3RoPT09MT8iTW9uYXQiOiJNb25hdGUifWA7CiAgICBpZighZmlsdGVyZWQubGVuZ3RoKXsgJCgicmVjb3JkTGlzdCIpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPjxzdHJvbmc+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZSBpbiBkaWVzZXIgQXVzd2FobC48L3N0cm9uZz48c3Bhbj5aw6RobGVyc3TDpG5kZSB1bmQgbXlWQUlMTEFOVC1DU1YgZXJ6ZXVnZW4gZGllIE1vbmF0c3dlcnRlIGF1dG9tYXRpc2NoLjwvc3Bhbj48L2Rpdj4nOyByZXR1cm47IH0KICAgICQoInJlY29yZExpc3QiKS5pbm5lckhUTUw9ZmlsdGVyZWQubWFwKHI9PnsKICAgICAgY29uc3QgcmVzdD1kZXJpdmVkKHIpLCBpbnZhbGlkPU51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwOwogICAgICBjb25zdCBzdGF0dXM9aW52YWxpZD8iVW5wbGF1c2liZWwiOmNvbXBsZXRlKHIpPyJ2b2xsc3TDpG5kaWciOiJ1bnZvbGxzdMOkbmRpZyI7CiAgICAgIGNvbnN0IHNvdXJjZT0oci5tZXRlclJlYWRpbmdEYXRlP2Ag4oCiIFrDpGhsZXIgYmlzICR7ZGF0ZUxhYmVsKHIubWV0ZXJSZWFkaW5nRGF0ZSl9YDpyLmhlYXRQdW1wU291cmNlPy5zdGFydHNXaXRoKCJteXZhaWxsYW50Iik/IiDigKIgV8Okcm1lcHVtcGUgYXVzIENTViI6IiIpKyhyLm9zdHJvbVByaWNlQ29tcGxldGU/IiDigKIgT3N0cm9tLVByZWlzIGV4YWt0IjoiIik7CiAgICAgIHJldHVybiBgPGFydGljbGUgY2xhc3M9InJlY29yZC1yb3cgJHtpbnZhbGlkPyJpbnZhbGlkIjoiIn0iPgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC1tb250aCI+PHN0cm9uZz4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChyLm1vbnRoKSl9PC9zdHJvbmc+PHNtYWxsPiR7c3RhdHVzfSR7c291cmNlfSR7ci5ub3RlP2Ag4oCiICR7ZXNjYXBlSHRtbChyLm5vdGUuc2xpY2UoMCw3MCkpfWA6IiJ9PC9zbWFsbD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPkdlc2FtdDwvc3Bhbj48c3Ryb25nPiR7bnVtKHIudG90YWwsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+V8Okcm1lcHVtcGU8L3NwYW4+PHN0cm9uZz4ke251bShyLmhlYXRQdW1wLDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPkFsdGVudGVpbDwvc3Bhbj48c3Ryb25nPiR7bnVtKHIuYW5uZXgsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+U2NobGVlL0tsdXM8L3NwYW4+PHN0cm9uZz4ke251bShyZXN0LDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCBlZGl0LXJlY29yZCIgdHlwZT0iYnV0dG9uIiBkYXRhLWVkaXQtbW9udGg9IiR7ci5tb250aH0iPkJlYXJiZWl0ZW48L2J1dHRvbj4KICAgICAgPC9hcnRpY2xlPmA7CiAgICB9KS5qb2luKCIiKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5SZWNvcmRNb2RhbChtb250aCl7CiAgICBjb25zdCByPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgIGlmKCFyKXt0b2FzdCgiTW9uYXQgbmljaHQgZ2VmdW5kZW4iKTtyZXR1cm47fQogICAgJCgicmVjb3JkTW9kYWxUaXRsZSIpLnRleHRDb250ZW50PW1vbnRoTGFiZWwoci5tb250aCk7CiAgICAkKCJlZGl0aW5nTW9udGhPcmlnaW5hbCIpLnZhbHVlPXIubW9udGg7CiAgICAkKCJyZWNvcmRNb250aCIpLnZhbHVlPXIubW9udGg7CiAgICAkKCJyZWNvcmRUb3RhbCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLnRvdGFsKT9yLnRvdGFsOiIiOwogICAgJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCk/ci5oZWF0UHVtcDoiIjsKICAgICQoInJlY29yZEFubmV4IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuYW5uZXgpP3IuYW5uZXg6IiI7CiAgICAkKCJyZWNvcmRQcmljZUN0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIucHJpY2VDdCk/ci5wcmljZUN0OiIiOwogICAgJCgicmVjb3JkQmFzZUZlZSIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmJhc2VGZWUpP3IuYmFzZUZlZToiIjsKICAgICQoInJlY29yZEhlYXRHZW5lcmF0ZWQiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0R2VuZXJhdGVkKT9yLmhlYXRHZW5lcmF0ZWQ6IiI7CiAgICAkKCJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0aW5nRWxlY3RyaWNpdHkpP3IuaGVhdGluZ0VsZWN0cmljaXR5OiIiOwogICAgJCgicmVjb3JkRGh3RWxlY3RyaWNpdHkiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5kaHdFbGVjdHJpY2l0eSk/ci5kaHdFbGVjdHJpY2l0eToiIjsKICAgICQoInJlY29yZEhlYXRpbmdIZWF0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdGluZ0hlYXQpP3IuaGVhdGluZ0hlYXQ6IiI7CiAgICAkKCJyZWNvcmREaHdIZWF0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuZGh3SGVhdCk/ci5kaHdIZWF0OiIiOwogICAgJCgicmVjb3JkTm90ZSIpLnZhbHVlPXIubm90ZXx8IiI7CiAgICAkKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IiI7CiAgICAkKCJyZWNvcmRTb3VyY2VIaW50IikudGV4dENvbnRlbnQ9ci5tZXRlclJlYWRpbmdEYXRlCiAgICAgID8gYERpZXNlciBNb25hdCB3dXJkZSBhdXMgWsOkaGxlcnN0w6RuZGVuIGJlcmVjaG5ldC4gRWluZSBLb3JyZWt0dXIgaGllciDDpG5kZXJ0IG51ciBkZW4gTW9uYXRzd2VydDsgZGllIGdlc3BlaWNoZXJ0ZW4gWsOkaGxlcnN0w6RuZGUgYmlzICR7ZGF0ZUxhYmVsKHIubWV0ZXJSZWFkaW5nRGF0ZSl9IGJsZWliZW4gZXJoYWx0ZW4uYAogICAgICA6IHIuaGVhdFB1bXBTb3VyY2U/LnN0YXJ0c1dpdGgoIm15dmFpbGxhbnQiKQogICAgICAgID8gIkRpZSBXw6RybWVwdW1wZW53ZXJ0ZSBzdGFtbWVuIGF1cyBlaW5lciBteVZBSUxMQU5ULUNTVi4gTWFudWVsbGUgw4RuZGVydW5nZW4ga8O2bm5lbiBiZWkgZWluZW0gc3DDpHRlcmVuIGVybmV1dGVuIENTVi1JbXBvcnQgd2llZGVyIGVyc2V0enQgd2VyZGVuLiIKICAgICAgICA6ICJNYW51ZWxsZSBLb3JyZWt0dXIgZWluZXMgZ2VzcGVpY2hlcnRlbiBNb25hdHN3ZXJ0ZXMuIjsKICAgIHVwZGF0ZURlcml2ZWRQcmV2aWV3KCk7CiAgICAkKCJyZWNvcmRNb2RhbCIpLmNsYXNzTGlzdC5yZW1vdmUoImhpZGRlbiIpOwogICAgZG9jdW1lbnQuYm9keS5zdHlsZS5vdmVyZmxvdz0iaGlkZGVuIjsKICB9CiAgZnVuY3Rpb24gY2xvc2VSZWNvcmRNb2RhbCgpeyAkKCJyZWNvcmRNb2RhbCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOyBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSIiOyB9CiAgZnVuY3Rpb24gdXBkYXRlRGVyaXZlZFByZXZpZXcoKXsKICAgIGNvbnN0IHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoInJlY29yZFRvdGFsIikudmFsdWUpLGhlYXQ9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkQW5uZXgiKS52YWx1ZSk7CiAgICBjb25zdCBlbD0kKCJkZXJpdmVkUHJldmlldyIpOwogICAgaWYoW3RvdGFsLGhlYXQsYW5uZXhdLmV2ZXJ5KE51bWJlci5pc0Zpbml0ZSkpewogICAgICBjb25zdCByZXN0PXRvdGFsLWhlYXQtYW5uZXg7CiAgICAgIGVsLnRleHRDb250ZW50PWBTY2hsZWUvS2x1czogJHtudW0ocmVzdCwzKX0ga1doYDsKICAgICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgiZXJyb3IiLHJlc3Q8MCk7CiAgICB9ZWxzZXsKICAgICAgZWwudGV4dENvbnRlbnQ9IlNjaGxlZS9LbHVzOiDigJMgKHdpcmQgYXVzIEdlc2FtdCDiiJIgV8Okcm1lcHVtcGUg4oiSIEFsdGVudGVpbCBiZXJlY2huZXQpIjsKICAgICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgiZXJyb3IiKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2F2ZUVkaXRlZFJlY29yZChldmVudCl7CiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgY29uc3QgbW9udGg9JCgiZWRpdGluZ01vbnRoT3JpZ2luYWwiKS52YWx1ZTsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgIGlmKCFleGlzdGluZyl7JCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgTW9uYXQgd3VyZGUgbmljaHQgZ2VmdW5kZW4uIjtyZXR1cm47fQogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkVG90YWwiKS52YWx1ZSksaGVhdFB1bXA9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkQW5uZXgiKS52YWx1ZSk7CiAgICBpZihbdG90YWwsaGVhdFB1bXAsYW5uZXhdLmV2ZXJ5KE51bWJlci5pc0Zpbml0ZSkmJnRvdGFsLWhlYXRQdW1wLWFubmV4PC0uMDEpewogICAgICAkKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IlVucGxhdXNpYmVsOiBXw6RybWVwdW1wZSArIEFsdGVudGVpbCBzaW5kIGdyw7bDn2VyIGFscyBkZXIgR2VzYW10dmVyYnJhdWNoLiI7cmV0dXJuOwogICAgfQogICAgY29uc3QgaGVhdENoYW5nZWQ9aGVhdFB1bXAhPT1leGlzdGluZy5oZWF0UHVtcDsKICAgIGNvbnN0IG1ldGVyQ2hhbmdlZD10b3RhbCE9PWV4aXN0aW5nLnRvdGFsfHxhbm5leCE9PWV4aXN0aW5nLmFubmV4OwogICAgY29uc3QgbmV4dFByaWNlQ3Q9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkUHJpY2VDdCIpLnZhbHVlKSxuZXh0QmFzZUZlZT1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRCYXNlRmVlIikudmFsdWUpOwogICAgY29uc3QgcHJpY2VDaGFuZ2VkPW5leHRQcmljZUN0IT09ZXhpc3RpbmcucHJpY2VDdHx8bmV4dEJhc2VGZWUhPT1leGlzdGluZy5iYXNlRmVlOwogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgY29uc3QgcmVjb3JkPXsuLi5leGlzdGluZywKICAgICAgdG90YWwsaGVhdFB1bXAsYW5uZXgsCiAgICAgIHByaWNlQ3Q6bmV4dFByaWNlQ3QsCiAgICAgIGJhc2VGZWU6bmV4dEJhc2VGZWUsCiAgICAgIGhlYXRHZW5lcmF0ZWQ6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdEdlbmVyYXRlZCIpLnZhbHVlKSwKICAgICAgaGVhdGluZ0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIpLnZhbHVlKSwKICAgICAgZGh3RWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkRGh3RWxlY3RyaWNpdHkiKS52YWx1ZSksCiAgICAgIGhlYXRpbmdIZWF0Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRpbmdIZWF0IikudmFsdWUpLAogICAgICBkaHdIZWF0Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZERod0hlYXQiKS52YWx1ZSksCiAgICAgIG5vdGU6JCgicmVjb3JkTm90ZSIpLnZhbHVlLnRyaW0oKSwKICAgICAgaGVhdFB1bXBTb3VyY2U6aGVhdENoYW5nZWQ/Im1hbnVhbC1jb3JyZWN0aW9uIjpleGlzdGluZy5oZWF0UHVtcFNvdXJjZSwKICAgICAgaGVhdFB1bXBVcGRhdGVkQXQ6aGVhdENoYW5nZWQ/c3RhbXA6ZXhpc3RpbmcuaGVhdFB1bXBVcGRhdGVkQXQsCiAgICAgIG1ldGVyU291cmNlOm1ldGVyQ2hhbmdlZCYmZXhpc3RpbmcubWV0ZXJTb3VyY2U/YCR7ZXhpc3RpbmcubWV0ZXJTb3VyY2V9K21hbnVhbC1tb250aC1jb3JyZWN0aW9uYDpleGlzdGluZy5tZXRlclNvdXJjZSwKICAgICAgcHJpY2VTb3VyY2U6cHJpY2VDaGFuZ2VkPyJtYW51YWwtY29ycmVjdGlvbiI6ZXhpc3RpbmcucHJpY2VTb3VyY2UsCiAgICAgIHByaWNlVXBkYXRlZEF0OnByaWNlQ2hhbmdlZD9zdGFtcDpleGlzdGluZy5wcmljZVVwZGF0ZWRBdCwKICAgICAgb3N0cm9tVmFyaWFibGVDb3N0RXVyOnByaWNlQ2hhbmdlZD9udWxsOmV4aXN0aW5nLm9zdHJvbVZhcmlhYmxlQ29zdEV1ciwKICAgICAgb3N0cm9tVG90YWxDb3N0RXVyOnByaWNlQ2hhbmdlZD9udWxsOmV4aXN0aW5nLm9zdHJvbVRvdGFsQ29zdEV1ciwKICAgICAgb3N0cm9tQ29uc3VtcHRpb25LV2g6cHJpY2VDaGFuZ2VkP251bGw6ZXhpc3Rpbmcub3N0cm9tQ29uc3VtcHRpb25LV2gsCiAgICAgIG9zdHJvbVByaWNlQ29tcGxldGU6cHJpY2VDaGFuZ2VkP2ZhbHNlOmV4aXN0aW5nLm9zdHJvbVByaWNlQ29tcGxldGUsCiAgICAgIHVwZGF0ZWRBdDpzdGFtcAogICAgfTsKICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PW1vbnRoKTtuZXh0LnB1c2gocmVjb3JkKTsKICAgIHRyeXtzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YE1vbmF0ICR7bW9udGh9IG1hbnVlbGwga29ycmlnaWVydGB9KTt9CiAgICBjYXRjaChlcnJvcil7JCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWVycm9yLm1lc3NhZ2U7cmV0dXJuO30KICAgIGNsb3NlUmVjb3JkTW9kYWwoKTtyZW5kZXJBbGwoKTt0b2FzdChgJHttb250aExhYmVsKG1vbnRoKX0gZ2XDpG5kZXJ0YCk7CiAgfQoKICBmdW5jdGlvbiBvcGVuTWV0ZXJNb2RhbCgpewogICAgY29uc3QgcHJldmlvdXM9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighcHJldmlvdXMpe2FsZXJ0KCJFcyBmZWhsdCBlaW4gQXVzZ2FuZ3N6w6RobGVyc3RhbmQuIik7cmV0dXJuO30KICAgICQoIm1ldGVyRGF0ZSIpLnZhbHVlPW5leHRNb250aEZpcnN0KHByZXZpb3VzLmRhdGUpOwogICAgJCgibWV0ZXJUb3RhbCIpLnZhbHVlPSIiOwogICAgJCgibWV0ZXJBbm5leCIpLnZhbHVlPSIiOwogICAgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IiI7CiAgICB1cGRhdGVNZXRlclByZXZpZXcoKTsKICAgICQoIm1ldGVyTW9kYWwiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsKICAgIGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9ImhpZGRlbiI7CiAgICBzZXRUaW1lb3V0KCgpPT4kKCJtZXRlclRvdGFsIikuZm9jdXMoKSw1MCk7CiAgfQogIGZ1bmN0aW9uIGNsb3NlTWV0ZXJNb2RhbCgpeyAkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7IGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9IiI7IH0KICBmdW5jdGlvbiB1cGRhdGVNZXRlclByZXZpZXcoKXsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXJldHVybjsKICAgIGNvbnN0IGRhdGU9JCgibWV0ZXJEYXRlIikudmFsdWV8fG5leHRNb250aEZpcnN0KHByZXZpb3VzLmRhdGUpOwogICAgY29uc3QgdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpOwogICAgJCgibWV0ZXJQcmV2aW91cyIpLmlubmVySFRNTD1gVm9yaGVyaWdlciBTdGFuZDogPHN0cm9uZz4ke2RhdGVMYWJlbChwcmV2aW91cy5kYXRlKX08L3N0cm9uZz4gwrcgR2VzYW10IDxzdHJvbmc+JHtudW0ocHJldmlvdXMudG90YWwsMCl9IGtXaDwvc3Ryb25nPiDCtyBBbHRlbnRlaWwgPHN0cm9uZz4ke251bShwcmV2aW91cy5hbm5leCwwKX0ga1doPC9zdHJvbmc+YDsKICAgICQoIm1ldGVyVGFyZ2V0TW9udGgiKS50ZXh0Q29udGVudD1gQmVyZWNobmV0IHdpcmQgZGVyIFZlcmJyYXVjaCBmw7xyICR7bW9udGhMYWJlbCh0YXJnZXRNb250aCl9LmA7CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcigkKCJtZXRlclRvdGFsIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyQW5uZXgiKS52YWx1ZSk7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUodG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoYW5uZXgpKXsKICAgICAgY29uc3QgdG90YWxVc2U9dG90YWwtcHJldmlvdXMudG90YWwsYW5uZXhVc2U9YW5uZXgtcHJldmlvdXMuYW5uZXg7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKSxoZWF0PWV4aXN0aW5nPy5oZWF0UHVtcDsKICAgICAgY29uc3QgcmVzdD1OdW1iZXIuaXNGaW5pdGUoaGVhdCk/dG90YWxVc2UtYW5uZXhVc2UtaGVhdDpudWxsOwogICAgICAkKCJtZXRlclByZXZpZXciKS5pbm5lckhUTUw9YEdlc2FtdDogPHN0cm9uZz4ke251bSh0b3RhbFVzZSwxKX0ga1doPC9zdHJvbmc+IMK3IEFsdGVudGVpbDogPHN0cm9uZz4ke251bShhbm5leFVzZSwxKX0ga1doPC9zdHJvbmc+JHtOdW1iZXIuaXNGaW5pdGUoaGVhdCk/YCDCtyBXw6RybWVwdW1wZTogPHN0cm9uZz4ke251bShoZWF0LDEpfSBrV2g8L3N0cm9uZz4gwrcgU2NobGVlL0tsdXM6IDxzdHJvbmc+JHtudW0ocmVzdCwxKX0ga1doPC9zdHJvbmc+YDpgIMK3IFfDpHJtZXB1bXBlOiA8c3Ryb25nPkNTViBmZWhsdDwvc3Ryb25nPmB9YDsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuY2xhc3NMaXN0LnRvZ2dsZSgiZXJyb3IiLHRvdGFsVXNlPDB8fGFubmV4VXNlPDB8fChOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8MCkpOwogICAgfWVsc2V7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLnRleHRDb250ZW50PSJNb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXVzIGRlciBEaWZmZXJlbnogenVtIHZvcmhlcmlnZW4gWsOkaGxlcnN0YW5kIGJlcmVjaG5ldC4iOwogICAgICAkKCJtZXRlclByZXZpZXciKS5jbGFzc0xpc3QucmVtb3ZlKCJlcnJvciIpOwogICAgfQogIH0KICBmdW5jdGlvbiBzYXZlTWV0ZXJSZWFkaW5nRnJvbUZvcm0oZXZlbnQpewogICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXJldHVybjsKICAgIGNvbnN0IGRhdGU9JCgibWV0ZXJEYXRlIikudmFsdWUsdG90YWw9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJUb3RhbCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJtZXRlckFubmV4IikudmFsdWUpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0tXGR7Mn0kLy50ZXN0KGRhdGUpKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkJpdHRlIGVpbiBnw7xsdGlnZXMgQWJsZXNlZGF0dW0gd8OkaGxlbi4iOyByZXR1cm47IH0KICAgIGlmKGRhdGU8PXByZXZpb3VzLmRhdGUpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1gRGFzIERhdHVtIG11c3MgbmFjaCBkZW0gbGV0enRlbiBTdGFuZCB2b20gJHtkYXRlTGFiZWwocHJldmlvdXMuZGF0ZSl9IGxpZWdlbi5gOyByZXR1cm47IH0KICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUodG90YWwpfHwhTnVtYmVyLmlzRmluaXRlKGFubmV4KSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJCaXR0ZSBiZWlkZSBaw6RobGVyc3TDpG5kZSBlaW50cmFnZW4uIjsgcmV0dXJuOyB9CiAgICBpZih0b3RhbDxwcmV2aW91cy50b3RhbCl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgR2VzYW10esOkaGxlcnN0YW5kIGlzdCBrbGVpbmVyIGFscyBkZXIgdm9yaGVyaWdlIFN0YW5kLiBFaW4gbmV1ZXIgWsOkaGxlciBtw7xzc3RlIHNlcGFyYXQgYmVyw7xja3NpY2h0aWd0IHdlcmRlbi4iOyByZXR1cm47IH0KICAgIGlmKGFubmV4PHByZXZpb3VzLmFubmV4KXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkRlciBBbHRlbnRlaWwtWsOkaGxlcnN0YW5kIGlzdCBrbGVpbmVyIGFscyBkZXIgdm9yaGVyaWdlIFN0YW5kLiI7IHJldHVybjsgfQogICAgY29uc3QgdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpLHRvdGFsVXNlPXRvdGFsLXByZXZpb3VzLnRvdGFsLGFubmV4VXNlPWFubmV4LXByZXZpb3VzLmFubmV4OwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgodGFyZ2V0TW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6dGFyZ2V0TW9udGh9KTsKICAgIGNvbnN0IHJlc3Q9TnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmhlYXRQdW1wKT90b3RhbFVzZS1hbm5leFVzZS1leGlzdGluZy5oZWF0UHVtcDpudWxsOwogICAgaWYoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PC0uMDEpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1gVW5wbGF1c2liZWw6IE5hY2ggQWJ6dWcgdm9uIFfDpHJtZXB1bXBlIHVuZCBBbHRlbnRlaWwgZXJnaWJ0IFNjaGxlZS9LbHVzICR7bnVtKHJlc3QsMSl9IGtXaC5gOyByZXR1cm47IH0KICAgIGNvbnN0IHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIGNvbnN0IG5leHRSZWNvcmQ9ey4uLmV4aXN0aW5nLHRvdGFsOnRvdGFsVXNlLGFubmV4OmFubmV4VXNlLG1ldGVyUmVhZGluZ0RhdGU6ZGF0ZSxwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6cHJldmlvdXMuZGF0ZSx0b3RhbE1ldGVyUmVhZGluZzp0b3RhbCxhbm5leE1ldGVyUmVhZGluZzphbm5leCxtZXRlclNvdXJjZToiY3VtdWxhdGl2ZS1yZWFkaW5ncyIsdXBkYXRlZEF0OnN0YW1wfTsKICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PXRhcmdldE1vbnRoKTtuZXh0LnB1c2gobmV4dFJlY29yZCk7CiAgICB0cnl7CiAgICAgIHNhdmVSZWNvcmRzKG5leHQse3JlYXNvbjpgWsOkaGxlcnN0w6RuZGUgJHtkYXRlTGFiZWwoZGF0ZSl9IGdlc3BlaWNoZXJ0YH0pOwogICAgICBzYXZlTWV0ZXJSZWFkaW5ncyhbLi4ubWV0ZXJSZWFkaW5ncyx7ZGF0ZSx0b3RhbCxhbm5leCxub3RlOmBWZXJicmF1Y2ggJHt0YXJnZXRNb250aH1gLHVwZGF0ZWRBdDpzdGFtcH1dKTsKICAgIH1jYXRjaChlcnJvcil7JCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9ZXJyb3IubWVzc2FnZTtyZXR1cm47fQogICAgY2xvc2VNZXRlck1vZGFsKCk7cmVuZGVyQWxsKCk7CiAgICB0b2FzdChOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcuaGVhdFB1bXApP2Ake21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfSB2b2xsc3TDpG5kaWcgYmVyZWNobmV0YDpgWsOkaGxlcnN0w6RuZGUgZ2VzcGVpY2hlcnQgwrcgV8Okcm1lcHVtcGVuLUNTViBmZWhsdCBub2NoYCk7CiAgfQogIGZ1bmN0aW9uIHVuZG9MYXRlc3RNZXRlclJlYWRpbmcoKXsKICAgIGlmKG1ldGVyUmVhZGluZ3MubGVuZ3RoPD0xKXJldHVybjsKICAgIGNvbnN0IGxhdGVzdD1tZXRlclJlYWRpbmdzLmF0KC0xKSxwcmV2aW91cz1tZXRlclJlYWRpbmdzLmF0KC0yKSx0YXJnZXRNb250aD1wcmV2aW91cy5kYXRlLnNsaWNlKDAsNyk7CiAgICBpZighY29uZmlybShgWsOkaGxlcnN0YW5kIHZvbSAke2RhdGVMYWJlbChsYXRlc3QuZGF0ZSl9IHp1csO8Y2tuZWhtZW4/IERpZSBkYXJhdXMgYmVyZWNobmV0ZW4gV2VydGUgZsO8ciAke21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfSB3ZXJkZW4gZW50ZmVybnQuYCkpcmV0dXJuOwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgodGFyZ2V0TW9udGgpOwogICAgaWYoZXhpc3RpbmcpewogICAgICBjb25zdCBjbGVhcmVkPXsuLi5leGlzdGluZyx0b3RhbDpudWxsLGFubmV4Om51bGwsbWV0ZXJSZWFkaW5nRGF0ZTpudWxsLHByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZTpudWxsLHRvdGFsTWV0ZXJSZWFkaW5nOm51bGwsYW5uZXhNZXRlclJlYWRpbmc6bnVsbCxtZXRlclNvdXJjZToiIix1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpfTsKICAgICAgY29uc3QgbmV4dD1yZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoIT09dGFyZ2V0TW9udGgpO25leHQucHVzaChjbGVhcmVkKTtzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YExldHp0ZW4gWsOkaGxlcnN0YW5kICR7bGF0ZXN0LmRhdGV9IHp1csO8Y2tnZW5vbW1lbmB9KTsKICAgIH0KICAgIHNhdmVNZXRlclJlYWRpbmdzKG1ldGVyUmVhZGluZ3Muc2xpY2UoMCwtMSkpO3JlbmRlckFsbCgpO3RvYXN0KCJMZXR6dGVuIFrDpGhsZXJzdGFuZCB6dXLDvGNrZ2Vub21tZW4iKTsKICB9CgogIGZ1bmN0aW9uIGFuYWx5c2lzWWVhclJvd3MoeWVhcil7IHJldHVybiByZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoLnN0YXJ0c1dpdGgoYCR7eWVhcn0tYCkpLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7IH0KICBmdW5jdGlvbiBvc3Ryb21TdGF0c0ZvclllYXIoeWVhcil7CiAgICBjb25zdCBjYWNoZT1uZXcgTWFwKG9zdHJvbVByaWNlU3RhdHMuZmlsdGVyKGl0ZW09Pml0ZW0ubW9udGguc3RhcnRzV2l0aChgJHt5ZWFyfS1gKSkubWFwKGl0ZW09PltpdGVtLm1vbnRoLGl0ZW1dKSk7CiAgICBmb3IoY29uc3QgciBvZiBhbmFseXNpc1llYXJSb3dzKHllYXIpKXsKICAgICAgaWYoIXIub3N0cm9tUHJpY2VDb21wbGV0ZXx8IU51bWJlci5pc0Zpbml0ZShyLnByaWNlQ3QpfHwhTnVtYmVyLmlzRmluaXRlKHIub3N0cm9tQ29uc3VtcHRpb25LV2gpfHxyLm9zdHJvbUNvbnN1bXB0aW9uS1doPD0wKWNvbnRpbnVlOwogICAgICBjb25zdCBmcm9tUmVjb3JkPXNhbml0aXplT3N0cm9tUHJpY2VTdGF0KHttb250aDpyLm1vbnRoLHdlaWdodGVkQXZlcmFnZUN0UGVyS1doOnIucHJpY2VDdCx0b3RhbEtXaDpyLm9zdHJvbUNvbnN1bXB0aW9uS1doLHZhcmlhYmxlQ29zdEV1cjpyLm9zdHJvbVZhcmlhYmxlQ29zdEV1cixmaXhlZENvc3RFdXI6ci5iYXNlRmVlLHRvdGFsQ29zdEV1cjpyLm9zdHJvbVRvdGFsQ29zdEV1cixjb21wbGV0ZTp0cnVlLHBhcnRpYWw6ZmFsc2UsdXBkYXRlZEF0OnIucHJpY2VVcGRhdGVkQXR8fHIudXBkYXRlZEF0fHwiIn0pOwogICAgICBjb25zdCBleGlzdGluZz1jYWNoZS5nZXQoci5tb250aCk7CiAgICAgIGlmKCFleGlzdGluZ3x8RGF0ZS5wYXJzZShmcm9tUmVjb3JkLnVwZGF0ZWRBdHx8IiIpPj1EYXRlLnBhcnNlKGV4aXN0aW5nLnVwZGF0ZWRBdHx8IiIpKWNhY2hlLnNldChyLm1vbnRoLGZyb21SZWNvcmQpOwogICAgfQogICAgcmV0dXJuIFsuLi5jYWNoZS52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gb3N0cm9tUGVyaW9kQXZlcmFnZShpdGVtcyl7CiAgICBjb25zdCB2YWxpZD0oQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pLmZpbHRlcihpdGVtPT5OdW1iZXIuaXNGaW5pdGUoaXRlbS50b3RhbEtXaCkmJml0ZW0udG90YWxLV2g+MCYmTnVtYmVyLmlzRmluaXRlKGl0ZW0udmFyaWFibGVDb3N0RXVyKSk7CiAgICBpZighdmFsaWQubGVuZ3RoKXJldHVybiB7YXZlcmFnZUN0Om51bGwsZWZmZWN0aXZlQ3Q6bnVsbCxrV2g6MCx2YXJpYWJsZUNvc3RFdXI6MCxmaXhlZENvc3RFdXI6MCx0b3RhbENvc3RFdXI6MCxtb250aHM6MCxwYXJ0aWFsOmZhbHNlfTsKICAgIGNvbnN0IGtXaD12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtK051bWJlcihpdGVtLnRvdGFsS1dofHwwKSwwKTsKICAgIGNvbnN0IHZhcmlhYmxlQ29zdEV1cj12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtK051bWJlcihpdGVtLnZhcmlhYmxlQ29zdEV1cnx8MCksMCk7CiAgICBjb25zdCBmaXhlZENvc3RFdXI9dmFsaWQucmVkdWNlKChzdW0saXRlbSk9PnN1bStOdW1iZXIoaXRlbS5maXhlZENvc3RFdXJ8fDApLDApOwogICAgY29uc3QgdG90YWxDb3N0RXVyPXZhbGlkLnJlZHVjZSgoc3VtLGl0ZW0pPT5zdW0rKE51bWJlci5pc0Zpbml0ZShpdGVtLnRvdGFsQ29zdEV1cik/TnVtYmVyKGl0ZW0udG90YWxDb3N0RXVyKTpOdW1iZXIoaXRlbS52YXJpYWJsZUNvc3RFdXJ8fDApK051bWJlcihpdGVtLmZpeGVkQ29zdEV1cnx8MCkpLDApOwogICAgcmV0dXJuIHthdmVyYWdlQ3Q6a1doPjA/dmFyaWFibGVDb3N0RXVyL2tXaCoxMDA6bnVsbCxlZmZlY3RpdmVDdDprV2g+MD90b3RhbENvc3RFdXIva1doKjEwMDpudWxsLGtXaCx2YXJpYWJsZUNvc3RFdXIsZml4ZWRDb3N0RXVyLHRvdGFsQ29zdEV1cixtb250aHM6dmFsaWQubGVuZ3RoLHBhcnRpYWw6dmFsaWQuc29tZShpdGVtPT5pdGVtLnBhcnRpYWwpfTsKICB9CiAgZnVuY3Rpb24gcXVhcnRlckZvck1vbnRoKG1vbnRoKXtyZXR1cm4gTWF0aC5mbG9vcigoTnVtYmVyKFN0cmluZyhtb250aCkuc2xpY2UoNSw3KSktMSkvMykrMTt9CiAgZnVuY3Rpb24gcmVuZGVyT3N0cm9tUHJpY2VTdGF0cyh5ZWFyKXsKICAgIGlmKCEkKCdvc3Ryb21QcmljZVN0YXRzTWV0cmljcycpKXJldHVybjsKICAgIGNvbnN0IGl0ZW1zPW9zdHJvbVN0YXRzRm9yWWVhcih5ZWFyKTsKICAgIGNvbnN0IGN1cnJlbnRZZWFyPW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKTsKICAgIGNvbnN0IGFubnVhbD1vc3Ryb21QZXJpb2RBdmVyYWdlKGl0ZW1zKTsKICAgIGNvbnN0IGNhcmRzPVtbU3RyaW5nKHllYXIpLGFubnVhbCx5ZWFyPT09Y3VycmVudFllYXI/ImJpcyBoZXV0ZSI6IkphaHJlc3dlcnQiXV07CiAgICBmb3IobGV0IHE9MTtxPD00O3ErKyljYXJkcy5wdXNoKFtgUSR7cX1gLG9zdHJvbVBlcmlvZEF2ZXJhZ2UoaXRlbXMuZmlsdGVyKGl0ZW09PnF1YXJ0ZXJGb3JNb250aChpdGVtLm1vbnRoKT09PXEpKSxgJHtpdGVtcy5maWx0ZXIoaXRlbT0+cXVhcnRlckZvck1vbnRoKGl0ZW0ubW9udGgpPT09cSkubGVuZ3RofSBNb25hdChlKWBdKTsKICAgICQoJ29zdHJvbVByaWNlU3RhdHNNZXRyaWNzJykuaW5uZXJIVE1MPWNhcmRzLm1hcCgoW2xhYmVsLHN0YXRzLHN1Yl0pPT5gPGFydGljbGU+PHNwYW4+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+PHN0cm9uZz4ke051bWJlci5pc0Zpbml0ZShzdGF0cy5hdmVyYWdlQ3QpP2Ake251bShzdGF0cy5hdmVyYWdlQ3QsMil9IGN0L2tXaGA6IuKAkyJ9PC9zdHJvbmc+PHNtYWxsPiR7c3RhdHMubW9udGhzP2Ake2VzY2FwZUh0bWwoc3ViKX0gwrcgJHtudW0oc3RhdHMua1doLDApfSBrV2gke051bWJlci5pc0Zpbml0ZShzdGF0cy5lZmZlY3RpdmVDdCk/YCDCtyBpbmtsLiBGaXhrb3N0ZW4gJHtudW0oc3RhdHMuZWZmZWN0aXZlQ3QsMil9IGN0L2tXaGA6IiJ9YDoia2VpbmUgT3N0cm9tLURhdGVuIn08L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCcnKTsKICAgIGNvbnN0IG1vbnRoTWFwPW5ldyBNYXAoaXRlbXMubWFwKGl0ZW09PltOdW1iZXIoaXRlbS5tb250aC5zbGljZSg1LDcpKSxpdGVtXSkpOwogICAgJCgnb3N0cm9tUHJpY2VTdGF0c1RhYmxlJykuaW5uZXJIVE1MPUFycmF5LmZyb20oe2xlbmd0aDoxMn0sKF8saSk9PmkrMSkubWFwKG09PnsKICAgICAgY29uc3QgaXRlbT1tb250aE1hcC5nZXQobSk7aWYoIWl0ZW0pcmV0dXJuIGA8dHI+PHRkPiR7TU9OVEhTW20tMV19PC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48L3RyPmA7CiAgICAgIGNvbnN0IGVmZmVjdGl2ZT1OdW1iZXIoaXRlbS50b3RhbEtXaCk+MCYmTnVtYmVyLmlzRmluaXRlKGl0ZW0udG90YWxDb3N0RXVyKT9OdW1iZXIoaXRlbS50b3RhbENvc3RFdXIpL051bWJlcihpdGVtLnRvdGFsS1doKSoxMDA6bnVsbDsKICAgICAgY29uc3QgcnVubmluZz1pdGVtLnBhcnRpYWx8fGl0ZW0ubW9udGg9PT1jdXJyZW50TW9udGhLZXkoKTsKICAgICAgcmV0dXJuIGA8dHI+PHRkPiR7TU9OVEhTW20tMV19JHtydW5uaW5nPycgPHNtYWxsIGNsYXNzPSJwcmljZS1ydW5uaW5nIj5sYXVmZW5kPC9zbWFsbD4nOicnfTwvdGQ+PHRkPiR7bnVtKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gsMil9IGN0PC90ZD48dGQ+JHtOdW1iZXIuaXNGaW5pdGUoZWZmZWN0aXZlKT9gJHtudW0oZWZmZWN0aXZlLDIpfSBjdGA6IuKAkyJ9PC90ZD48dGQ+JHtudW0oaXRlbS50b3RhbEtXaCwxKX0ga1doPC90ZD48dGQ+JHtpdGVtLmNvbXBsZXRlPydPc3Ryb20gZXhha3QnOid1bnZvbGxzdMOkbmRpZyd9PC90ZD48L3RyPmA7CiAgICB9KS5qb2luKCcnKTsKICAgIGNvbnN0IGxhc3Q9aXRlbXMubWFwKGl0ZW09PkRhdGUucGFyc2UoaXRlbS51cGRhdGVkQXR8fCcnKSkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkuc29ydCgoYSxiKT0+Yi1hKVswXTsKICAgICQoJ29zdHJvbVByaWNlU3RhdHNTdGF0dXMnKS50ZXh0Q29udGVudD1vc3Ryb21QcmljZVN0YXRzQnVzeT8nT3N0cm9tLVByZWlzZSB3ZXJkZW4gZ2VsYWRlbiDigKYnOml0ZW1zLmxlbmd0aD9gJHtpdGVtcy5sZW5ndGh9IE1vbmF0KGUpIHZlcmbDvGdiYXIke2xhc3Q/YCDCtyB6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUobGFzdCl9YDonJ30gwrcgUXVhcnRhbC9KYWhyIHZlcmJyYXVjaHNnZXdpY2h0ZXRgOnNldHRpbmdzLm9zdHJvbUFwcEtleT8nTm9jaCBrZWluZSBQcmVpc3N0YXRpc3RpayBmw7xyIGRpZXNlcyBKYWhyIGdlbGFkZW4uJzonTm9jaCBrZWluZSBQcmVpc3N0YXRpc3RpayBzeW5jaHJvbmlzaWVydC4gQXVmIGVpbmVtIHZlcmJ1bmRlbmVuIEdlcsOkdCBtaXQgT3N0cm9tLVNjaGzDvHNzZWwgYWt0dWFsaXNpZXJlbi4nOwogICAgJCgncmVmcmVzaE9zdHJvbVByaWNlU3RhdHNCdG4nKS5kaXNhYmxlZD1vc3Ryb21QcmljZVN0YXRzQnVzeXx8IXNldHRpbmdzLm9zdHJvbUFwcEtleTsKICAgIGRyYXdPc3Ryb21BdmVyYWdlUHJpY2VDaGFydCh5ZWFyLGl0ZW1zKTsKICB9CiAgZnVuY3Rpb24gZHJhd09zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0KHllYXIsaXRlbXM9b3N0cm9tU3RhdHNGb3JZZWFyKHllYXIpKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgnb3N0cm9tQXZlcmFnZVByaWNlQ2hhcnQnKSk7aWYoIWMpcmV0dXJuO2NvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOwogICAgY29uc3QgdmFscz1pdGVtcy5tYXAoaXRlbT0+TnVtYmVyKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTtpZighdmFscy5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LCdLZWluZSBPc3Ryb20tUHJlaXNkYXRlbicpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4udmFscykqMS4xNXx8MTsKICAgIGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKGl0ZW1zLm1hcChpdGVtPT5bTnVtYmVyKGl0ZW0ubW9udGguc2xpY2UoNSw3KSktMSxpdGVtXSkpO2N0eC5zdHJva2VTdHlsZT1DT0xPUlMuY29zdDtjdHgubGluZVdpZHRoPTIuODtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7CiAgICBmb3IobGV0IG09MDttPDEyO20rKyl7Y29uc3QgaXRlbT1tYXAuZ2V0KG0pO2lmKCFpdGVtfHwhTnVtYmVyLmlzRmluaXRlKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLWl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fWN0eC5zdHJva2UoKTsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLmNvc3Q7Zm9yKGxldCBtPTA7bTwxMjttKyspe2NvbnN0IGl0ZW09bWFwLmdldChtKTtpZighaXRlbXx8IU51bWJlci5pc0Zpbml0ZShpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSljb250aW51ZTtjb25zdCB4PWZyYW1lLmxlZnQrZnJhbWUucGxvdFcqbS8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1pdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doL21heCk7Y3R4LmJlZ2luUGF0aCgpO2N0eC5hcmMoeCx5LDMuMiwwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5mb250PScxMHB4IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LFNlZ29lIFVJLHNhbnMtc2VyaWYnO2N0eC5maWxsVGV4dChudW0oaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCwxKSx4LTEwLE1hdGgubWF4KDEwLHktOCkpO2N0eC5maWxsU3R5bGU9Q09MT1JTLmNvc3Q7fQogIH0KICBhc3luYyBmdW5jdGlvbiByZWZyZXNoT3N0cm9tUHJpY2VTdGF0cyh5ZWFyLHtzaWxlbnQ9ZmFsc2V9PXt9KXsKICAgIGlmKG9zdHJvbVByaWNlU3RhdHNCdXN5KXJldHVybiBmYWxzZTtpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtpZighc2lsZW50KXRvYXN0KCdPc3Ryb20genVlcnN0IHZlcmJpbmRlbicpO3JldHVybiBmYWxzZTt9CiAgICBjb25zdCB5PU51bWJlcih5ZWFyKTtpZighTnVtYmVyLmlzSW50ZWdlcih5KXx8eTwyMDIwfHx5Pm5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSl7aWYoIXNpbGVudCl0b2FzdCgnVW5nw7xsdGlnZXMgSmFocicpO3JldHVybiBmYWxzZTt9CiAgICBjb25zdCBub3c9bmV3IERhdGUoKSxsYXN0TW9udGg9eT09PW5vdy5nZXRGdWxsWWVhcigpP25vdy5nZXRNb250aCgpKzE6MTI7b3N0cm9tUHJpY2VTdGF0c0J1c3k9dHJ1ZTtyZW5kZXJPc3Ryb21QcmljZVN0YXRzKHkpOwogICAgbGV0IHVwZGF0ZWQ9MCx1bmF2YWlsYWJsZT0wO2NvbnN0IHJlY29yZE1hcD1uZXcgTWFwKHJlY29yZHMubWFwKHI9PltyLm1vbnRoLHsuLi5yfV0pKTsKICAgIHRyeXsKICAgICAgZm9yKGxldCBtPTE7bTw9bGFzdE1vbnRoO20rKyl7CiAgICAgICAgY29uc3QgbW9udGg9YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwnMCcpfWA7aWYoIXNpbGVudCkkKCdvc3Ryb21QcmljZVN0YXRzU3RhdHVzJykudGV4dENvbnRlbnQ9YCR7bW9udGhMYWJlbChtb250aCxmYWxzZSl9IHdpcmQgdm9uIE9zdHJvbSBnZWxhZGVuIOKApiAoJHttfS8ke2xhc3RNb250aH0pYDsKICAgICAgICB0cnl7CiAgICAgICAgICBjb25zdCBkYXRhPWF3YWl0IG9zdHJvbUZldGNoKGAvYXBpL21vbnRoP21vbnRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KG1vbnRoKX1gKTsKICAgICAgICAgIGlmKCFkYXRhPy5jb21wbGV0ZXx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLnRvdGFsS1doKSl8fE51bWJlcihkYXRhLnRvdGFsS1doKTw9MHx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS52YXJpYWJsZUNvc3RFdXIpKSl7dW5hdmFpbGFibGUrKztjb250aW51ZTt9CiAgICAgICAgICBjb25zdCBwYXJ0aWFsPW1vbnRoPT09Y3VycmVudE1vbnRoS2V5KCk7dXBzZXJ0T3N0cm9tUHJpY2VTdGF0KG1vbnRoLGRhdGEse3BhcnRpYWx9KTt1cGRhdGVkKys7CiAgICAgICAgICBpZighcGFydGlhbCYmcmVjb3JkTWFwLmhhcyhtb250aCkpe2NvbnN0IGl0ZW09cmVjb3JkTWFwLmdldChtb250aCksc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO2l0ZW0ucHJpY2VDdD1OdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCk7aXRlbS5iYXNlRmVlPU51bWJlcihkYXRhLmZpeGVkQ29zdEV1cil8fDA7aXRlbS5vc3Ryb21WYXJpYWJsZUNvc3RFdXI9TnVtYmVyKGRhdGEudmFyaWFibGVDb3N0RXVyKTtpdGVtLm9zdHJvbVRvdGFsQ29zdEV1cj1OdW1iZXIoZGF0YS50b3RhbENvc3RFdXIpO2l0ZW0ub3N0cm9tQ29uc3VtcHRpb25LV2g9TnVtYmVyKGRhdGEudG90YWxLV2gpO2l0ZW0ub3N0cm9tUHJpY2VDb21wbGV0ZT10cnVlO2l0ZW0ucHJpY2VTb3VyY2U9J29zdHJvbS1ob3VybHktY29uc3VtcHRpb24td2VpZ2h0ZWQnO2l0ZW0ucHJpY2VVcGRhdGVkQXQ9c3RhbXA7aXRlbS51cGRhdGVkQXQ9c3RhbXA7cmVjb3JkTWFwLnNldChtb250aCxpdGVtKTt9CiAgICAgICAgfWNhdGNoe3VuYXZhaWxhYmxlKys7fQogICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmU9PnNldFRpbWVvdXQocmVzb2x2ZSwxNDApKTsKICAgICAgfQogICAgICBpZih1cGRhdGVkKXNhdmVSZWNvcmRzKFsuLi5yZWNvcmRNYXAudmFsdWVzKCldLHtyZWFzb246YE9zdHJvbS1QcmVpc3N0YXRpc3RpayAke3l9IGFrdHVhbGlzaWVydGB9KTsKICAgICAgcmVuZGVyQWxsKCk7aWYoIXNpbGVudCl0b2FzdChgJHt1cGRhdGVkfSBPc3Ryb20tTW9uYXQoZSkgZsO8ciAke3l9IGFrdHVhbGlzaWVydCR7dW5hdmFpbGFibGU/YCDCtyAke3VuYXZhaWxhYmxlfSBuaWNodCB2ZXJmw7xnYmFyYDonJ31gKTtyZXR1cm4gdXBkYXRlZD4wOwogICAgfWZpbmFsbHl7b3N0cm9tUHJpY2VTdGF0c0J1c3k9ZmFsc2U7cmVuZGVyT3N0cm9tUHJpY2VTdGF0cyh5KTt9CiAgfQogIGZ1bmN0aW9uIGFubnVhbFN1bXMocm93cyl7CiAgICByZXR1cm4gcm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKWEudG90YWwrPXIudG90YWw7IGlmKE51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSlhLmhlYXQrPXIuaGVhdFB1bXA7IGlmKE51bWJlci5pc0Zpbml0ZShyLmFubmV4KSlhLmFubmV4Kz1yLmFubmV4OyBjb25zdCByZXN0PWRlcml2ZWQocik7IGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdD49MClhLnJlc3QrPXJlc3Q7IGNvbnN0IGNvc3Q9cmVjb3JkQ29zdChyKTsgaWYoTnVtYmVyLmlzRmluaXRlKGNvc3QpKWEuY29zdCs9Y29zdDsgaWYoTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKWEuY291bnQrKzsgcmV0dXJuIGE7IH0se3RvdGFsOjAsaGVhdDowLGFubmV4OjAscmVzdDowLGNvc3Q6MCxjb3VudDowfSk7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckFuYWx5c2lzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3QgeWVhclNlbGVjdD0kKCJhbmFseXNpc1llYXIiKTsKICAgIGNvbnN0IHByaW9yPU51bWJlcih5ZWFyU2VsZWN0LnZhbHVlKTsKICAgIGNvbnN0IHNlbGVjdGVkPXlzLmluY2x1ZGVzKHByaW9yKT9wcmlvcjooeXNbMF18fG5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSk7CiAgICB5ZWFyU2VsZWN0LmlubmVySFRNTD0oeXMubGVuZ3RoP3lzOltuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCldKS5tYXAoeT0+YDxvcHRpb24gdmFsdWU9IiR7eX0iPiR7eX08L29wdGlvbj5gKS5qb2luKCIiKTsKICAgIHllYXJTZWxlY3QudmFsdWU9U3RyaW5nKHNlbGVjdGVkKTsKICAgIGNvbnN0IHJvd3M9YW5hbHlzaXNZZWFyUm93cyhzZWxlY3RlZCksIHN1bXM9YW5udWFsU3Vtcyhyb3dzKTsKICAgIGNvbnN0IHByZXZpb3VzWWVhcj15cy5maWx0ZXIoeT0+eTxzZWxlY3RlZCkuc29ydCgoYSxiKT0+Yi1hKVswXXx8bnVsbDsKICAgIGNvbnN0IHByZXZpb3VzUm93cz1wcmV2aW91c1llYXI/YW5hbHlzaXNZZWFyUm93cyhwcmV2aW91c1llYXIpOltdOwogICAgY29uc3QgcHJldmlvdXM9YW5udWFsU3VtcyhwcmV2aW91c1Jvd3MpOwogICAgY29uc3QgdG90YWxEZWx0YT1wcmV2aW91cy5jb3VudCYmcHJldmlvdXMudG90YWw/KChzdW1zLnRvdGFsLXByZXZpb3VzLnRvdGFsKS9wcmV2aW91cy50b3RhbCoxMDApOm51bGw7CiAgICBjb25zdCBjb3BSb3dzPXJvd3MubWFwKHJlY29yZENvcCkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7CiAgICBjb25zdCBhbm51YWxDb3A9cm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApJiZOdW1iZXIuaXNGaW5pdGUoci5oZWF0R2VuZXJhdGVkKSl7YS5lKz1yLmhlYXRQdW1wO2EuaCs9ci5oZWF0R2VuZXJhdGVkO30gcmV0dXJuIGE7fSx7ZTowLGg6MH0pOwogICAgY29uc3QgZXhhY3RQcmljZU1vbnRocz1yb3dzLmZpbHRlcihyPT5yLm9zdHJvbVByaWNlQ29tcGxldGUmJk51bWJlci5pc0Zpbml0ZShyLm9zdHJvbVRvdGFsQ29zdEV1cikpLmxlbmd0aDsKICAgIGNvbnN0IG1ldHJpY3M9WwogICAgICBbIkdlc2FtdCIsYCR7bnVtKHN1bXMudG90YWwsMCl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKHRvdGFsRGVsdGEpP2Ake3BjdCh0b3RhbERlbHRhKX0genUgJHtwcmV2aW91c1llYXJ9YDpgJHtzdW1zLmNvdW50fSBNb25hdGVgXSwKICAgICAgWyJXw6RybWVwdW1wZSIsYCR7bnVtKHN1bXMuaGVhdCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLmhlYXQvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJBbHRlbnRlaWwiLGAke251bShzdW1zLmFubmV4LDApfSBrV2hgLHN1bXMudG90YWw/YCR7bnVtKHN1bXMuYW5uZXgvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJTY2hsZWUvS2x1cyIsYCR7bnVtKHN1bXMucmVzdCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLnJlc3Qvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJLb3N0ZW4iLGV1cm8oc3Vtcy5jb3N0KSxleGFjdFByaWNlTW9udGhzP2Ake2V4YWN0UHJpY2VNb250aHN9IE1vbmF0KGUpIG1pdCBPc3Ryb20tU3R1bmRlbnByZWlzZW5gOmFubnVhbENvcC5lPjA/YFdQLUFyYmVpdHN6YWhsICR7bnVtKGFubnVhbENvcC5oL2FubnVhbENvcC5lLDIpfWA6IkZhbGxiYWNrLVByZWlzZSJdCiAgICBdOwogICAgJCgiYW5hbHlzaXNNZXRyaWNzIikuaW5uZXJIVE1MPW1ldHJpY3MubWFwKChbbCx2LHNdKT0+YDxhcnRpY2xlPjxzcGFuPiR7bH08L3NwYW4+PHN0cm9uZz4ke3Z9PC9zdHJvbmc+PHNtYWxsPiR7c308L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCIiKTsKICAgICQoImFuYWx5c2lzVGFibGUiKS5pbm5lckhUTUw9cm93cy5sZW5ndGg/cm93cy5tYXAocj0+YDx0cj48dGQ+JHtlc2NhcGVIdG1sKG1vbnRoTGFiZWwoci5tb250aCxmYWxzZSkpfTwvdGQ+PHRkPiR7bnVtKHIudG90YWwsMSl9PC90ZD48dGQ+JHtudW0oci5oZWF0UHVtcCwxKX08L3RkPjx0ZD4ke251bShyLmFubmV4LDEpfTwvdGQ+PHRkPiR7bnVtKGRlcml2ZWQociksMSl9PC90ZD48dGQ+JHtldXJvKHJlY29yZENvc3QocikpfSR7ci5vc3Ryb21QcmljZUNvbXBsZXRlPyIgKiI6IiJ9PC90ZD48L3RyPmApLmpvaW4oIiIpOic8dHI+PHRkIGNvbHNwYW49IjYiPktlaW5lIE1vbmF0c2RhdGVuIGbDvHIgZGllc2VzIEphaHIuPC90ZD48L3RyPic7CiAgICAkKCJjb3BQYW5lbCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIWNvcFJvd3MubGVuZ3RoKTsKICAgIHJlbmRlck9zdHJvbVByaWNlU3RhdHMoc2VsZWN0ZWQpOwogICAgcmVuZGVyQ2xpbWF0ZUFuYWx5c2lzKCk7CiAgICBkcmF3QWxsb2NhdGlvbkNoYXJ0KHJvd3MpOyBkcmF3VG90YWxDaGFydEFsbFllYXJzKHlzKTsgZHJhd0Nvc3RDaGFydChyb3dzKTsgaWYoY29wUm93cy5sZW5ndGgpZHJhd0NvcENoYXJ0KHJvd3MpOwogIH0KCiAgZnVuY3Rpb24gY2FudmFzU2V0dXAoY2FudmFzKXsKICAgIGlmKCFjYW52YXMpcmV0dXJuIG51bGw7CiAgICBjb25zdCByZWN0PWNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsgY29uc3QgZHByPU1hdGgubWluKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvfHwxLDIpOyBjb25zdCB3aWR0aD1NYXRoLm1heCgyODAsTWF0aC5yb3VuZChyZWN0LndpZHRofHw2MDApKTsgY29uc3QgaGVpZ2h0PU1hdGgubWF4KDE4MCxNYXRoLnJvdW5kKHJlY3QuaGVpZ2h0fHwyNjApKTsKICAgIGNhbnZhcy53aWR0aD1NYXRoLnJvdW5kKHdpZHRoKmRwcik7IGNhbnZhcy5oZWlnaHQ9TWF0aC5yb3VuZChoZWlnaHQqZHByKTsgY29uc3QgY3R4PWNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOyBjdHguc2V0VHJhbnNmb3JtKGRwciwwLDAsZHByLDAsMCk7IGN0eC5jbGVhclJlY3QoMCwwLHdpZHRoLGhlaWdodCk7IHJldHVybiB7Y3R4LHdpZHRoLGhlaWdodH07CiAgfQogIGZ1bmN0aW9uIGRyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LHRleHQ9IktlaW5lIERhdGVuIil7CiAgICBjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0OyBjdHguZm9udD0iMTNweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjsgY3R4LnRleHRBbGlnbj0iY2VudGVyIjsgY3R4LmZpbGxUZXh0KHRleHQsd2lkdGgvMixoZWlnaHQvMik7IGN0eC50ZXh0QWxpZ249ImxlZnQiOwogIH0KICBmdW5jdGlvbiBjaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LGxhYmVscyx7bGVmdD00OCxib3R0b209MzQsdG9wPTE1LHJpZ2h0PTEyfT17fSl7CiAgICBjb25zdCBwbG90Vz13aWR0aC1sZWZ0LXJpZ2h0LCBwbG90SD1oZWlnaHQtdG9wLWJvdHRvbTsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuZ3JpZDsgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDsgY3R4LmZvbnQ9IjEwcHggLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsU2Vnb2UgVUksc2Fucy1zZXJpZiI7IGN0eC5saW5lV2lkdGg9MTsKICAgIGZvcihsZXQgaT0wO2k8PTQ7aSsrKXsgY29uc3QgeT10b3ArcGxvdEgqaS80OyBjdHguYmVnaW5QYXRoKCk7Y3R4Lm1vdmVUbyhsZWZ0LHkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseSk7Y3R4LnN0cm9rZSgpOyBjb25zdCB2YWw9bWF4KigxLWkvNCk7Y3R4LmZpbGxUZXh0KG51bSh2YWwsMCksNCx5KzMpOyB9CiAgICBpZihsYWJlbHM/Lmxlbmd0aCl7IGxhYmVscy5mb3JFYWNoKChsYWJlbCxpKT0+eyBjb25zdCB4PWxlZnQrKGxhYmVscy5sZW5ndGg9PT0xP3Bsb3RXLzI6cGxvdFcqaS8obGFiZWxzLmxlbmd0aC0xKSk7IGN0eC5maWxsVGV4dChsYWJlbCx4LTEwLGhlaWdodC0xMCk7IH0pOyB9CiAgICByZXR1cm4ge2xlZnQscmlnaHQsdG9wLGJvdHRvbSxwbG90VyxwbG90SH07CiAgfQogIGZ1bmN0aW9uIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCByb3dzPXNvcnRlZCgpLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpLnNsaWNlKC0xMik7IGlmKCFyb3dzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4ucm93cy5tYXAocj0+ci50b3RhbCkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgscm93cy5tYXAocj0+TU9OVEhTW051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTFdKSx7fSk7CiAgICBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLnRvdGFsO2N0eC5saW5lV2lkdGg9Mi41O2N0eC5iZWdpblBhdGgoKTtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PWZyYW1lLmxlZnQrKHJvd3MubGVuZ3RoPT09MT9mcmFtZS5wbG90Vy8yOmZyYW1lLnBsb3RXKmkvKHJvd3MubGVuZ3RoLTEpKTtjb25zdCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1yLnRvdGFsL21heCk7aT9jdHgubGluZVRvKHgseSk6Y3R4Lm1vdmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLnRvdGFsO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9ZnJhbWUubGVmdCsocm93cy5sZW5ndGg9PT0xP2ZyYW1lLnBsb3RXLzI6ZnJhbWUucGxvdFcqaS8ocm93cy5sZW5ndGgtMSkpO2NvbnN0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXIudG90YWwvbWF4KTtjdHguYmVnaW5QYXRoKCk7Y3R4LmFyYyh4LHksMywwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0FsbG9jYXRpb25DaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiYWxsb2NhdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxpZD1yb3dzLmZpbHRlcihyPT5bci5oZWF0UHVtcCxyLmFubmV4LHIudG90YWxdLnNvbWUoTnVtYmVyLmlzRmluaXRlKSk7IGlmKCF2YWxpZC5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbGlkLm1hcChyPT5NYXRoLm1heCgwLE51bWJlcihyLnRvdGFsKXx8KChOdW1iZXIoci5oZWF0UHVtcCl8fDApKyhOdW1iZXIoci5hbm5leCl8fDApKyhNYXRoLm1heCgwLGRlcml2ZWQocikpfHwwKSkpKSkqMS4xfHwxOyBjb25zdCBsYWJlbHM9dmFsaWQubWFwKHI9Pk1PTlRIU1tOdW1iZXIoci5tb250aC5zbGljZSg1LDcpKS0xXSk7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsbGFiZWxzLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy92YWxpZC5sZW5ndGgsIGJhclc9TWF0aC5taW4oMzgsc2xvdCouNjIpOwogICAgdmFsaWQuZm9yRWFjaCgocixpKT0+eyBjb25zdCB4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzI7IGxldCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SDsgY29uc3QgcGFydHM9W1tNYXRoLm1heCgwLE51bWJlcihyLmhlYXRQdW1wKXx8MCksQ09MT1JTLmhlYXRdLFtNYXRoLm1heCgwLE51bWJlcihyLmFubmV4KXx8MCksQ09MT1JTLmFubmV4XSxbTWF0aC5tYXgoMCxkZXJpdmVkKHIpfHwwKSxDT0xPUlMucmVzdF1dOyBmb3IoY29uc3QgW3YsY29sb3JdIG9mIHBhcnRzKXtjb25zdCBoPWZyYW1lLnBsb3RIKnYvbWF4O3ktPWg7Y3R4LmZpbGxTdHlsZT1jb2xvcjtjdHguZmlsbFJlY3QoeCx5LGJhclcsaCk7fSB9KTsKICB9CiAgZnVuY3Rpb24geWVhckNvbG9yKHllYXIseWVhcnNBc2MpewogICAgY29uc3QgaW5kZXg9TWF0aC5tYXgoMCx5ZWFyc0FzYy5pbmRleE9mKHllYXIpKTsKICAgIHJldHVybiBZRUFSX0NPTE9SU1tpbmRleCVZRUFSX0NPTE9SUy5sZW5ndGhdOwogIH0KICBmdW5jdGlvbiBkcmF3VG90YWxDaGFydEFsbFllYXJzKHllYXJMaXN0KXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgidG90YWxDaGFydCIpKTsgaWYoIWMpcmV0dXJuOwogICAgY29uc3QgeWVhcnNBc2M9Wy4uLnllYXJMaXN0XS5zb3J0KChhLGIpPT5hLWIpOwogICAgY29uc3Qgc2VyaWVzPXllYXJzQXNjLm1hcCh5ZWFyPT4oe3llYXIscm93czphbmFseXNpc1llYXJSb3dzKHllYXIpfSkpLmZpbHRlcihzPT5zLnJvd3Muc29tZShyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpKTsKICAgIGNvbnN0IHZhbHM9c2VyaWVzLmZsYXRNYXAocz0+cy5yb3dzKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKTsKICAgIGlmKCF2YWxzLmxlbmd0aCl7ZHJhd0VtcHR5KGMuY3R4LGMud2lkdGgsYy5oZWlnaHQpOyQoInllYXJDb21wYXJpc29uTGVnZW5kIikuaW5uZXJIVE1MPSIiO3JldHVybjt9CiAgICBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMubWFwKHI9PnIudG90YWwpKSoxLjEyfHwxOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7CiAgICBjb25zdCBjdXJyZW50WWVhcj1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk7CiAgICAkKCJ5ZWFyQ29tcGFyaXNvbkxlZ2VuZCIpLmlubmVySFRNTD1zZXJpZXMubWFwKGl0ZW09Pntjb25zdCBjb2xvcj15ZWFyQ29sb3IoaXRlbS55ZWFyLHllYXJzQXNjKTtjb25zdCBwYXN0PWl0ZW0ueWVhciE9PWN1cnJlbnRZZWFyO3JldHVybiBgPHNwYW4gY2xhc3M9IiR7cGFzdD8icGFzdCI6ImN1cnJlbnQifSIgc3R5bGU9ImNvbG9yOiR7Y29sb3J9Ij48aT48L2k+JHtpdGVtLnllYXJ9JHtwYXN0PyIiOiIgwrcgYWt0dWVsbCJ9PC9zcGFuPmA7fSkuam9pbigiIik7CiAgICBmb3IoY29uc3QgaXRlbSBvZiBzZXJpZXMpewogICAgICBjb25zdCBjb2xvcj15ZWFyQ29sb3IoaXRlbS55ZWFyLHllYXJzQXNjKSxkYXNoZWQ9aXRlbS55ZWFyIT09Y3VycmVudFllYXI7CiAgICAgIGNvbnN0IG1hcD1uZXcgTWFwKGl0ZW0ucm93cy5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKS5tYXAocj0+W051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTEsci50b3RhbF0pKTsKICAgICAgY3R4LnN0cm9rZVN0eWxlPWNvbG9yO2N0eC5saW5lV2lkdGg9ZGFzaGVkPzIuMjozO2N0eC5zZXRMaW5lRGFzaChkYXNoZWQ/WzcsNV06W10pO2N0eC5iZWdpblBhdGgoKTtsZXQgc3RhcnRlZD1mYWxzZTsKICAgICAgZm9yKGxldCBtPTA7bTwxMjttKyspe2lmKCFtYXAuaGFzKG0pKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLW1hcC5nZXQobSkvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fQogICAgICBjdHguc3Ryb2tlKCk7Y3R4LnNldExpbmVEYXNoKFtdKTsKICAgICAgY3R4LmZpbGxTdHlsZT1jb2xvcjtmb3IobGV0IG09MDttPDEyO20rKyl7aWYoIW1hcC5oYXMobSkpY29udGludWU7Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKm0vMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtbWFwLmdldChtKS9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSxkYXNoZWQ/Mi4yOjMuMiwwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBkcmF3Q29zdENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3N0Q2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbHM9cm93cy5tYXAocj0+cmVjb3JkQ29zdChyKSk7IGlmKCF2YWxzLnNvbWUoTnVtYmVyLmlzRmluaXRlKSl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsIktlaW5lIEtvc3RlbmRhdGVuIik7cmV0dXJuO30gY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy8xMixiYXJXPU1hdGgubWluKDM4LHNsb3QqLjYyKTsgdmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgaD1mcmFtZS5wbG90SCp2L21heCx4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzIseT1mcmFtZS50b3ArZnJhbWUucGxvdEgtaDtjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O2N0eC5maWxsUmVjdCh4LHksYmFyVyxoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0NvcENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3BDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgdmFscz1yb3dzLm1hcChyZWNvcmRDb3ApOyBpZighdmFscy5zb21lKE51bWJlci5pc0Zpbml0ZSkpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fSBjb25zdCBtYXg9TWF0aC5tYXgoNSwuLi52YWxzLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKSoxLjA1OyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7IGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuaGVhdDtjdHgubGluZVdpZHRoPTIuNDtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7dmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKmkvMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtdi9tYXgpO2lmKCFzdGFydGVkKXtjdHgubW92ZVRvKHgseSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRlclBhbmVsKCl7CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighbGF0ZXN0KXJldHVybjsKICAgICQoIm1ldGVyTGF0ZXN0IikuaW5uZXJIVE1MPWA8YXJ0aWNsZT48c3Bhbj5TdGFuZCB2b208L3NwYW4+PHN0cm9uZz4ke2RhdGVMYWJlbChsYXRlc3QuZGF0ZSl9PC9zdHJvbmc+PHNtYWxsPmxldHp0ZSBBYmxlc3VuZzwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkdlc2FtdDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC50b3RhbCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkFsdGVudGVpbDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC5hbm5leCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPmA7CiAgICAkKCJtZXRlckhpc3RvcnkiKS5pbm5lckhUTUw9bWV0ZXJSZWFkaW5ncy5zbGljZSgpLnJldmVyc2UoKS5zbGljZSgwLDgpLm1hcCgocixpKT0+YDxkaXYgY2xhc3M9Im1ldGVyLWhpc3Rvcnktcm93Ij48c3Bhbj4ke2RhdGVMYWJlbChyLmRhdGUpfTwvc3Bhbj48c3Ryb25nPkdlc2FtdCAke251bShyLnRvdGFsLDApfTwvc3Ryb25nPjxzdHJvbmc+QWx0ZW50ZWlsICR7bnVtKHIuYW5uZXgsMCl9PC9zdHJvbmc+JHtpPT09bWV0ZXJSZWFkaW5ncy5sZW5ndGgtMT8nPHNtYWxsPlN0YXJ0d2VydDwvc21hbGw+JzonJ308L2Rpdj5gKS5qb2luKCIiKTsKICAgICQoInVuZG9MYXRlc3RNZXRlckJ0biIpLmRpc2FibGVkPW1ldGVyUmVhZGluZ3MubGVuZ3RoPD0xOwogIH0KICBmdW5jdGlvbiByZW5kZXJEYXRhKCl7CiAgICBjb25zdCBpc3N1ZXM9W107IGxldCBjb21wbGV0ZUNvdW50PTA7CiAgICBmb3IoY29uc3QgciBvZiByZWNvcmRzKXsKICAgICAgY29uc3QgbWlzc2luZz1bXTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSltaXNzaW5nLnB1c2goIkdlc2FtdCIpOyBpZighTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApKW1pc3NpbmcucHVzaCgiV8Okcm1lcHVtcGUiKTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLmFubmV4KSltaXNzaW5nLnB1c2goIkFsdGVudGVpbCIpOyBjb25zdCByZXN0PWRlcml2ZWQocik7CiAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwKWlzc3Vlcy5wdXNoKHtsZXZlbDoiZXJyb3IiLG1vbnRoOnIubW9udGgsdGl0bGU6IkF1ZnRlaWx1bmcgdW5wbGF1c2liZWwiLGRldGFpbDpgU2NobGVlL0tsdXMgZXJnaWJ0ICR7bnVtKHJlc3QsMSl9IGtXaC5gfSk7CiAgICAgIGVsc2UgaWYobWlzc2luZy5sZW5ndGgpaXNzdWVzLnB1c2goe2xldmVsOiJ3YXJuaW5nIixtb250aDpyLm1vbnRoLHRpdGxlOiJNb25hdCB1bnZvbGxzdMOkbmRpZyIsZGV0YWlsOmBGZWhsdDogJHttaXNzaW5nLmpvaW4oIiwgIil9YH0pOwogICAgICBlbHNlIGNvbXBsZXRlQ291bnQrKzsKICAgIH0KICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RSZWNvcmQoKTsKICAgIGNvbnN0IHE9WwogICAgICBbIk1vbmF0ZSIsU3RyaW5nKHJlY29yZHMubGVuZ3RoKSwiZ2VzcGVpY2hlcnQiXSwKICAgICAgWyJWb2xsc3TDpG5kaWciLFN0cmluZyhjb21wbGV0ZUNvdW50KSxyZWNvcmRzLmxlbmd0aD9gJHtudW0oY29tcGxldGVDb3VudC9yZWNvcmRzLmxlbmd0aCoxMDAsMCl9ICVgOiLigJMiXSwKICAgICAgWyJIaW53ZWlzZSIsU3RyaW5nKGlzc3Vlcy5sZW5ndGgpLGlzc3Vlcy5zb21lKGk9PmkubGV2ZWw9PT0iZXJyb3IiKT8ibWluZC4gMSBGZWhsZXIiOiJwcsO8ZmVuIl0sCiAgICAgIFsiTGV0enRlciBNb25hdCIsbGF0ZXN0P21vbnRoTGFiZWwobGF0ZXN0Lm1vbnRoLGZhbHNlKToi4oCTIiwiYXV0b21hdGlzY2ggYmVyZWNobmV0Il0KICAgIF07CiAgICAkKCJxdWFsaXR5TWV0cmljcyIpLmlubmVySFRNTD1xLm1hcCgoW2wsdixzXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2x9PC9zcGFuPjxzdHJvbmc+JHt2fTwvc3Ryb25nPjxzbWFsbD4ke3N9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbigiIik7CiAgICAkKCJxdWFsaXR5SXNzdWVzIikuaW5uZXJIVE1MPWlzc3Vlcy5sZW5ndGg/aXNzdWVzLnNsaWNlKCkucmV2ZXJzZSgpLnNsaWNlKDAsMTYpLm1hcChpPT5gPGFydGljbGUgY2xhc3M9Imlzc3VlICR7aS5sZXZlbH0iPjxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChpLm1vbnRoKSl9OiAke2VzY2FwZUh0bWwoaS50aXRsZSl9PC9zdHJvbmc+PHNtYWxsPiR7ZXNjYXBlSHRtbChpLmRldGFpbCl9PC9zbWFsbD48L2Rpdj48L2FydGljbGU+YCkuam9pbigiIik6JzxhcnRpY2xlIGNsYXNzPSJpc3N1ZSI+PGRpdj48c3Ryb25nPktlaW5lIEF1ZmbDpGxsaWdrZWl0ZW48L3N0cm9uZz48c21hbGw+QWxsZSBnZXNwZWljaGVydGVuIE1vbmF0ZSBzaW5kIHBsYXVzaWJlbCB1bmQgdm9sbHN0w6RuZGlnLjwvc21hbGw+PC9kaXY+PC9hcnRpY2xlPic7CiAgICByZW5kZXJNZXRlclBhbmVsKCk7CiAgICAkKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlPXNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiI7CiAgICAkKCJvc3Ryb21BdXRvUmVmcmVzaElucHV0IikuY2hlY2tlZD1zZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlOwogICAgJCgicHJlZmVycmVkV2luZG93SG91cnNJbnB1dCIpLnZhbHVlPVN0cmluZyhzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vyc3x8Myk7CiAgICAkKCJmYWxsYmFja1ByaWNlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMikudG9GaXhlZCgzKTsKICAgICQoImRlZmF1bHRCYXNlRmVlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApLnRvRml4ZWQoMik7CiAgICBjb25zdCBsYXN0QmFja3VwPWxvY2FsU3RvcmFnZS5nZXRJdGVtKExBU1RfQkFDS1VQX0tFWSk7ICQoImJhY2t1cFN0YXR1cyIpLnRleHRDb250ZW50PWxhc3RCYWNrdXA/YExldHp0ZXMgQmFja3VwOiAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2RhdGVTdHlsZToibWVkaXVtIix0aW1lU3R5bGU6InNob3J0In0pLmZvcm1hdChuZXcgRGF0ZShsYXN0QmFja3VwKSl9YDoiTm9jaCBrZWluIEJhY2t1cCBtaXQgRWxkZWhvZiA2LjIgZXJzdGVsbHQuIjsKICAgIGNvbnN0IGhpc3RvcnlTdGF0dXM9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShPU1RST01fSElTVE9SWV9LRVkpLG51bGwpOwogICAgaWYoJCgib3N0cm9tSGlzdG9yeVN0YXR1cyIpKSQoIm9zdHJvbUhpc3RvcnlTdGF0dXMiKS50ZXh0Q29udGVudD1vc3Ryb21IaXN0b3J5QnVzeT8iSGlzdG9yaXNjaGUgT3N0cm9tLVByZWlzZSB3ZXJkZW4gZ2VsYWRlbiDigKYiOmhpc3RvcnlTdGF0dXM/LnVwZGF0ZWRBdD9gUHJlaXNoaXN0b3JpZSB6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUoaGlzdG9yeVN0YXR1cy51cGRhdGVkQXQpfSDCtyAke2hpc3RvcnlTdGF0dXMudXBkYXRlZHx8MH0gTW9uYXQoZSkgZXhha3QgwrcgJHtoaXN0b3J5U3RhdHVzLnVuYXZhaWxhYmxlfHwwfSBuaWNodCB2ZXJmw7xnYmFyYDpgSGlzdG9yaXNjaGUgUHJlaXNlIG5vY2ggbmljaHQgZ2VwcsO8ZnQuYDsKICAgIHJlbmRlclN5bmNQYW5lbCgpOwogIH0KCiAgZnVuY3Rpb24gZG93bmxvYWRCbG9iKGNvbnRlbnQsZmlsZW5hbWUsdHlwZSl7IGNvbnN0IGJsb2I9bmV3IEJsb2IoW2NvbnRlbnRdLHt0eXBlfSk7IGNvbnN0IHVybD1VUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOyBjb25zdCBhPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImEiKTsgYS5ocmVmPXVybDthLmRvd25sb2FkPWZpbGVuYW1lO2RvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYSk7YS5jbGljaygpO2EucmVtb3ZlKCk7c2V0VGltZW91dCgoKT0+VVJMLnJldm9rZU9iamVjdFVSTCh1cmwpLDEwMDApOyB9CiAgZnVuY3Rpb24gZXhwb3J0QmFja3VwKCl7CiAgICBjb25zdCBub3c9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgY29uc3QgcmVsZXZhbnRTZXR0aW5ncz17ZmFsbGJhY2tQcmljZTpzZXR0aW5ncy5mYWxsYmFja1ByaWNlLGRlZmF1bHRCYXNlRmVlOnNldHRpbmdzLmRlZmF1bHRCYXNlRmVlLG9zdHJvbUFwcEtleTpzZXR0aW5ncy5vc3Ryb21BcHBLZXksb3N0cm9tQXV0b1JlZnJlc2g6c2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2gscHJlZmVycmVkV2luZG93SG91cnM6c2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnN9OwogICAgY29uc3QgcGF5bG9hZD17dmVyc2lvbjoiNi4zLjEiLGFwcDoiRWxkZWhvZiIscHVycG9zZToiUHJpdmF0ZXMgbG9rYWxlcyBCYWNrdXAg4oCTIG5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbiIsZXhwb3J0ZWRBdDpub3csc2V0dGluZ3M6cmVsZXZhbnRTZXR0aW5ncyxyZWNvcmRzLHZhaWxsYW50TW9udGhzLG1ldGVyUmVhZGluZ3Msb3N0cm9tUHJpY2VTdGF0cyxjbGltYXRlTW9udGhzLGNsaW1hdGVXZWF0aGVyfTsKICAgIGRvd25sb2FkQmxvYihKU09OLnN0cmluZ2lmeShwYXlsb2FkLG51bGwsMiksYEVsZGVob2ZfUFJJVkFURV9CYWNrdXBfJHtkYXRlU3RhbXAoKX0uanNvbmAsImFwcGxpY2F0aW9uL2pzb24iKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTEFTVF9CQUNLVVBfS0VZLG5vdyk7IHJlbmRlckRhdGEoKTsgdG9hc3QoIlByaXZhdGVzIEJhY2t1cCBlcnN0ZWxsdCIpOwogIH0KICBmdW5jdGlvbiBleHBvcnRDc3YoKXsKICAgIGNvbnN0IHJvd3M9W1siTW9uYXQiLCJXw6RybWVwdW1wZSBrV2giLCJFcnpldWd0ZSBXw6RybWUga1doIiwiQXJiZWl0c3phaGwiLCJBbHRlbnRlaWwga1doIiwiU2NobGVlL0tsdXMga1doIiwiR2VzYW10IGtXaCIsIkdlc2FtdC1aw6RobGVyc3RhbmQga1doIiwiQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2giLCJBYmxlc2VkYXR1bSIsIlByZWlzIGN0L2tXaCIsIkZpeGtvc3RlbiBFVVIiLCJLb3N0ZW4gRVVSIiwiUHJlaXNxdWVsbGUiLCJPc3Ryb20tVmVyYnJhdWNoIGtXaCIsIk5vdGl6Il1dOwogICAgZm9yKGNvbnN0IHIgb2Ygc29ydGVkKCkpcm93cy5wdXNoKFtyLm1vbnRoLHIuaGVhdFB1bXA/PyIiLHIuaGVhdEdlbmVyYXRlZD8/IiIscmVjb3JkQ29wKHIpPz8iIixyLmFubmV4Pz8iIixkZXJpdmVkKHIpPz8iIixyLnRvdGFsPz8iIixyLnRvdGFsTWV0ZXJSZWFkaW5nPz8iIixyLmFubmV4TWV0ZXJSZWFkaW5nPz8iIixyLm1ldGVyUmVhZGluZ0RhdGU/PyIiLHIucHJpY2VDdD8/IiIsci5iYXNlRmVlPz8iIixyZWNvcmRDb3N0KHIpPz8iIixyLnByaWNlU291cmNlfHwiIixyLm9zdHJvbUNvbnN1bXB0aW9uS1doPz8iIixyLm5vdGV8fCIiXSk7CiAgICBkb3dubG9hZEJsb2IoIlx1RkVGRiIrcm93cy5tYXAocm93PT5yb3cubWFwKGNzdkNlbGwpLmpvaW4oIjsiKSkuam9pbigiXG4iKSxgRWxkZWhvZl9WZXJicmF1Y2hfJHtkYXRlU3RhbXAoKX0uY3N2YCwidGV4dC9jc3Y7Y2hhcnNldD11dGYtOCIpOyB0b2FzdCgiQ1NWIGVyc3RlbGx0Iik7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhY2t1cChmaWxlKXsKICAgIHRyeXsKICAgICAgY29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKGF3YWl0IGZpbGUudGV4dCgpKTsgY29uc3QgaW5jb21pbmc9QXJyYXkuaXNBcnJheShwYXlsb2FkKT9wYXlsb2FkOihBcnJheS5pc0FycmF5KHBheWxvYWQucmVjb3Jkcyk/cGF5bG9hZC5yZWNvcmRzOnBheWxvYWQuZGF0YSk7IGlmKCFBcnJheS5pc0FycmF5KGluY29taW5nKSl0aHJvdyBuZXcgRXJyb3IoIktlaW5lIE1vbmF0c2RhdGVuIGdlZnVuZGVuLiIpOwogICAgICBjb25zdCBjbGVhbmVkPXNhbml0aXplUmVjb3JkcyhpbmNvbWluZyk7IGlmKCFjbGVhbmVkLmxlbmd0aCYmIWNvbmZpcm0oIkRhcyBCYWNrdXAgZW50aMOkbHQga2VpbmUgTW9uYXRzd2VydGUuIExlZXJlbiBCZXN0YW5kIHdpcmtsaWNoIGltcG9ydGllcmVuPyIpKXJldHVybjsKICAgICAgaWYoIWNvbmZpcm0oYCR7Y2xlYW5lZC5sZW5ndGh9IE1vbmF0c3dlcnRlIGF1cyBkZW0gQmFja3VwIMO8YmVybmVobWVuPyBEZXIgYWt0dWVsbGUgU3RhbmQgd2lyZCB2b3JoZXIgbG9rYWwgZ2VzaWNoZXJ0LmApKXJldHVybjsKICAgICAgY29uc3QgaW1wb3J0U3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgICBzYXZlUmVjb3JkcyhjbGVhbmVkLm1hcChyPT4oey4uLnIsdXBkYXRlZEF0OmltcG9ydFN0YW1wfSkpLHtyZWFzb246IkJhY2t1cCBpbXBvcnRpZXJ0IixhbGxvd0VtcHR5OnRydWV9KTsKICAgICAgaWYocGF5bG9hZC5zZXR0aW5ncyYmdHlwZW9mIHBheWxvYWQuc2V0dGluZ3M9PT0ib2JqZWN0Iil7CiAgICAgICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLnBheWxvYWQuc2V0dGluZ3N9OwogICAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5wcmljZSkpJiYhTnVtYmVyLmlzRmluaXRlKE51bWJlcihwYXlsb2FkLnNldHRpbmdzLmZhbGxiYWNrUHJpY2UpKSlzZXR0aW5ncy5mYWxsYmFja1ByaWNlPU51bWJlcihwYXlsb2FkLnNldHRpbmdzLnByaWNlKTsKICAgICAgICBzYXZlU2V0dGluZ3MoKTsKICAgICAgfQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQudmFpbGxhbnRNb250aHMpKXsgdmFpbGxhbnRNb250aHM9cGF5bG9hZC52YWlsbGFudE1vbnRocy5tYXAodj0+KHsuLi52LHVwZGF0ZWRBdDppbXBvcnRTdGFtcH0pKTsgc2F2ZVZhaWxsYW50TW9udGhzKCk7IH0KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLm1ldGVyUmVhZGluZ3MpKXtzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3MpO31lbHNle21ldGVyUmVhZGluZ3M9bG9hZE1ldGVyUmVhZGluZ3MoKTtlbnN1cmVNZXRlckJhc2VsaW5lKCk7fQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQub3N0cm9tUHJpY2VTdGF0cykpc2F2ZU9zdHJvbVByaWNlU3RhdHMocGF5bG9hZC5vc3Ryb21QcmljZVN0YXRzKTsKICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLmNsaW1hdGVNb250aHMpKXNhdmVDbGltYXRlTW9udGhzKHBheWxvYWQuY2xpbWF0ZU1vbnRocyk7CiAgICAgIGlmKHBheWxvYWQuY2xpbWF0ZVdlYXRoZXImJnR5cGVvZiBwYXlsb2FkLmNsaW1hdGVXZWF0aGVyPT09Im9iamVjdCIpe2NsaW1hdGVXZWF0aGVyPXBheWxvYWQuY2xpbWF0ZVdlYXRoZXI7bG9jYWxTdG9yYWdlLnNldEl0ZW0oQ0xJTUFURV9XRUFUSEVSX0tFWSxKU09OLnN0cmluZ2lmeShjbGltYXRlV2VhdGhlcikpO30KICAgICAgcmVuZGVyQWxsKCk7IHRvYXN0KCJCYWNrdXAgaW1wb3J0aWVydCIpOwogICAgfWNhdGNoKGVycm9yKXsgYWxlcnQoYEJhY2t1cCBrb25udGUgbmljaHQgaW1wb3J0aWVydCB3ZXJkZW46ICR7ZXJyb3IubWVzc2FnZX1gKTsgfQogICAgZmluYWxseXsgJCgiaW1wb3J0QmFja3VwSW5wdXQiKS52YWx1ZT0iIjsgfQogIH0KCgogIC8qIEVsZGVob2YgNi4wLjEg4oCTIHNjaGxhbmtlciBsb2thbGVyIG15VkFJTExBTlQtQ1NWLUltcG9ydCAqLwogIGZ1bmN0aW9uIHZhaWxsYW50Q3N2TnVtYmVyKHZhbHVlKXsKICAgIGNvbnN0IHRleHQ9U3RyaW5nKHZhbHVlPz8iIikudHJpbSgpOwogICAgaWYoIXRleHQpcmV0dXJuIG51bGw7CiAgICBjb25zdCBub3JtYWxpemVkPXRleHQuaW5jbHVkZXMoIiwiKSYmdGV4dC5pbmNsdWRlcygiLiIpCiAgICAgID90ZXh0Lmxhc3RJbmRleE9mKCIsIik+dGV4dC5sYXN0SW5kZXhPZigiLiIpCiAgICAgICAgP3RleHQucmVwbGFjZSgvXC4vZywiIikucmVwbGFjZSgiLCIsIi4iKQogICAgICAgIDp0ZXh0LnJlcGxhY2UoLywvZywiIikKICAgICAgOnRleHQucmVwbGFjZSgiLCIsIi4iKTsKICAgIGNvbnN0IG51bWJlcj1OdW1iZXIobm9ybWFsaXplZCk7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG51bWJlcik/bnVtYmVyOm51bGw7CiAgfQogIGZ1bmN0aW9uIHZhaWxsYW50Q3N2RGF0ZVBhcnRzKHZhbHVlKXsKICAgIGNvbnN0IG1hdGNoPS9eKFxkezR9KS0oXGR7Mn0pLShcZHsyfSkoPzpbIFRdKFxkezJ9KTooXGR7Mn0pOihcZHsyfSkpPyQvLmV4ZWMoU3RyaW5nKHZhbHVlfHwiIikudHJpbSgpKTsKICAgIGlmKCFtYXRjaClyZXR1cm4gbnVsbDsKICAgIGNvbnN0IHllYXI9TnVtYmVyKG1hdGNoWzFdKSxtb250aD1OdW1iZXIobWF0Y2hbMl0pLGRheT1OdW1iZXIobWF0Y2hbM10pOwogICAgY29uc3QgZGF0ZT1uZXcgRGF0ZShEYXRlLlVUQyh5ZWFyLG1vbnRoLTEsZGF5KSk7CiAgICBpZihkYXRlLmdldFVUQ0Z1bGxZZWFyKCkhPT15ZWFyfHxkYXRlLmdldFVUQ01vbnRoKCkhPT1tb250aC0xfHxkYXRlLmdldFVUQ0RhdGUoKSE9PWRheSlyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7eWVhcixtb250aCxkYXksZGF0ZUtleTpgJHttYXRjaFsxXX0tJHttYXRjaFsyXX0tJHttYXRjaFszXX1gLG1vbnRoS2V5OmAke21hdGNoWzFdfS0ke21hdGNoWzJdfWAsZGF0ZVRpbWU6U3RyaW5nKHZhbHVlfHwiIikudHJpbSgpfTsKICB9CiAgZnVuY3Rpb24gZGV0ZWN0VmFpbGxhbnRDc3ZUeXBlKGhlYWRlcnMpewogICAgY29uc3QgZmllbGRzPW5ldyBTZXQoaGVhZGVycyksaGFzPW5hbWU9PmZpZWxkcy5oYXMobmFtZSk7CiAgICBpZihoYXMoIkRhdGVUaW1lIikmJmhhcygiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6RG9tZXN0aWNIb3RXYXRlciIpKXJldHVybiAiYXJvdGhlcm0tZW5lcmd5IjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpJiYhaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpKXJldHVybiAidW5pdG93ZXItZW5lcmd5IjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJPdXRkb29yVGVtcGVyYXR1cmUiKSlyZXR1cm4gInN5c3RlbS10ZW1wZXJhdHVyZSI7CiAgICBpZihoYXMoIkRhdGVUaW1lIikmJmhhcygiQ3VycmVudFJvb21UZW1wZXJhdHVyZSIpKXJldHVybiAiem9uZS10ZW1wZXJhdHVyZSI7CiAgICBpZihoYXMoIkRhdGVUaW1lIikmJmhhcygiRGh3VGFua1RlbXBlcmF0dXJlIikpcmV0dXJuICJkaHctdGVtcGVyYXR1cmUiOwogICAgaWYoaGFzKCJtb250aCIpJiZoYXMoImVsZWN0cmljaXR5S1doIikmJmhhcygiaGVhdGluZ0hlYXRLV2giKSlyZXR1cm4gIm1vbnRobHktZW5lcmd5IjsKICAgIHJldHVybiAidW5rbm93biI7CiAgfQogIGZ1bmN0aW9uIHBhcnNlVmFpbGxhbnRDc3ZUZXh0KHRleHQsaW5kZXg9MCl7CiAgICBjb25zdCBub3JtYWxpemVkPVN0cmluZyh0ZXh0fHwiIikucmVwbGFjZSgvXlx1RkVGRi8sIiIpLnJlcGxhY2UoL1xyXG4/L2csIlxuIik7CiAgICBjb25zdCBleHBvcnRlZEF0PShub3JtYWxpemVkLm1hdGNoKC9leHBvcnRlZCBhdFxzKyhcZHs0fS1cZHsyfS1cZHsyfSlccytcZHsyfTpcZHsyfS9pKXx8W10pWzFdfHxudWxsOwogICAgY29uc3QgZGF0YUxpbmVzPW5vcm1hbGl6ZWQuc3BsaXQoIlxuIikuZmlsdGVyKGxpbmU9Pntjb25zdCB0PWxpbmUudHJpbSgpO3JldHVybiB0JiYhdC5zdGFydHNXaXRoKCIjIik7fSk7CiAgICBpZighZGF0YUxpbmVzLmxlbmd0aClyZXR1cm4ge2luZGV4LHR5cGU6InVua25vd24iLHJvd3M6W10saW52YWxpZFJvd3M6MH07CiAgICBjb25zdCBkZWxpbWl0ZXI9ZGF0YUxpbmVzWzBdLmluY2x1ZGVzKCI7Iik/IjsiOiIsIjsKICAgIGNvbnN0IGhlYWRlcnM9ZGF0YUxpbmVzWzBdLnNwbGl0KGRlbGltaXRlcikubWFwKHY9PnYudHJpbSgpKTsKICAgIGNvbnN0IHR5cGU9ZGV0ZWN0VmFpbGxhbnRDc3ZUeXBlKGhlYWRlcnMpLHJvd3M9W107bGV0IGludmFsaWRSb3dzPTA7CiAgICBpZih0eXBlPT09Im1vbnRobHktZW5lcmd5Iil7CiAgICAgIGZvcihjb25zdCBsaW5lIG9mIGRhdGFMaW5lcy5zbGljZSgxKSl7CiAgICAgICAgY29uc3QgcGFydHM9bGluZS5zcGxpdChkZWxpbWl0ZXIpLHJhdz1PYmplY3QuZnJvbUVudHJpZXMoaGVhZGVycy5tYXAoKGgsaSk9PltoLHBhcnRzW2ldPz8iIl0pKSxtb250aD1TdHJpbmcocmF3Lm1vbnRofHwiIikudHJpbSgpOwogICAgICAgIGlmKCEvXlxkezR9LSgwWzEtOV18MVswLTJdKSQvLnRlc3QobW9udGgpKXtpbnZhbGlkUm93cysrO2NvbnRpbnVlO30KICAgICAgICBjb25zdCB2YWx1ZXM9e307CiAgICAgICAgZm9yKGNvbnN0IGggb2YgaGVhZGVycyl7CiAgICAgICAgICBpZihoPT09Im1vbnRoIiljb250aW51ZTsKICAgICAgICAgIHZhbHVlc1toXT1bImNvbXBsZXRlIiwiZXN0aW1hdGVkIl0uaW5jbHVkZXMoaCk/U3RyaW5nKHJhd1toXSkudHJpbSgpLnRvTG93ZXJDYXNlKCk9PT0idHJ1ZSI6dmFpbGxhbnRDc3ZOdW1iZXIocmF3W2hdKTsKICAgICAgICB9CiAgICAgICAgcm93cy5wdXNoKHttb250aEtleTptb250aCx2YWx1ZXN9KTsKICAgICAgfQogICAgICByZXR1cm4ge2luZGV4LHR5cGUsaGVhZGVycyxyb3dzLGludmFsaWRSb3dzLGV4cG9ydGVkQXR9OwogICAgfQogICAgZm9yKGNvbnN0IGxpbmUgb2YgZGF0YUxpbmVzLnNsaWNlKDEpKXsKICAgICAgaWYoIWxpbmUudHJpbSgpKWNvbnRpbnVlOwogICAgICBjb25zdCB2YWx1ZXM9bGluZS5zcGxpdChkZWxpbWl0ZXIpOwogICAgICBjb25zdCByYXc9T2JqZWN0LmZyb21FbnRyaWVzKGhlYWRlcnMubWFwKChoZWFkZXIsY29sdW1uKT0+W2hlYWRlcix2YWx1ZXNbY29sdW1uXT8/IiJdKSk7CiAgICAgIGNvbnN0IGRhdGU9dmFpbGxhbnRDc3ZEYXRlUGFydHMocmF3LkRhdGVUaW1lKTtpZighZGF0ZSl7aW52YWxpZFJvd3MrKztjb250aW51ZTt9CiAgICAgIGNvbnN0IHBhcnNlZD17Li4uZGF0ZSx2YWx1ZXM6e319OwogICAgICBmb3IoY29uc3QgaGVhZGVyIG9mIGhlYWRlcnMpe2lmKGhlYWRlciE9PSJEYXRlVGltZSIpcGFyc2VkLnZhbHVlc1toZWFkZXJdPXZhaWxsYW50Q3N2TnVtYmVyKHJhd1toZWFkZXJdKTt9CiAgICAgIHJvd3MucHVzaChwYXJzZWQpOwogICAgfQogICAgcmV0dXJuIHtpbmRleCx0eXBlLGhlYWRlcnMscm93cyxpbnZhbGlkUm93cyxleHBvcnRlZEF0fTsKICB9CiAgZnVuY3Rpb24gc2FtZVZhaWxsYW50VmFsdWUoYSxiLHRvbGVyYW5jZT0uMDUpewogICAgaWYoYT09bnVsbHx8Yj09bnVsbClyZXR1cm4gYT09bnVsbCYmYj09bnVsbDsKICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGEpKSYmTnVtYmVyLmlzRmluaXRlKE51bWJlcihiKSk/TWF0aC5hYnMoTnVtYmVyKGEpLU51bWJlcihiKSk8PXRvbGVyYW5jZTpTdHJpbmcoYSk9PT1TdHJpbmcoYik7CiAgfQogIGZ1bmN0aW9uIGJ1aWxkVmFpbGxhbnRJbXBvcnRQcmV2aWV3KHBhcnNlZEZpbGVzKXsKICAgIGNvbnN0IGVuZXJneVR5cGVzPVsiYXJvdGhlcm0tZW5lcmd5IiwidW5pdG93ZXItZW5lcmd5Il07CiAgICBjb25zdCBkYWlseT17ImFyb3RoZXJtLWVuZXJneSI6bmV3IE1hcCgpLCJ1bml0b3dlci1lbmVyZ3kiOm5ldyBNYXAoKX07CiAgICBjb25zdCBjb25mbGljdE1vbnRocz1uZXcgU2V0KCk7bGV0IGR1cGxpY2F0ZVJvd3M9MDsKICAgIGZvcihjb25zdCBmaWxlIG9mIHBhcnNlZEZpbGVzLmZpbHRlcihmPT5lbmVyZ3lUeXBlcy5pbmNsdWRlcyhmLnR5cGUpKSl7CiAgICAgIGNvbnN0IHRhcmdldD1kYWlseVtmaWxlLnR5cGVdOwogICAgICBmb3IoY29uc3Qgcm93IG9mIGZpbGUucm93cyl7CiAgICAgICAgY29uc3QgZXhpc3Rpbmc9dGFyZ2V0LmdldChyb3cuZGF0ZUtleSk7CiAgICAgICAgaWYoIWV4aXN0aW5nKXt0YXJnZXQuc2V0KHJvdy5kYXRlS2V5LHJvdyk7Y29udGludWU7fQogICAgICAgIGNvbnN0IG1ldHJpY3M9bmV3IFNldChbLi4uT2JqZWN0LmtleXMoZXhpc3RpbmcudmFsdWVzfHx7fSksLi4uT2JqZWN0LmtleXMocm93LnZhbHVlc3x8e30pXSk7CiAgICAgICAgY29uc3QgZGlmZmVycz1bLi4ubWV0cmljc10uc29tZShtZXRyaWM9PiFzYW1lVmFpbGxhbnRWYWx1ZShleGlzdGluZy52YWx1ZXM/LlttZXRyaWNdLHJvdy52YWx1ZXM/LlttZXRyaWNdKSk7CiAgICAgICAgaWYoZGlmZmVycyljb25mbGljdE1vbnRocy5hZGQocm93Lm1vbnRoS2V5KTtlbHNlIGR1cGxpY2F0ZVJvd3MrKzsKICAgICAgfQogICAgfQogICAgY29uc3QgYWxsRGF0ZXM9Wy4uLm5ldyBTZXQoWy4uLmRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXS5rZXlzKCksLi4uZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLmtleXMoKV0pXTsKICAgIGNvbnN0IG1vbnRoS2V5cz1bLi4ubmV3IFNldChhbGxEYXRlcy5tYXAoZD0+ZC5zbGljZSgwLDcpKSldLnNvcnQoKTsKICAgIGNvbnN0IHN1bT0obWFwLGRhdGVzLG1ldHJpYyk9PmRhdGVzLnJlZHVjZSgocyxrZXkpPT57Y29uc3Qgdj1tYXAuZ2V0KGtleSk/LnZhbHVlcz8uW21ldHJpY107cmV0dXJuIHMrKE51bWJlci5pc0Zpbml0ZSh2KT92OjApO30sMCk7CiAgICBjb25zdCBmdWxsPShkYXRlcyx5LG0pPT57Y29uc3QgZXhwZWN0ZWQ9bmV3IERhdGUoeSxtLDApLmdldERhdGUoKSx1PVsuLi5uZXcgU2V0KGRhdGVzKV0uc29ydCgpO3JldHVybiB1Lmxlbmd0aD09PWV4cGVjdGVkJiZ1WzBdPT09YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwiMCIpfS0wMWAmJnUuYXQoLTEpPT09YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwiMCIpfS0ke1N0cmluZyhleHBlY3RlZCkucGFkU3RhcnQoMiwiMCIpfWA7fTsKICAgIGNvbnN0IGN1cnJlbnQ9Y3VycmVudE1vbnRoS2V5KCk7CiAgICBjb25zdCBtb250aHM9bW9udGhLZXlzLm1hcChtb250aD0+ewogICAgICBjb25zdCB5PU51bWJlcihtb250aC5zbGljZSgwLDQpKSxtPU51bWJlcihtb250aC5zbGljZSg1LDcpKTsKICAgICAgY29uc3QgYXJvPVsuLi5kYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0ua2V5cygpXS5maWx0ZXIoaz0+ay5zdGFydHNXaXRoKGAke21vbnRofS1gKSkuc29ydCgpOwogICAgICBjb25zdCB1bmk9Wy4uLmRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXS5rZXlzKCldLmZpbHRlcihrPT5rLnN0YXJ0c1dpdGgoYCR7bW9udGh9LWApKS5zb3J0KCk7CiAgICAgIGNvbnN0IHVuaW9uPVsuLi5uZXcgU2V0KFsuLi5hcm8sLi4udW5pXSldLnNvcnQoKTsKICAgICAgY29uc3QgZXhwb3J0ZWRQYXJ0aWFsPXBhcnNlZEZpbGVzLnNvbWUoZj0+WyJhcm90aGVybS1lbmVyZ3kiLCJ1bml0b3dlci1lbmVyZ3kiXS5pbmNsdWRlcyhmLnR5cGUpJiZmLmV4cG9ydGVkQXQ/LnNsaWNlKDAsNyk9PT1tb250aCk7CiAgICAgICBjb25zdCBjb21wbGV0ZT1mdWxsKGFybyx5LG0pJiZmdWxsKHVuaSx5LG0pJiYhZXhwb3J0ZWRQYXJ0aWFsJiZtb250aCE9PWN1cnJlbnQ7CiAgICAgIGNvbnN0IGhlYXRpbmdFbGVjdHJpY2l0eT0oc3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikrc3VtKGRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXSx1bmksIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikpLzEwMDA7CiAgICAgIGNvbnN0IGRod0VsZWN0cmljaXR5PXN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpLzEwMDA7CiAgICAgIGNvbnN0IGhlYXRpbmdIZWF0PShzdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikrc3VtKGRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXSx1bmksIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpKS8xMDAwOwogICAgICBjb25zdCBkaHdIZWF0PXN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJIZWF0R2VuZXJhdGVkOkRvbWVzdGljSG90V2F0ZXIiKS8xMDAwOwogICAgICBjb25zdCBlbGVjdHJpY2l0eUtXaD1oZWF0aW5nRWxlY3RyaWNpdHkrZGh3RWxlY3RyaWNpdHksaGVhdEdlbmVyYXRlZEtXaD1oZWF0aW5nSGVhdCtkaHdIZWF0OwogICAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aChtb250aCk7CiAgICAgIGNvbnN0IG5lZ2F0aXZlUmVzdD1Cb29sZWFuKGV4aXN0aW5nJiZOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcuYW5uZXgpJiZleGlzdGluZy50b3RhbC1lbGVjdHJpY2l0eUtXaC1leGlzdGluZy5hbm5leDwtLjAxKTsKICAgICAgY29uc3QgaGFzQ29uZmxpY3Q9Y29uZmxpY3RNb250aHMuaGFzKG1vbnRoKSxoYXNCb3RoPWFyby5sZW5ndGg+MCYmdW5pLmxlbmd0aD4wLGlzQ3VycmVudD1tb250aD09PWN1cnJlbnQsaXNGdXR1cmU9bW9udGg+Y3VycmVudDsKICAgICAgY29uc3QgYmxvY2tlZD0haGFzQm90aHx8aGFzQ29uZmxpY3R8fG5lZ2F0aXZlUmVzdHx8aXNGdXR1cmV8fCghY29tcGxldGUmJiFpc0N1cnJlbnQpOwogICAgICByZXR1cm4ge21vbnRoLGVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2gsaGVhdGluZ0VsZWN0cmljaXR5S1doOmhlYXRpbmdFbGVjdHJpY2l0eSxkaHdFbGVjdHJpY2l0eUtXaDpkaHdFbGVjdHJpY2l0eSxoZWF0aW5nSGVhdEtXaDpoZWF0aW5nSGVhdCxkaHdIZWF0S1doOmRod0hlYXQsY29tcGxldGUsY292ZXJhZ2VTdGFydDp1bmlvblswXXx8bnVsbCxjb3ZlcmFnZUVuZDp1bmlvbi5hdCgtMSl8fG51bGwsYmxvY2tlZCxoYXNCb3RoLGhhc0NvbmZsaWN0LG5lZ2F0aXZlUmVzdCxpc0N1cnJlbnR9OwogICAgfSk7CiAgICByZXR1cm4ge21vbnRocyxkdXBsaWNhdGVSb3dzLHJlY29nbml6ZWQ6cGFyc2VkRmlsZXMuZmlsdGVyKGY9PmYudHlwZSE9PSJ1bmtub3duIikubGVuZ3RoLHVua25vd246cGFyc2VkRmlsZXMuZmlsdGVyKGY9PmYudHlwZT09PSJ1bmtub3duIikubGVuZ3RoLGludmFsaWRSb3dzOnBhcnNlZEZpbGVzLnJlZHVjZSgocyxmKT0+cytmLmludmFsaWRSb3dzLDApfTsKICB9CiAgZnVuY3Rpb24gbWVyZ2VWYWlsbGFudEltcG9ydChtb250aHMpewogICAgY29uc3QgcmVjb3JkTWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgY29uc3QgdmFpbGxhbnRNYXA9bmV3IE1hcCgodmFpbGxhbnRNb250aHN8fFtdKS5tYXAodj0+W3YubW9udGgsey4uLnZ9XSkpOwogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO2xldCBpbXBvcnRlZD0wLGNyZWF0ZWQ9MCxwYXJ0aWFsPTA7CiAgICBmb3IoY29uc3QgbW9udGggb2YgbW9udGhzLmZpbHRlcihtPT4hbS5ibG9ja2VkKSl7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZE1hcC5nZXQobW9udGgubW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6bW9udGgubW9udGh9KTsKICAgICAgY29uc3Qgd2FzTmV3PSFyZWNvcmRNYXAuaGFzKG1vbnRoLm1vbnRoKTsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXA9bW9udGguZWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRHZW5lcmF0ZWQ9bW9udGguaGVhdEdlbmVyYXRlZEtXaDsKICAgICAgZXhpc3RpbmcuaGVhdGluZ0VsZWN0cmljaXR5PW1vbnRoLmhlYXRpbmdFbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuZGh3RWxlY3RyaWNpdHk9bW9udGguZGh3RWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRpbmdIZWF0PW1vbnRoLmhlYXRpbmdIZWF0S1doOwogICAgICBleGlzdGluZy5kaHdIZWF0PW1vbnRoLmRod0hlYXRLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wU291cmNlPW1vbnRoLmNvbXBsZXRlPyJteXZhaWxsYW50LWNzdi1pbXBvcnQiOiJteXZhaWxsYW50LWNzdi1pbXBvcnQtcGFydGlhbCI7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wVXBkYXRlZEF0PXN0YW1wOwogICAgICBleGlzdGluZy51cGRhdGVkQXQ9c3RhbXA7CiAgICAgIGlmKCFtb250aC5jb21wbGV0ZSl7CiAgICAgICAgcGFydGlhbCsrOwogICAgICAgIGNvbnN0IG5vdGU9YG15VkFJTExBTlQgQ1NWLVRlaWxtb25hdCAke21vbnRoLmNvdmVyYWdlU3RhcnR9IGJpcyAke21vbnRoLmNvdmVyYWdlRW5kfWA7CiAgICAgICAgaWYoIVN0cmluZyhleGlzdGluZy5ub3RlfHwiIikuaW5jbHVkZXMobm90ZSkpZXhpc3Rpbmcubm90ZT1leGlzdGluZy5ub3RlP2Ake2V4aXN0aW5nLm5vdGV9IOKAoiAke25vdGV9YDpub3RlOwogICAgICAgIGV4aXN0aW5nLmNsb3NlZD1mYWxzZTtleGlzdGluZy5jbG9zZWRBdD1udWxsOwogICAgICB9CiAgICAgIHJlY29yZE1hcC5zZXQobW9udGgubW9udGgsZXhpc3RpbmcpOwogICAgICB2YWlsbGFudE1hcC5zZXQobW9udGgubW9udGgse21vbnRoOm1vbnRoLm1vbnRoLGVsZWN0cmljaXR5S1doOm1vbnRoLmVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2g6bW9udGguaGVhdEdlbmVyYXRlZEtXaCxoZWF0aW5nRWxlY3RyaWNpdHlLV2g6bW9udGguaGVhdGluZ0VsZWN0cmljaXR5S1doLGRod0VsZWN0cmljaXR5S1doOm1vbnRoLmRod0VsZWN0cmljaXR5S1doLGhlYXRpbmdIZWF0S1doOm1vbnRoLmhlYXRpbmdIZWF0S1doLGRod0hlYXRLV2g6bW9udGguZGh3SGVhdEtXaCxzb3VyY2U6ZXhpc3RpbmcuaGVhdFB1bXBTb3VyY2UsZXN0aW1hdGVkOiFtb250aC5jb21wbGV0ZSx1cGRhdGVkQXQ6c3RhbXB9KTsKICAgICAgaW1wb3J0ZWQrKztpZih3YXNOZXcpY3JlYXRlZCsrOwogICAgfQogICAgc2F2ZVJlY29yZHMoWy4uLnJlY29yZE1hcC52YWx1ZXMoKV0se3JlYXNvbjoibXlWQUlMTEFOVCBDU1YgaW1wb3J0aWVydCJ9KTsKICAgIHZhaWxsYW50TW9udGhzPVsuLi52YWlsbGFudE1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTtzYXZlVmFpbGxhbnRNb250aHMoKTsKICAgIHJldHVybiB7aW1wb3J0ZWQsY3JlYXRlZCxwYXJ0aWFsfTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gaW1wb3J0VmFpbGxhbnRDc3ZGaWxlcyhmaWxlTGlzdCl7CiAgICBjb25zdCBmaWxlcz1bLi4uKGZpbGVMaXN0fHxbXSldO2lmKCFmaWxlcy5sZW5ndGgpcmV0dXJuOwogICAgc2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsIkRhdGVpZW4gd2VyZGVuIGxva2FsIGdlcHLDvGZ0IOKApiIpOwogICAgdHJ5ewogICAgICBjb25zdCBwYXJzZWQ9W107Zm9yKGxldCBpPTA7aTxmaWxlcy5sZW5ndGg7aSsrKXBhcnNlZC5wdXNoKHBhcnNlVmFpbGxhbnRDc3ZUZXh0KGF3YWl0IGZpbGVzW2ldLnRleHQoKSxpKSk7CiAgICAgIGNvbnN0IGhhc0Fybz1wYXJzZWQuc29tZSh4PT54LnR5cGU9PT0iYXJvdGhlcm0tZW5lcmd5IiksaGFzVW5pPXBhcnNlZC5zb21lKHg9PngudHlwZT09PSJ1bml0b3dlci1lbmVyZ3kiKTsKICAgICAgaWYoaGFzQXJvIT09aGFzVW5pKXRocm93IEVycm9yKCJUw6RnbGljaGUgRW5lcmdpZXdlcnRlIG51ciBtaXQgYXJvVEhFUk0gdW5kIHVuaVRPV0VSIGdlbWVpbnNhbSBpbXBvcnRpZXJlbi4iKTsKICAgICAgY29uc3QgZGFpbHk9aGFzQXJvJiZoYXNVbmk/YnVpbGRWYWlsbGFudEltcG9ydFByZXZpZXcocGFyc2VkKTp7bW9udGhzOltdfTsKICAgICAgY29uc3QgbWFwPW5ldyBNYXAobW9udGhseVZhaWxsYW50SW1wb3J0cyhwYXJzZWQpLm1hcCh4PT5beC5tb250aCx4XSkpOwogICAgICBmb3IoY29uc3Qgcm93IG9mIGRhaWx5Lm1vbnRocy5maWx0ZXIoeD0+IXguYmxvY2tlZCkpbWFwLnNldChyb3cubW9udGgscm93KTsKICAgICAgY29uc3QgbW9udGhzPVsuLi5tYXAudmFsdWVzKCldLHRlbXA9Y2xpbWF0ZVByZXZpZXcocGFyc2VkKTsKICAgICAgaWYoIW1vbnRocy5sZW5ndGgmJiF0ZW1wLmxlbmd0aCl0aHJvdyBFcnJvcigiS2VpbmUgaW1wb3J0aWVyYmFyZW4gRW5lcmdpZXdlcnRlIG9kZXIgVGVtcGVyYXR1cmRhdGVpZW4gZXJrYW5udC4iKTsKICAgICAgY29uc3Qgc2tpcHBlZD1kYWlseS5tb250aHMuZmlsdGVyKHg9PnguYmxvY2tlZCkubGVuZ3RoOwogICAgICBpZighY29uZmlybShtb250aHMubGVuZ3RoKyIgRW5lcmdpZW1vbmF0ZSB1bmQgIit0ZW1wLmxlbmd0aCsiIFRlbXBlcmF0dXJtb25hdGUgw7xiZXJuZWhtZW4/ICIrKHNraXBwZWQ/c2tpcHBlZCsiIEVuZXJnaWUtTW9uYXRlIHdlcmRlbiB3ZWdlbiB1bnZvbGxzdMOkbmRpZ2VyIG9kZXIgd2lkZXJzcHLDvGNobGljaGVyIERhdGVuIMO8YmVyc3BydW5nZW4uICI6IiIpKyJaw6RobGVyc3TDpG5kZSwgT3N0cm9tLVByZWlzZSB1bmQgTm90aXplbiBibGVpYmVuIHVudmVyw6RuZGVydC4iKSlyZXR1cm47CiAgICAgIGlmKG1vbnRocy5sZW5ndGgpbWVyZ2VWYWlsbGFudEltcG9ydChtb250aHMpOwogICAgICBpZih0ZW1wLmxlbmd0aCljbGltYXRlSW1wb3J0KHRlbXApOwogICAgICByZW5kZXJBbGwoKTsKICAgICAgc2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsbW9udGhzLmxlbmd0aCsiIEVuZXJnaWUtTW9uYXRlIHVuZCAiK3RlbXAubGVuZ3RoKyIgVGVtcGVyYXR1ci1Nb25hdGUgaW1wb3J0aWVydCIsIm9rIik7CiAgICAgIHRvYXN0KCJWYWlsbGFudC1EYXRlbiBpbXBvcnRpZXJ0Iik7CiAgICB9Y2F0Y2goZXJyb3Ipe3NldFN0YXR1cygidmFpbGxhbnRJbXBvcnRTdGF0dXMiLGVycm9yLm1lc3NhZ2UsImVycm9yIik7fQogICAgZmluYWxseXskKCJ2YWlsbGFudENzdkZpbGVzSW5wdXQiKS52YWx1ZT0iIjt9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBvc3Ryb21GZXRjaChwYXRoKXsKICAgIGlmKCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpdGhyb3cgbmV3IEVycm9yKCJBcHAtU2NobMO8c3NlbCBmZWhsdC4iKTsKICAgIGNvbnN0IHJlc3BvbnNlPWF3YWl0IGZldGNoKHBhdGgse2hlYWRlcnM6eyJ4LWVsZGVob2Yta2V5IjpzZXR0aW5ncy5vc3Ryb21BcHBLZXksImFjY2VwdCI6ImFwcGxpY2F0aW9uL2pzb24ifSxjYWNoZToibm8tc3RvcmUifSk7IGNvbnN0IHRleHQ9YXdhaXQgcmVzcG9uc2UudGV4dCgpOyBsZXQgcGF5bG9hZD17fTsgdHJ5e3BheWxvYWQ9dGV4dD9KU09OLnBhcnNlKHRleHQpOnt9O31jYXRjaHt9CiAgICBpZighcmVzcG9uc2Uub2spdGhyb3cgbmV3IEVycm9yKHBheWxvYWQuZXJyb3J8fHBheWxvYWQubWVzc2FnZXx8dGV4dHx8YEZlaGxlciAke3Jlc3BvbnNlLnN0YXR1c31gKTsgcmV0dXJuIHBheWxvYWQ7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hPc3Ryb20oc2hvd1RvYXN0PWZhbHNlKXsKICAgIGlmKG9zdHJvbUJ1c3l8fCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe3JlbmRlck9zdHJvbURhc2hib2FyZCgpO3JldHVybiBmYWxzZTt9CiAgICBvc3Ryb21CdXN5PXRydWU7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7CiAgICB0cnl7IGNvbnN0IHBheWxvYWQ9YXdhaXQgb3N0cm9tRmV0Y2goYC9hcGkvbGl2ZSR7c2hvd1RvYXN0PyI/cmVmcmVzaD0xIjoiIn1gKTsgc2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQpOyBpZihzaG93VG9hc3QpdG9hc3QoIk9zdHJvbSBha3R1YWxpc2llcnQiKTsgcmV0dXJuIHRydWU7IH0KICAgIGNhdGNoKGVycm9yKXsgc2V0T3N0cm9tU3RhdHVzKGBGZWhsZXI6ICR7ZXJyb3IubWVzc2FnZX1gLCJlcnJvciIpOyBpZihzaG93VG9hc3QpdG9hc3QoYE9zdHJvbTogJHtlcnJvci5tZXNzYWdlfWApOyByZXR1cm4gZmFsc2U7IH0KICAgIGZpbmFsbHl7b3N0cm9tQnVzeT1mYWxzZTtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTt9CiAgfQogIGZ1bmN0aW9uIHNjaGVkdWxlT3N0cm9tKCl7IGNsZWFySW50ZXJ2YWwob3N0cm9tVGltZXIpO29zdHJvbVRpbWVyPW51bGw7IGlmKHNldHRpbmdzLm9zdHJvbUFwcEtleSYmc2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2ghPT1mYWxzZSlvc3Ryb21UaW1lcj1zZXRJbnRlcnZhbCgoKT0+cmVmcmVzaE9zdHJvbShmYWxzZSksMTAqNjAqMTAwMCk7IH0KICBmdW5jdGlvbiBzZXRPc3Ryb21TdGF0dXModGV4dCxraW5kPSIiKXsgY29uc3QgZWw9JCgib3N0cm9tU3RhdHVzIik7ZWwudGV4dENvbnRlbnQ9dGV4dDtlbC5zdHlsZS5jb2xvcj1raW5kPT09ImVycm9yIj8iI2ZmYWFhOSI6IiI7IH0KICBmdW5jdGlvbiBmb3JtYXREYXRlVGltZSh2YWx1ZSl7IGNvbnN0IGQ9bmV3IERhdGUodmFsdWUpOyBpZihOdW1iZXIuaXNOYU4oZC52YWx1ZU9mKCkpKXJldHVybiAi4oCTIjsgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse3dlZWtkYXk6InNob3J0IixkYXk6IjItZGlnaXQiLG1vbnRoOiIyLWRpZ2l0Iixob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KGQpOyB9CiAgZnVuY3Rpb24gaW50ZXJ2YWxSb3dzKCl7IHJldHVybiAoQXJyYXkuaXNBcnJheShvc3Ryb21MaXZlPy5wcmljZUZvcmVjYXN0KT9vc3Ryb21MaXZlLnByaWNlRm9yZWNhc3Q6W10pLm1hcChwPT4oe3RpbWU6bmV3IERhdGUocC5kYXRlfHxwLnN0YXJ0fHxwLnRpbWVzdGFtcCkuZ2V0VGltZSgpLHByaWNlOk51bWJlcihwLnRvdGFsQ3RQZXJLV2g/P3AucHJpY2VDdFBlcktXaD8/cC5wcmljZSl9KSkuZmlsdGVyKHA9Pk51bWJlci5pc0Zpbml0ZShwLnRpbWUpJiZOdW1iZXIuaXNGaW5pdGUocC5wcmljZSkpLnNvcnQoKGEsYik9PmEudGltZS1iLnRpbWUpOyB9CiAgZnVuY3Rpb24gaW5mZXJTdGVwKHJvd3MpeyBjb25zdCBkaWZmcz1bXTtmb3IobGV0IGk9MTtpPHJvd3MubGVuZ3RoO2krKyl7Y29uc3QgZD1yb3dzW2ldLnRpbWUtcm93c1tpLTFdLnRpbWU7aWYoZD49NSo2MGUzJiZkPD0yKjM2MDBlMylkaWZmcy5wdXNoKGQpO30gaWYoIWRpZmZzLmxlbmd0aClyZXR1cm4gMzYwMGUzO2RpZmZzLnNvcnQoKGEsYik9PmEtYik7cmV0dXJuIGRpZmZzW01hdGguZmxvb3IoZGlmZnMubGVuZ3RoLzIpXTsgfQogIGZ1bmN0aW9uIGNvbXB1dGVQcmljZVdpbmRvdyhyb3dzLGhvdXJzLG1vZGUpewogICAgaWYoIXJvd3MubGVuZ3RoKXJldHVybiBudWxsOyBjb25zdCBzdGVwPWluZmVyU3RlcChyb3dzKTsgY29uc3QgY291bnQ9TWF0aC5tYXgoMSxNYXRoLnJvdW5kKGhvdXJzKjM2MDBlMy9zdGVwKSk7IGNvbnN0IG5vdz1EYXRlLm5vdygpOyBjb25zdCBwb29sPXJvd3MuZmlsdGVyKHI9PnIudGltZT49bm93LXN0ZXApLnNsaWNlKDAsTWF0aC5tYXgoY291bnQsTWF0aC5yb3VuZCg0OCozNjAwZTMvc3RlcCkpKTsKICAgIGxldCBiZXN0PW51bGw7CiAgICBmb3IobGV0IGk9MDtpK2NvdW50PD1wb29sLmxlbmd0aDtpKyspe2NvbnN0IHNsaWNlPXBvb2wuc2xpY2UoaSxpK2NvdW50KTtsZXQgY29udGlndW91cz10cnVlO2ZvcihsZXQgaj0xO2o8c2xpY2UubGVuZ3RoO2orKylpZihzbGljZVtqXS50aW1lLXNsaWNlW2otMV0udGltZT5zdGVwKjEuNil7Y29udGlndW91cz1mYWxzZTticmVhazt9aWYoIWNvbnRpZ3VvdXMpY29udGludWU7Y29uc3QgYXZnPXNsaWNlLnJlZHVjZSgocyxyKT0+cytyLnByaWNlLDApL3NsaWNlLmxlbmd0aDtjb25zdCBjYW5kaWRhdGU9e3N0YXJ0OnNsaWNlWzBdLnRpbWUsZW5kOnNsaWNlLmF0KC0xKS50aW1lK3N0ZXAsYXZnfTtpZighYmVzdHx8KG1vZGU9PT0ibWluIj9hdmc8YmVzdC5hdmc6YXZnPmJlc3QuYXZnKSliZXN0PWNhbmRpZGF0ZTt9CiAgICByZXR1cm4gYmVzdDsKICB9CiAgZnVuY3Rpb24gcmVuZGVyT3N0cm9tRGFzaGJvYXJkKCl7CiAgICBjb25zdCBjYW5SZWZyZXNoPUJvb2xlYW4oc2V0dGluZ3Mub3N0cm9tQXBwS2V5KTsKICAgIGNvbnN0IGhhc1N5bmNlZERhdGE9Qm9vbGVhbihvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdCk7CiAgICBjb25zdCB2aXNpYmxlPWNhblJlZnJlc2h8fGhhc1N5bmNlZERhdGE7CiAgICAkKCJvc3Ryb21TZXR1cEhpbnQiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHZpc2libGUpOwogICAgJCgib3N0cm9tRGFzaGJvYXJkIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhdmlzaWJsZSk7CiAgICAkKCJvc3Ryb21NaW5pQ2hhcnQiKS5wYXJlbnRFbGVtZW50LmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIXZpc2libGUpOwogICAgJCgicmVmcmVzaE9zdHJvbUJ0biIpLmRpc2FibGVkPSFjYW5SZWZyZXNofHxvc3Ryb21CdXN5OwogICAgaWYoIXZpc2libGUpeyBzZXRPc3Ryb21TdGF0dXMoIk5pY2h0IHZlcmJ1bmRlbiIpOyByZXR1cm47IH0KICAgIGlmKG9zdHJvbUJ1c3kpc2V0T3N0cm9tU3RhdHVzKCJBa3R1YWxpc2llcnVuZyBsw6R1ZnQg4oCmIik7CiAgICBlbHNlIGlmKGhhc1N5bmNlZERhdGEmJiFjYW5SZWZyZXNoKXNldE9zdHJvbVN0YXR1cyhgVm9tIGFuZGVyZW4gR2Vyw6R0IHN5bmNocm9uaXNpZXJ0IMK3ICR7Zm9ybWF0RGF0ZVRpbWUob3N0cm9tTGl2ZS5nZW5lcmF0ZWRBdCl9YCk7CiAgICBlbHNlIGlmKGhhc1N5bmNlZERhdGEpc2V0T3N0cm9tU3RhdHVzKGBBa3R1YWxpc2llcnQgJHtmb3JtYXREYXRlVGltZShvc3Ryb21MaXZlLmdlbmVyYXRlZEF0KX1gKTsKICAgIGVsc2Ugc2V0T3N0cm9tU3RhdHVzKCJOb2NoIGtlaW5lIExpdmUtRGF0ZW4iKTsKICAgIGNvbnN0IHJvd3M9aW50ZXJ2YWxSb3dzKCk7IGlmKCFyb3dzLmxlbmd0aCl7IFsib3N0cm9tQ3VycmVudFByaWNlIiwib3N0cm9tQmVzdFByaWNlIiwib3N0cm9tV29yc3RQcmljZSJdLmZvckVhY2goaWQ9PiQoaWQpLnRleHRDb250ZW50PSLigJMiKTsgWyJvc3Ryb21DdXJyZW50TWV0YSIsIm9zdHJvbUJlc3RNZXRhIiwib3N0cm9tV29yc3RNZXRhIl0uZm9yRWFjaChpZD0+JChpZCkudGV4dENvbnRlbnQ9Ik5vY2gga2VpbmUgUHJlaXN2b3JzY2hhdSIpOyBkcmF3T3N0cm9tTWluaShbXSk7IHJldHVybjsgfQogICAgY29uc3Qgbm93PURhdGUubm93KCksc3RlcD1pbmZlclN0ZXAocm93cyk7IGNvbnN0IGN1cnJlbnQ9cm93cy5maW5kKChyLGkpPT5yLnRpbWU8PW5vdyYmKHJvd3NbaSsxXT8udGltZT8/ci50aW1lK3N0ZXApPm5vdyl8fHJvd3MuZmluZChyPT5yLnRpbWU+bm93KXx8cm93cy5hdCgtMSk7IGNvbnN0IGhvdXJzPU51bWJlcihzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vycyl8fDM7IGNvbnN0IGJlc3Q9Y29tcHV0ZVByaWNlV2luZG93KHJvd3MsaG91cnMsIm1pbiIpLCB3b3JzdD1jb21wdXRlUHJpY2VXaW5kb3cocm93cyxob3VycywibWF4Iik7CiAgICAkKCJvc3Ryb21CZXN0TGFiZWwiKS50ZXh0Q29udGVudD1gQmVzdGVzICR7aG91cnN9aC1GZW5zdGVyYDsgJCgib3N0cm9tV29yc3RMYWJlbCIpLnRleHRDb250ZW50PWBTY2hsZWNodGVzdGVzICR7aG91cnN9aC1GZW5zdGVyYDsKICAgICQoIm9zdHJvbUN1cnJlbnRQcmljZSIpLnRleHRDb250ZW50PWAke251bShjdXJyZW50Py5wcmljZSwyKX0gY3Qva1doYDsgJCgib3N0cm9tQ3VycmVudE1ldGEiKS50ZXh0Q29udGVudD1jdXJyZW50P2Zvcm1hdERhdGVUaW1lKGN1cnJlbnQudGltZSk6IuKAkyI7CiAgICAkKCJvc3Ryb21CZXN0UHJpY2UiKS50ZXh0Q29udGVudD1iZXN0P2Ake251bShiZXN0LmF2ZywyKX0gY3Qva1doYDoi4oCTIjsgJCgib3N0cm9tQmVzdE1ldGEiKS50ZXh0Q29udGVudD1iZXN0P2Ake2Zvcm1hdERhdGVUaW1lKGJlc3Quc3RhcnQpfSDigJMgJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKGJlc3QuZW5kKSl9YDoi4oCTIjsKICAgICQoIm9zdHJvbVdvcnN0UHJpY2UiKS50ZXh0Q29udGVudD13b3JzdD9gJHtudW0od29yc3QuYXZnLDIpfSBjdC9rV2hgOiLigJMiOyAkKCJvc3Ryb21Xb3JzdE1ldGEiKS50ZXh0Q29udGVudD13b3JzdD9gJHtmb3JtYXREYXRlVGltZSh3b3JzdC5zdGFydCl9IOKAkyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUod29yc3QuZW5kKSl9YDoi4oCTIjsKICAgIGRyYXdPc3Ryb21NaW5pKHJvd3MuZmlsdGVyKHI9PnIudGltZT49bm93LXN0ZXApLnNsaWNlKDAsNDgpKTsKICB9CiAgZnVuY3Rpb24gZHJhd09zdHJvbU1pbmkocm93cyl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoIm9zdHJvbU1pbmlDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgaWYoIXJvd3MubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCwiS2VpbmUgT3N0cm9tLVByZWlzZGF0ZW4iKTtyZXR1cm47fSBjb25zdCBtaW49TWF0aC5taW4oLi4ucm93cy5tYXAocj0+ci5wcmljZSkpLG1heD1NYXRoLm1heCguLi5yb3dzLm1hcChyPT5yLnByaWNlKSksc3Bhbj1NYXRoLm1heCgxLG1heC1taW4pOyBjb25zdCBwYWQ9e2w6NDMscjo4LHQ6MTIsYjozMH0sdz13aWR0aC1wYWQubC1wYWQucixoPWhlaWdodC1wYWQudC1wYWQuYjsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuZ3JpZDtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5mb250PSIxMHB4IHNhbnMtc2VyaWYiO2ZvcihsZXQgaT0wO2k8PTM7aSsrKXtjb25zdCB5PXBhZC50K2gqaS8zO2N0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKHBhZC5sLHkpO2N0eC5saW5lVG8od2lkdGgtcGFkLnIseSk7Y3R4LnN0cm9rZSgpO2N0eC5maWxsVGV4dChudW0obWF4LXNwYW4qaS8zLDApLDQseSszKTt9IGN0eC5zdHJva2VTdHlsZT1DT0xPUlMudG90YWw7Y3R4LmxpbmVXaWR0aD0yO2N0eC5iZWdpblBhdGgoKTtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PXBhZC5sKyhyb3dzLmxlbmd0aD09PTE/dy8yOncqaS8ocm93cy5sZW5ndGgtMSkpLHk9cGFkLnQraCooMS0oci5wcmljZS1taW4pL3NwYW4pO2k/Y3R4LmxpbmVUbyh4LHkpOmN0eC5tb3ZlVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgICBjb25zdCBzdGVwPU1hdGgubWF4KDEsTWF0aC5mbG9vcihyb3dzLmxlbmd0aC81KSk7IHJvd3MuZm9yRWFjaCgocixpKT0+e2lmKGklc3RlcCYmaSE9PXJvd3MubGVuZ3RoLTEpcmV0dXJuO2NvbnN0IHg9cGFkLmwrKHJvd3MubGVuZ3RoPT09MT93LzI6dyppLyhyb3dzLmxlbmd0aC0xKSk7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZmlsbFRleHQobmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUoci50aW1lKSkseC04LGhlaWdodC05KTt9KTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUFuZENoZWNrT3N0cm9tKCl7CiAgICBjb25zdCBrZXk9JCgib3N0cm9tQXBwS2V5SW5wdXQiKS52YWx1ZS50cmltKCk7IHNldHRpbmdzLm9zdHJvbUFwcEtleT1rZXk7IHNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoPSQoIm9zdHJvbUF1dG9SZWZyZXNoSW5wdXQiKS5jaGVja2VkOyBzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vycz1OdW1iZXIoJCgicHJlZmVycmVkV2luZG93SG91cnNJbnB1dCIpLnZhbHVlKXx8Mzsgc2F2ZVNldHRpbmdzKCk7CiAgICBpZigha2V5KXtzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJCaXR0ZSBBcHAtU2NobMO8c3NlbCBlaW50cmFnZW4uIiwiZXJyb3IiKTtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTtyZXR1cm47fQogICAgc2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiVmVyYmluZHVuZyB3aXJkIGdlcHLDvGZ0IOKApiIpOwogICAgdHJ5eyBjb25zdCBoZWFsdGg9YXdhaXQgb3N0cm9tRmV0Y2goIi9hcGkvaGVhbHRoP2RlZXA9dG9rZW4iKTsgaWYoIWhlYWx0aC5jb25maWd1cmVkKXRocm93IG5ldyBFcnJvcigiQ2xvdWRmbGFyZS1TZWNyZXRzIHNpbmQgbmljaHQgdm9sbHN0w6RuZGlnIGVpbmdlcmljaHRldC4iKTsgc2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiT3N0cm9tLVZlcmJpbmR1bmcgZXJmb2xncmVpY2guIiwib2siKTsgYXdhaXQgcmVmcmVzaE9zdHJvbSh0cnVlKTsgc2NoZWR1bGVPc3Ryb20oKTsgcmVuZGVyQWxsKCk7IH0KICAgIGNhdGNoKGVycm9yKXtzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLGVycm9yLm1lc3NhZ2UsImVycm9yIik7fQogIH0KICBmdW5jdGlvbiBkaXNjb25uZWN0T3N0cm9tKCl7IGlmKHNldHRpbmdzLm9zdHJvbUFwcEtleSYmIWNvbmZpcm0oIk9zdHJvbS1WZXJiaW5kdW5nIHdpcmtsaWNoIGVudGZlcm5lbj8iKSlyZXR1cm47IHNldHRpbmdzLm9zdHJvbUFwcEtleT0iIjtzYXZlU2V0dGluZ3MoKTtzYXZlT3N0cm9tQ2FjaGUobnVsbCk7bG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oT1NUUk9NX0NPTlRST0xfS0VZKTtzY2hlZHVsZU9zdHJvbSgpO3JlbmRlckFsbCgpO3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIlZlcmJpbmR1bmcgZW50ZmVybnQuIik7dG9hc3QoIk9zdHJvbSBnZXRyZW5udCIpOyB9CgoKICBhc3luYyBmdW5jdGlvbiByZWZyZXNoT3N0cm9tSGlzdG9yeSh7c2lsZW50PWZhbHNlLG9ubHlNaXNzaW5nPWZhbHNlLG1heE1vbnRocz1JbmZpbml0eX09e30pewogICAgaWYob3N0cm9tSGlzdG9yeUJ1c3kpcmV0dXJuOwogICAgaWYoIXNldHRpbmdzLm9zdHJvbUFwcEtleSl7aWYoIXNpbGVudCl0b2FzdCgiT3N0cm9tIHp1ZXJzdCB2ZXJiaW5kZW4iKTtyZXR1cm47fQogICAgY29uc3QgZWxpZ2libGU9c29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSYmci5tb250aDxjdXJyZW50TW9udGhLZXkoKSkuZmlsdGVyKHI9PiFvbmx5TWlzc2luZ3x8IXIub3N0cm9tUHJpY2VDb21wbGV0ZSk7CiAgICBpZighZWxpZ2libGUubGVuZ3RoKXtpZighc2lsZW50KXRvYXN0KCJQcmVpc2hpc3RvcmllIGlzdCBiZXJlaXRzIHZvbGxzdMOkbmRpZyIpO3JldHVybjt9CiAgICBvc3Ryb21IaXN0b3J5QnVzeT10cnVlO3JlbmRlckRhdGEoKTsKICAgIGxldCB1cGRhdGVkPTAsdW5hdmFpbGFibGU9MCxwcm9jZXNzZWQ9MDsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKHJlY29yZHMubWFwKHI9PltyLm1vbnRoLHsuLi5yfV0pKTsKICAgIHRyeXsKICAgICAgZm9yKGNvbnN0IHIgb2YgZWxpZ2libGUuc2xpY2UoLU1hdGgubWF4KDEsTnVtYmVyKG1heE1vbnRocyl8fGVsaWdpYmxlLmxlbmd0aCkpKXsKICAgICAgICBwcm9jZXNzZWQrKzsKICAgICAgICBpZighc2lsZW50KXNldFN0YXR1cygib3N0cm9tSGlzdG9yeVN0YXR1cyIsYCR7bW9udGhMYWJlbChyLm1vbnRoLGZhbHNlKX0gd2lyZCB2b24gT3N0cm9tIGdlbGFkZW4g4oCmICgke3Byb2Nlc3NlZH0vJHtNYXRoLm1pbihlbGlnaWJsZS5sZW5ndGgsbWF4TW9udGhzKX0pYCk7CiAgICAgICAgdHJ5ewogICAgICAgICAgY29uc3QgZGF0YT1hd2FpdCBvc3Ryb21GZXRjaChgL2FwaS9tb250aD9tb250aD0ke2VuY29kZVVSSUNvbXBvbmVudChyLm1vbnRoKX1gKTsKICAgICAgICAgIGlmKCFkYXRhPy5jb21wbGV0ZXx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLnRvdGFsQ29zdEV1cikpKXt1bmF2YWlsYWJsZSsrO2NvbnRpbnVlO30KICAgICAgICAgIGNvbnN0IGl0ZW09bWFwLmdldChyLm1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRoOnIubW9udGh9KTsKICAgICAgICAgIGNvbnN0IHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgICAgICAgIGl0ZW0ucHJpY2VDdD1OdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCk7CiAgICAgICAgICBpdGVtLmJhc2VGZWU9TnVtYmVyKGRhdGEuZml4ZWRDb3N0RXVyKXx8MDsKICAgICAgICAgIGl0ZW0ub3N0cm9tVmFyaWFibGVDb3N0RXVyPU51bWJlcihkYXRhLnZhcmlhYmxlQ29zdEV1cik7CiAgICAgICAgICBpdGVtLm9zdHJvbVRvdGFsQ29zdEV1cj1OdW1iZXIoZGF0YS50b3RhbENvc3RFdXIpOwogICAgICAgICAgaXRlbS5vc3Ryb21Db25zdW1wdGlvbktXaD1OdW1iZXIoZGF0YS50b3RhbEtXaCk7CiAgICAgICAgICBpdGVtLm9zdHJvbVByaWNlQ29tcGxldGU9dHJ1ZTsKICAgICAgICAgIGl0ZW0ucHJpY2VTb3VyY2U9Im9zdHJvbS1ob3VybHktY29uc3VtcHRpb24td2VpZ2h0ZWQiOwogICAgICAgICAgaXRlbS5wcmljZVVwZGF0ZWRBdD1zdGFtcDsKICAgICAgICAgIGl0ZW0udXBkYXRlZEF0PXN0YW1wOwogICAgICAgICAgbWFwLnNldChyLm1vbnRoLGl0ZW0pO3Vwc2VydE9zdHJvbVByaWNlU3RhdChyLm1vbnRoLGRhdGEse3BhcnRpYWw6ZmFsc2V9KTt1cGRhdGVkKys7CiAgICAgICAgfWNhdGNoKGVycm9yKXt1bmF2YWlsYWJsZSsrO30KICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlPT5zZXRUaW1lb3V0KHJlc29sdmUsMTQwKSk7CiAgICAgIH0KICAgICAgaWYodXBkYXRlZClzYXZlUmVjb3JkcyhbLi4ubWFwLnZhbHVlcygpXSx7cmVhc29uOiJPc3Ryb20tU3R1bmRlbnByZWlzZSBha3R1YWxpc2llcnQifSk7CiAgICAgIGNvbnN0IHN0YXR1cz17dXBkYXRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSx1cGRhdGVkLHVuYXZhaWxhYmxlfTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShPU1RST01fSElTVE9SWV9LRVksSlNPTi5zdHJpbmdpZnkoc3RhdHVzKSk7CiAgICAgIHJlbmRlckFsbCgpOwogICAgICBpZighc2lsZW50KXRvYXN0KGAke3VwZGF0ZWR9IE1vbmF0KGUpIG1pdCBPc3Ryb20tU3R1bmRlbnByZWlzZW4gYWt0dWFsaXNpZXJ0JHt1bmF2YWlsYWJsZT9gIMK3ICR7dW5hdmFpbGFibGV9IG5pY2h0IHZlcmbDvGdiYXJgOiIifWApOwogICAgfWZpbmFsbHl7b3N0cm9tSGlzdG9yeUJ1c3k9ZmFsc2U7cmVuZGVyRGF0YSgpO30KICB9CgogIGZ1bmN0aW9uIHN5bmNSYW5kb21CeXRlcyhsZW5ndGg9MzIpe2NvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KGxlbmd0aCk7Y3J5cHRvLmdldFJhbmRvbVZhbHVlcyhieXRlcyk7cmV0dXJuIGJ5dGVzO30KICBmdW5jdGlvbiBzeW5jQnl0ZXNUb0Jhc2U2NFVybChieXRlcyl7bGV0IGJpbmFyeT0iIjtmb3IobGV0IGk9MDtpPGJ5dGVzLmxlbmd0aDtpKz04MTkyKWJpbmFyeSs9U3RyaW5nLmZyb21DaGFyQ29kZSguLi5ieXRlcy5zdWJhcnJheShpLGkrODE5MikpO3JldHVybiBidG9hKGJpbmFyeSkucmVwbGFjZUFsbCgiKyIsIi0iKS5yZXBsYWNlQWxsKCIvIiwiXyIpLnJlcGxhY2UoLz0rJC9nLCIiKTt9CiAgZnVuY3Rpb24gc3luY0Jhc2U2NFVybFRvQnl0ZXModmFsdWUpe2NvbnN0IHJhdz1TdHJpbmcodmFsdWV8fCIiKS5yZXBsYWNlQWxsKCItIiwiKyIpLnJlcGxhY2VBbGwoIl8iLCIvIik7Y29uc3QgcGFkZGVkPXJhdysiPSIucmVwZWF0KCg0LXJhdy5sZW5ndGglNCklNCk7Y29uc3QgYmluYXJ5PWF0b2IocGFkZGVkKTtjb25zdCBieXRlcz1uZXcgVWludDhBcnJheShiaW5hcnkubGVuZ3RoKTtmb3IobGV0IGk9MDtpPGJpbmFyeS5sZW5ndGg7aSsrKWJ5dGVzW2ldPWJpbmFyeS5jaGFyQ29kZUF0KGkpO3JldHVybiBieXRlczt9CiAgZnVuY3Rpb24gc3luY1JlY292ZXJ5Tm9ybWFsaXplKHZhbHVlKXtyZXR1cm4gU3RyaW5nKHZhbHVlfHwiIikudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXjAtOWEtZl0vZywiIik7fQogIGZ1bmN0aW9uIHN5bmNSZWNvdmVyeUZvcm1hdCh2YWx1ZSl7Y29uc3QgcmF3PXN5bmNSZWNvdmVyeU5vcm1hbGl6ZSh2YWx1ZSkudG9VcHBlckNhc2UoKTtyZXR1cm4gcmF3Lm1hdGNoKC8uezEsNH0vZyk/LmpvaW4oIi0iKXx8IiI7fQogIGZ1bmN0aW9uIHN5bmNHZW5lcmF0ZVJlY292ZXJ5S2V5KCl7cmV0dXJuIFsuLi5zeW5jUmFuZG9tQnl0ZXMoMzIpXS5tYXAoYj0+Yi50b1N0cmluZygxNikucGFkU3RhcnQoMiwiMCIpKS5qb2luKCIiKTt9CiAgZnVuY3Rpb24gc3luY0dlbmVyYXRlSWQocHJlZml4LGJ5dGVzPTE2KXtyZXR1cm4gYCR7cHJlZml4fS0ke3N5bmNCeXRlc1RvQmFzZTY0VXJsKHN5bmNSYW5kb21CeXRlcyhieXRlcykpfWA7fQogIGZ1bmN0aW9uIGxvYWRTeW5jU3RhdGUoKXsKICAgIGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNZTkNfU1RBVEVfS0VZKSx7fSk7CiAgICByZXR1cm4ge2NvbmZpZ3VyZWQ6Qm9vbGVhbihyYXc/LmNvbmZpZ3VyZWQpLHZhdWx0SWQ6U3RyaW5nKHJhdz8udmF1bHRJZHx8IiIpLGRldmljZUlkOlN0cmluZyhyYXc/LmRldmljZUlkfHwiIiksZGV2aWNlTmFtZTpTdHJpbmcocmF3Py5kZXZpY2VOYW1lfHwiIiksZGV2aWNlVG9rZW46U3RyaW5nKHJhdz8uZGV2aWNlVG9rZW58fCIiKSxyZWNvdmVyeUtleTooKCk9Pntjb25zdCBjdXJyZW50PXN5bmNSZWNvdmVyeU5vcm1hbGl6ZShyYXc/LnJlY292ZXJ5S2V5fHwiIik7Y29uc3QgbGVnYWN5PXN5bmNSZWNvdmVyeU5vcm1hbGl6ZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTWU5DX1NFQ1JFVF9MRUdBQ1lfS0VZKXx8IiIpO3JldHVybiBjdXJyZW50Lmxlbmd0aD09PTY0P2N1cnJlbnQ6bGVnYWN5Lmxlbmd0aD09PTY0P2xlZ2FjeTpjdXJyZW50O30pKCkscm9sZTpyYXc/LnJvbGU9PT0iYWRtaW4iPyJhZG1pbiI6Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOk1hdGgubWF4KDAsTnVtYmVyKHJhdz8uc2VydmVyUmV2aXNpb24/P3Jhdz8ucmV2aXNpb24pfHwwKSxsYXN0U3luY0F0OlN0cmluZyhyYXc/Lmxhc3RTeW5jQXR8fCIiKSxsYXN0RXJyb3I6U3RyaW5nKHJhdz8ubGFzdEVycm9yfHwiIil9OwogIH0KICBmdW5jdGlvbiBzYXZlU3luY1N0YXRlKCl7bG9jYWxTdG9yYWdlLnNldEl0ZW0oU1lOQ19TVEFURV9LRVksSlNPTi5zdHJpbmdpZnkoc3luY1N0YXRlKSk7fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNEZXJpdmVLZXkocmVjb3ZlcnlLZXksdmF1bHRJZCl7CiAgICBjb25zdCByYXc9c3luY1JlY292ZXJ5Tm9ybWFsaXplKHJlY292ZXJ5S2V5KTtpZihyYXcubGVuZ3RoIT09NjQpdGhyb3cgbmV3IEVycm9yKCJXaWVkZXJoZXJzdGVsbHVuZ3NzY2hsw7xzc2VsIGlzdCB1bnZvbGxzdMOkbmRpZy4iKTsKICAgIGNvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KHJhdy5tYXRjaCgvLnsyfS9nKS5tYXAodj0+cGFyc2VJbnQodiwxNikpKTtjb25zdCBiYXNlPWF3YWl0IGNyeXB0by5zdWJ0bGUuaW1wb3J0S2V5KCJyYXciLGJ5dGVzLCJIS0RGIixmYWxzZSxbImRlcml2ZUtleSJdKTsKICAgIHJldHVybiBjcnlwdG8uc3VidGxlLmRlcml2ZUtleSh7bmFtZToiSEtERiIsaGFzaDoiU0hBLTI1NiIsc2FsdDpuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodmF1bHRJZCksaW5mbzpuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoImVsZGVob2YtcHJpdmF0ZS1zeW5jLXYxIil9LGJhc2Use25hbWU6IkFFUy1HQ00iLGxlbmd0aDoyNTZ9LGZhbHNlLFsiZW5jcnlwdCIsImRlY3J5cHQiXSk7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNFbmNyeXB0KHBheWxvYWQpe2NvbnN0IGtleT1hd2FpdCBzeW5jRGVyaXZlS2V5KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSxzeW5jU3RhdGUudmF1bHRJZCk7Y29uc3QgaXY9c3luY1JhbmRvbUJ5dGVzKDEyKTtjb25zdCBhYWQ9bmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGAke1NZTkNfRU5WRUxPUEVfU0NIRU1BfToke3N5bmNTdGF0ZS52YXVsdElkfWApO2NvbnN0IHBsYWluPW5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7Y29uc3QgZW5jcnlwdGVkPWF3YWl0IGNyeXB0by5zdWJ0bGUuZW5jcnlwdCh7bmFtZToiQUVTLUdDTSIsaXYsYWRkaXRpb25hbERhdGE6YWFkLHRhZ0xlbmd0aDoxMjh9LGtleSxwbGFpbik7cmV0dXJuIHtzY2hlbWE6U1lOQ19FTlZFTE9QRV9TQ0hFTUEsYWxnb3JpdGhtOiJBRVMtR0NNLTI1Ni9IS0RGLVNIQS0yNTYiLGl2OnN5bmNCeXRlc1RvQmFzZTY0VXJsKGl2KSxjaXBoZXJ0ZXh0OnN5bmNCeXRlc1RvQmFzZTY0VXJsKG5ldyBVaW50OEFycmF5KGVuY3J5cHRlZCkpLHNjb3BlOiJmdWxsIixjcmVhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHBheWxvYWRCdWlsZDpBUFBfQlVJTER9O30KICBhc3luYyBmdW5jdGlvbiBzeW5jRGVjcnlwdChlbnZlbG9wZSl7aWYoZW52ZWxvcGU/LnNjaGVtYSE9PVNZTkNfRU5WRUxPUEVfU0NIRU1BKXRocm93IG5ldyBFcnJvcigiVW5iZWthbm50ZXMgU3luYy1QYWtldC4iKTtjb25zdCBrZXk9YXdhaXQgc3luY0Rlcml2ZUtleShzeW5jU3RhdGUucmVjb3ZlcnlLZXksc3luY1N0YXRlLnZhdWx0SWQpO2NvbnN0IGFhZD1uZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoYCR7U1lOQ19FTlZFTE9QRV9TQ0hFTUF9OiR7c3luY1N0YXRlLnZhdWx0SWR9YCk7bGV0IHBsYWluO3RyeXtwbGFpbj1hd2FpdCBjcnlwdG8uc3VidGxlLmRlY3J5cHQoe25hbWU6IkFFUy1HQ00iLGl2OnN5bmNCYXNlNjRVcmxUb0J5dGVzKGVudmVsb3BlLml2KSxhZGRpdGlvbmFsRGF0YTphYWQsdGFnTGVuZ3RoOjEyOH0sa2V5LHN5bmNCYXNlNjRVcmxUb0J5dGVzKGVudmVsb3BlLmNpcGhlcnRleHQpKTt9Y2F0Y2h7dGhyb3cgbmV3IEVycm9yKCJTeW5jLVBha2V0IGtvbm50ZSBuaWNodCBlbnRzY2hsw7xzc2VsdCB3ZXJkZW4uIik7fWNvbnN0IHBheWxvYWQ9SlNPTi5wYXJzZShuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocGxhaW4pKTtpZihwYXlsb2FkPy5zY2hlbWEhPT1TWU5DX1BBWUxPQURfU0NIRU1BKXRocm93IG5ldyBFcnJvcigiU3luYy1QYWtldCBzdGFtbXQgYXVzIGVpbmVyIG5pY2h0IGtvbXBhdGlibGVuIEVsZGVob2YtVmVyc2lvbi4iKTtyZXR1cm4gcGF5bG9hZDt9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0FwaShwYXRoLGJvZHkpe2NvbnN0IHJlc3BvbnNlPWF3YWl0IGZldGNoKGAvYXBpL3N5bmMvJHtwYXRofWAse21ldGhvZDoiUE9TVCIsaGVhZGVyczp7ImNvbnRlbnQtdHlwZSI6ImFwcGxpY2F0aW9uL2pzb24iLCJhY2NlcHQiOiJhcHBsaWNhdGlvbi9qc29uIn0sYm9keTpKU09OLnN0cmluZ2lmeShib2R5KSxjYWNoZToibm8tc3RvcmUifSk7bGV0IHBheWxvYWQ9e307dHJ5e3BheWxvYWQ9YXdhaXQgcmVzcG9uc2UuanNvbigpO31jYXRjaHt9aWYoIXJlc3BvbnNlLm9rKXtjb25zdCBlcnJvcj1uZXcgRXJyb3IocGF5bG9hZC5lcnJvcnx8YFN5bmMtRmVobGVyICR7cmVzcG9uc2Uuc3RhdHVzfWApO2Vycm9yLnN0YXR1cz1yZXNwb25zZS5zdGF0dXM7ZXJyb3IucGF5bG9hZD1wYXlsb2FkO3Rocm93IGVycm9yO31yZXR1cm4gcGF5bG9hZDt9CiAgZnVuY3Rpb24gc3luY0F1dGgoZXh0cmE9e30pe3JldHVybiB7dmF1bHRJZDpzeW5jU3RhdGUudmF1bHRJZCxkZXZpY2VJZDpzeW5jU3RhdGUuZGV2aWNlSWQsZGV2aWNlVG9rZW46c3luY1N0YXRlLmRldmljZVRva2VuLC4uLmV4dHJhfTt9CiAgZnVuY3Rpb24gc3luY0l0ZW1UaW1lKGl0ZW0pe2Zvcihjb25zdCBrZXkgb2YgWyJ1cGRhdGVkQXQiLCJwcmljZVVwZGF0ZWRBdCIsImhlYXRQdW1wVXBkYXRlZEF0IiwiY2xvc2VkQXQiXSl7Y29uc3QgdD1EYXRlLnBhcnNlKGl0ZW0/LltrZXldfHwiIik7aWYoTnVtYmVyLmlzRmluaXRlKHQpKXJldHVybiB0O31yZXR1cm4gMDt9CiAgZnVuY3Rpb24gc3luY01lcmdlQnlLZXkobG9jYWwscmVtb3RlLGtleUZpZWxkKXtjb25zdCBtYXA9bmV3IE1hcCgpO2Zvcihjb25zdCBpdGVtIG9mIEFycmF5LmlzQXJyYXkobG9jYWwpP2xvY2FsOltdKW1hcC5zZXQoU3RyaW5nKGl0ZW0/LltrZXlGaWVsZF18fCIiKSxpdGVtKTtmb3IoY29uc3QgcmVtb3RlSXRlbSBvZiBBcnJheS5pc0FycmF5KHJlbW90ZSk/cmVtb3RlOltdKXtjb25zdCBrZXk9U3RyaW5nKHJlbW90ZUl0ZW0/LltrZXlGaWVsZF18fCIiKTtpZigha2V5KWNvbnRpbnVlO2NvbnN0IGxvY2FsSXRlbT1tYXAuZ2V0KGtleSk7aWYoIWxvY2FsSXRlbXx8c3luY0l0ZW1UaW1lKHJlbW90ZUl0ZW0pPj1zeW5jSXRlbVRpbWUobG9jYWxJdGVtKSltYXAuc2V0KGtleSxyZW1vdGVJdGVtKTt9cmV0dXJuIFsuLi5tYXAudmFsdWVzKCldO30KICBmdW5jdGlvbiBzeW5jQ3VycmVudFBheWxvYWQoKXtyZXR1cm4ge3NjaGVtYTpTWU5DX1BBWUxPQURfU0NIRU1BLHBheWxvYWRWZXJzaW9uOiI2LjMuMSIsYXBwOiJFbGRlaG9mIixzY29wZToiZnVsbCIscmVjb3JkczpzYW5pdGl6ZVJlY29yZHMocmVjb3JkcyksdmFpbGxhbnRNb250aHM6QXJyYXkuaXNBcnJheSh2YWlsbGFudE1vbnRocyk/dmFpbGxhbnRNb250aHM6W10sY2xpbWF0ZU1vbnRoczpjbGltYXRlU2FuaXRpemUoY2xpbWF0ZU1vbnRocyksbWV0ZXJSZWFkaW5nczpzYW5pdGl6ZU1ldGVyUmVhZGluZ3MobWV0ZXJSZWFkaW5ncyksbWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdDpsb2NhbFN0b3JhZ2UuZ2V0SXRlbShNRVRFUl9NRVRBX0tFWSl8fCIiLG9zdHJvbUxpdmU6b3N0cm9tTGl2ZXx8bnVsbCxvc3Ryb21QcmljZVN0YXRzOnNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhvc3Ryb21QcmljZVN0YXRzKSxleHBvcnRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxzb3VyY2VEZXZpY2VJZDpzeW5jU3RhdGUuZGV2aWNlSWQsc291cmNlRGV2aWNlTmFtZTpzeW5jU3RhdGUuZGV2aWNlTmFtZX07fQogIGZ1bmN0aW9uIHN5bmNNZXJnZVBheWxvYWQobG9jYWwscmVtb3RlKXsKICAgIGNvbnN0IGxvY2FsTWV0ZXJUaW1lPURhdGUucGFyc2UobG9jYWw/Lm1ldGVyUmVhZGluZ3NVcGRhdGVkQXR8fCIiKXx8MCxyZW1vdGVNZXRlclRpbWU9RGF0ZS5wYXJzZShyZW1vdGU/Lm1ldGVyUmVhZGluZ3NVcGRhdGVkQXR8fCIiKXx8MDsKICAgIGxldCBtZXJnZWRNZXRlcnM7aWYocmVtb3RlTWV0ZXJUaW1lPmxvY2FsTWV0ZXJUaW1lKW1lcmdlZE1ldGVycz1yZW1vdGUubWV0ZXJSZWFkaW5nc3x8W107ZWxzZSBpZihsb2NhbE1ldGVyVGltZT5yZW1vdGVNZXRlclRpbWUpbWVyZ2VkTWV0ZXJzPWxvY2FsLm1ldGVyUmVhZGluZ3N8fFtdO2Vsc2UgbWVyZ2VkTWV0ZXJzPShyZW1vdGU/Lm1ldGVyUmVhZGluZ3M/Lmxlbmd0aHx8MCk+PShsb2NhbD8ubWV0ZXJSZWFkaW5ncz8ubGVuZ3RofHwwKT9yZW1vdGUubWV0ZXJSZWFkaW5nc3x8W106bG9jYWwubWV0ZXJSZWFkaW5nc3x8W107CiAgICBjb25zdCBsb2NhbExpdmU9RGF0ZS5wYXJzZShsb2NhbD8ub3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKXx8MCxyZW1vdGVMaXZlPURhdGUucGFyc2UocmVtb3RlPy5vc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpfHwwOwogICAgcmV0dXJuIHtzY2hlbWE6U1lOQ19QQVlMT0FEX1NDSEVNQSxwYXlsb2FkVmVyc2lvbjoiNi4zLjEiLGFwcDoiRWxkZWhvZiIsc2NvcGU6ImZ1bGwiLHJlY29yZHM6c2FuaXRpemVSZWNvcmRzKHN5bmNNZXJnZUJ5S2V5KGxvY2FsPy5yZWNvcmRzLHJlbW90ZT8ucmVjb3JkcywibW9udGgiKSksdmFpbGxhbnRNb250aHM6c3luY01lcmdlQnlLZXkobG9jYWw/LnZhaWxsYW50TW9udGhzLHJlbW90ZT8udmFpbGxhbnRNb250aHMsIm1vbnRoIiksY2xpbWF0ZU1vbnRoczpjbGltYXRlU2FuaXRpemUoc3luY01lcmdlQnlLZXkobG9jYWw/LmNsaW1hdGVNb250aHMscmVtb3RlPy5jbGltYXRlTW9udGhzLCJtb250aCIpKSxtZXRlclJlYWRpbmdzOnNhbml0aXplTWV0ZXJSZWFkaW5ncyhtZXJnZWRNZXRlcnMpLG1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6cmVtb3RlTWV0ZXJUaW1lPmxvY2FsTWV0ZXJUaW1lP3JlbW90ZS5tZXRlclJlYWRpbmdzVXBkYXRlZEF0OmxvY2FsLm1ldGVyUmVhZGluZ3NVcGRhdGVkQXQsb3N0cm9tTGl2ZTpyZW1vdGVMaXZlPj1sb2NhbExpdmU/cmVtb3RlPy5vc3Ryb21MaXZlfHxudWxsOmxvY2FsPy5vc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHN5bmNNZXJnZUJ5S2V5KGxvY2FsPy5vc3Ryb21QcmljZVN0YXRzLHJlbW90ZT8ub3N0cm9tUHJpY2VTdGF0cywibW9udGgiKSksZXhwb3J0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksc291cmNlRGV2aWNlSWQ6c3luY1N0YXRlLmRldmljZUlkLHNvdXJjZURldmljZU5hbWU6c3luY1N0YXRlLmRldmljZU5hbWV9OwogIH0KICBmdW5jdGlvbiBzeW5jQ29tcGFyYWJsZShwYXlsb2FkKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3JlY29yZHM6c2FuaXRpemVSZWNvcmRzKHBheWxvYWQ/LnJlY29yZHN8fFtdKSx2YWlsbGFudE1vbnRoczpwYXlsb2FkPy52YWlsbGFudE1vbnRoc3x8W10sY2xpbWF0ZU1vbnRoczpjbGltYXRlU2FuaXRpemUocGF5bG9hZD8uY2xpbWF0ZU1vbnRoc3x8W10pLG1ldGVyUmVhZGluZ3M6c2FuaXRpemVNZXRlclJlYWRpbmdzKHBheWxvYWQ/Lm1ldGVyUmVhZGluZ3N8fFtdKSxtZXRlclJlYWRpbmdzVXBkYXRlZEF0OnBheWxvYWQ/Lm1ldGVyUmVhZGluZ3NVcGRhdGVkQXR8fCIiLG9zdHJvbUxpdmU6cGF5bG9hZD8ub3N0cm9tTGl2ZXx8bnVsbCxvc3Ryb21QcmljZVN0YXRzOnNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhwYXlsb2FkPy5vc3Ryb21QcmljZVN0YXRzfHxbXSl9KTt9CiAgZnVuY3Rpb24gc3luY0FwcGx5UGF5bG9hZChwYXlsb2FkKXtzeW5jQXBwbHlpbmc9dHJ1ZTt0cnl7c2F2ZVJlY29yZHMocGF5bG9hZC5yZWNvcmRzfHxbXSx7cmVhc29uOiJHZXLDpHRlLVN5bmMiLGFsbG93RW1wdHk6dHJ1ZX0pO3ZhaWxsYW50TW9udGhzPUFycmF5LmlzQXJyYXkocGF5bG9hZC52YWlsbGFudE1vbnRocyk/cGF5bG9hZC52YWlsbGFudE1vbnRoczpbXTtzYXZlVmFpbGxhbnRNb250aHMoKTtzYXZlQ2xpbWF0ZU1vbnRocyhwYXlsb2FkLmNsaW1hdGVNb250aHN8fFtdKTtzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3N8fFtdLHt0b3VjaDpmYWxzZX0pO2lmKHBheWxvYWQubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShNRVRFUl9NRVRBX0tFWSxwYXlsb2FkLm1ldGVyUmVhZGluZ3NVcGRhdGVkQXQpO3NhdmVPc3Ryb21DYWNoZShwYXlsb2FkLm9zdHJvbUxpdmV8fG51bGwpO3NhdmVPc3Ryb21QcmljZVN0YXRzKHBheWxvYWQub3N0cm9tUHJpY2VTdGF0c3x8W10pO31maW5hbGx5e3N5bmNBcHBseWluZz1mYWxzZTt9cmVuZGVyQWxsKCk7fQogIGZ1bmN0aW9uIHNjaGVkdWxlQ2xvdWRTeW5jKGRlbGF5PTkwMCl7Y2xlYXJUaW1lb3V0KHN5bmNEZWJvdW5jZVRpbWVyKTtpZighc3luY1N0YXRlLmNvbmZpZ3VyZWR8fHN5bmNBcHBseWluZylyZXR1cm47c3luY0RlYm91bmNlVGltZXI9c2V0VGltZW91dCgoKT0+e2lmKGRvY3VtZW50LnZpc2liaWxpdHlTdGF0ZSE9PSJoaWRkZW4iJiZuYXZpZ2F0b3Iub25MaW5lIT09ZmFsc2Upc3luY05vdyh7c2lsZW50OnRydWV9KTt9LGRlbGF5KTt9CiAgZnVuY3Rpb24gc2NoZWR1bGVTeW5jUG9sbCgpe2NsZWFySW50ZXJ2YWwoc3luY1BvbGxUaW1lcik7c3luY1BvbGxUaW1lcj1udWxsO2lmKCFzeW5jU3RhdGUuY29uZmlndXJlZClyZXR1cm47c3luY1BvbGxUaW1lcj1zZXRJbnRlcnZhbCgoKT0+e2lmKGRvY3VtZW50LnZpc2liaWxpdHlTdGF0ZT09PSJ2aXNpYmxlIiYmbmF2aWdhdG9yLm9uTGluZSE9PWZhbHNlKXN5bmNOb3coe3NpbGVudDp0cnVlfSk7fSw2MCoxMDAwKTt9CiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlU3luY1ZhdWx0KCl7aWYoc3luY0J1c3kpcmV0dXJuO2NvbnN0IGRldmljZU5hbWU9U3RyaW5nKCQoInN5bmNDcmVhdGVEZXZpY2VOYW1lIikudmFsdWV8fCIiKS50cmltKCk7aWYoZGV2aWNlTmFtZS5sZW5ndGg8Mil7dG9hc3QoIkdlcsOkdGVuYW1lbiBlaW5nZWJlbiIpO3JldHVybjt9c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7c3luY1N0YXRlPXtjb25maWd1cmVkOnRydWUsdmF1bHRJZDpzeW5jR2VuZXJhdGVJZCgidmF1bHQiLDE4KSxkZXZpY2VJZDpzeW5jR2VuZXJhdGVJZCgiZGV2aWNlIiwxNiksZGV2aWNlTmFtZSxkZXZpY2VUb2tlbjpzeW5jR2VuZXJhdGVJZCgidG9rZW4iLDMyKSxyZWNvdmVyeUtleTpzeW5jR2VuZXJhdGVSZWNvdmVyeUtleSgpLHJvbGU6ImFkbWluIixzY29wZToiZnVsbCIsc2VydmVyUmV2aXNpb246MCxsYXN0U3luY0F0OiIiLGxhc3RFcnJvcjoiIn07Y29uc3Qgc25hcHNob3Q9c3luY0N1cnJlbnRQYXlsb2FkKCk7Y29uc3QgZW52ZWxvcGU9YXdhaXQgc3luY0VuY3J5cHQoc25hcHNob3QpO2NvbnN0IHJlc3VsdD1hd2FpdCBzeW5jQXBpKCJ2YXVsdC9jcmVhdGUiLHt2YXVsdElkOnN5bmNTdGF0ZS52YXVsdElkLGRldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VuOnN5bmNTdGF0ZS5kZXZpY2VUb2tlbixzY29wZToiZnVsbCIsZW52ZWxvcGV9KTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cmVzdWx0LnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7c2NoZWR1bGVTeW5jUG9sbCgpO3JlbmRlckFsbCgpO3RvYXN0KCJHZXLDpHRlLVN5bmMgZWluZ2VyaWNodGV0Iik7fWNhdGNoKGVycm9yKXtzeW5jU3RhdGU9bG9hZFN5bmNTdGF0ZSgpO3N5bmNTdGF0ZS5sYXN0RXJyb3I9ZXJyb3IubWVzc2FnZTtzYXZlU3luY1N0YXRlKCk7YWxlcnQoYEdlcsOkdGUtU3luYyBrb25udGUgbmljaHQgZWluZ2VyaWNodGV0IHdlcmRlbjogJHtlcnJvci5tZXNzYWdlfWApO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlU3luY1BhaXJpbmcoKXtpZihzeW5jQnVzeXx8IXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjtpZihzeW5jU3RhdGUucm9sZSE9PSJhZG1pbiIpe3RvYXN0KCJOdXIgZGFzIGVyc3RlIFZlcndhbHR1bmdzZ2Vyw6R0IGthbm4gbmV1ZSBHZXLDpHRlIGtvcHBlbG4iKTtyZXR1cm47fXN5bmNCdXN5PXRydWU7cmVuZGVyU3luY1BhbmVsKCk7dHJ5e2NvbnN0IHJlc3VsdD1hd2FpdCBzeW5jQXBpKCJwYWlyL2NyZWF0ZSIsc3luY0F1dGgoe3Njb3BlOiJmdWxsIn0pKTskKCJzeW5jUGFpclZhdWx0IikudGV4dENvbnRlbnQ9c3luY1N0YXRlLnZhdWx0SWQ7JCgic3luY1BhaXJDb2RlIikudGV4dENvbnRlbnQ9cmVzdWx0LmNvZGU7JCgic3luY1BhaXJSZWNvdmVyeSIpLnRleHRDb250ZW50PXN5bmNSZWNvdmVyeUZvcm1hdChzeW5jU3RhdGUucmVjb3ZlcnlLZXkpOyQoInN5bmNQYWlyRXhwaXJ5IikudGV4dENvbnRlbnQ9YENvZGUgZ8O8bHRpZyBiaXMgJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHJlc3VsdC5leHBpcmVzQXQpKX1gOyQoInN5bmNQYWlyUmVzdWx0IikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7fWNhdGNoKGVycm9yKXt0b2FzdChlcnJvci5tZXNzYWdlKTt9ZmluYWxseXtzeW5jQnVzeT1mYWxzZTtyZW5kZXJTeW5jUGFuZWwoKTt9fQogIGFzeW5jIGZ1bmN0aW9uIGpvaW5TeW5jVmF1bHQoKXtpZihzeW5jQnVzeSlyZXR1cm47Y29uc3QgdmF1bHRJZD1TdHJpbmcoJCgic3luY0pvaW5WYXVsdElkIikudmFsdWV8fCIiKS50cmltKCksY29kZT1TdHJpbmcoJCgic3luY0pvaW5Db2RlIikudmFsdWV8fCIiKS50cmltKCkscmVjb3ZlcnlLZXk9c3luY1JlY292ZXJ5Tm9ybWFsaXplKCQoInN5bmNKb2luUmVjb3ZlcnkiKS52YWx1ZSksZGV2aWNlTmFtZT1TdHJpbmcoJCgic3luY0pvaW5EZXZpY2VOYW1lIikudmFsdWV8fCIiKS50cmltKCk7aWYoIXZhdWx0SWR8fCFjb2RlfHxyZWNvdmVyeUtleS5sZW5ndGghPT02NHx8ZGV2aWNlTmFtZS5sZW5ndGg8Mil7dG9hc3QoIktvcHBsdW5nc2RhdGVuIHZvbGxzdMOkbmRpZyBlaW5nZWJlbiIpO3JldHVybjt9c3luY0J1c3k9dHJ1ZTt0cnl7Y29uc3QgZGV2aWNlSWQ9c3luY0dlbmVyYXRlSWQoImRldmljZSIsMTYpLGRldmljZVRva2VuPXN5bmNHZW5lcmF0ZUlkKCJ0b2tlbiIsMzIpO2NvbnN0IGNsYWltPWF3YWl0IHN5bmNBcGkoInBhaXIvY2xhaW0iLHt2YXVsdElkLGNvZGUsZGV2aWNlSWQsZGV2aWNlTmFtZSxkZXZpY2VUb2tlbn0pO3N5bmNTdGF0ZT17Y29uZmlndXJlZDp0cnVlLHZhdWx0SWQsZGV2aWNlSWQsZGV2aWNlTmFtZSxkZXZpY2VUb2tlbixyZWNvdmVyeUtleSxyb2xlOmNsYWltLnJvbGV8fCJtZW1iZXIiLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtzYXZlU3luY1N0YXRlKCk7Y29uc3QgcmVtb3RlPWF3YWl0IHN5bmNBcGkoInNuYXBzaG90L3B1bGwiLHN5bmNBdXRoKCkpO2NvbnN0IHJlbW90ZVBheWxvYWQ9YXdhaXQgc3luY0RlY3J5cHQocmVtb3RlLnNuYXBzaG90LmVudmVsb3BlKTtjb25zdCBtZXJnZWQ9c3luY01lcmdlUGF5bG9hZChzeW5jQ3VycmVudFBheWxvYWQoKSxyZW1vdGVQYXlsb2FkKTtzeW5jQXBwbHlQYXlsb2FkKG1lcmdlZCk7c3luY1N0YXRlLnNlcnZlclJldmlzaW9uPXJlbW90ZS5yZXZpc2lvbjtzeW5jU3RhdGUubGFzdFN5bmNBdD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7c2F2ZVN5bmNTdGF0ZSgpO2lmKHN5bmNDb21wYXJhYmxlKG1lcmdlZCkhPT1zeW5jQ29tcGFyYWJsZShyZW1vdGVQYXlsb2FkKSl7Y29uc3QgZW52ZWxvcGU9YXdhaXQgc3luY0VuY3J5cHQobWVyZ2VkKTtjb25zdCBwdXNoZWQ9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVzaCIsc3luY0F1dGgoe2Jhc2VSZXZpc2lvbjpyZW1vdGUucmV2aXNpb24sZW52ZWxvcGV9KSk7c3luY1N0YXRlLnNlcnZlclJldmlzaW9uPXB1c2hlZC5yZXZpc2lvbjtzeW5jU3RhdGUubGFzdFN5bmNBdD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7c2F2ZVN5bmNTdGF0ZSgpO31zY2hlZHVsZVN5bmNQb2xsKCk7cmVuZGVyQWxsKCk7dG9hc3QoIkdlcsOkdCBnZWtvcHBlbHQgdW5kIGFrdHVhbGlzaWVydCIpO31jYXRjaChlcnJvcil7c3luY1N0YXRlPXtjb25maWd1cmVkOmZhbHNlLHZhdWx0SWQ6IiIsZGV2aWNlSWQ6IiIsZGV2aWNlTmFtZToiIixkZXZpY2VUb2tlbjoiIixyZWNvdmVyeUtleToiIixyb2xlOiJtZW1iZXIiLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOmVycm9yLm1lc3NhZ2V9O3NhdmVTeW5jU3RhdGUoKTthbGVydChgS29wcGx1bmcgZmVobGdlc2NobGFnZW46ICR7ZXJyb3IubWVzc2FnZX1gKTt9ZmluYWxseXtzeW5jQnVzeT1mYWxzZTtyZW5kZXJTeW5jUGFuZWwoKTt9fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNOb3coe3NpbGVudD1mYWxzZSxyZXRyeT10cnVlfT17fSl7aWYoc3luY0J1c3l8fCFzeW5jU3RhdGUuY29uZmlndXJlZClyZXR1cm4gZmFsc2U7c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7Y29uc3QgcmVtb3RlPWF3YWl0IHN5bmNBcGkoInNuYXBzaG90L3B1bGwiLHN5bmNBdXRoKCkpO2NvbnN0IHJlbW90ZVBheWxvYWQ9YXdhaXQgc3luY0RlY3J5cHQocmVtb3RlLnNuYXBzaG90LmVudmVsb3BlKTtjb25zdCBsb2NhbFBheWxvYWQ9c3luY0N1cnJlbnRQYXlsb2FkKCk7Y29uc3QgbWVyZ2VkPXN5bmNNZXJnZVBheWxvYWQobG9jYWxQYXlsb2FkLHJlbW90ZVBheWxvYWQpO3N5bmNBcHBseVBheWxvYWQobWVyZ2VkKTtsZXQgcmV2aXNpb249cmVtb3RlLnJldmlzaW9uO2lmKHN5bmNDb21wYXJhYmxlKG1lcmdlZCkhPT1zeW5jQ29tcGFyYWJsZShyZW1vdGVQYXlsb2FkKSl7dHJ5e2NvbnN0IGVudmVsb3BlPWF3YWl0IHN5bmNFbmNyeXB0KG1lcmdlZCk7Y29uc3QgcHVzaGVkPWF3YWl0IHN5bmNBcGkoInNuYXBzaG90L3B1c2giLHN5bmNBdXRoKHtiYXNlUmV2aXNpb246cmVtb3RlLnJldmlzaW9uLGVudmVsb3BlfSkpO3JldmlzaW9uPXB1c2hlZC5yZXZpc2lvbjt9Y2F0Y2goZXJyb3Ipe2lmKGVycm9yLnN0YXR1cz09PTQwOSYmcmV0cnkpe3N5bmNCdXN5PWZhbHNlO3JldHVybiBhd2FpdCBzeW5jTm93KHtzaWxlbnQscmV0cnk6ZmFsc2V9KTt9dGhyb3cgZXJyb3I7fX1zeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cmV2aXNpb247c3luY1N0YXRlLmxhc3RTeW5jQXQ9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO3N5bmNTdGF0ZS5sYXN0RXJyb3I9IiI7c2F2ZVN5bmNTdGF0ZSgpO2lmKCFzaWxlbnQpdG9hc3QoIkFsbGUgR2Vyw6R0ZSBhdWYgYWt0dWVsbGVtIFN0YW5kIik7cmV0dXJuIHRydWU7fWNhdGNoKGVycm9yKXtzeW5jU3RhdGUubGFzdEVycm9yPWVycm9yLm1lc3NhZ2U7c2F2ZVN5bmNTdGF0ZSgpO2lmKCFzaWxlbnQpdG9hc3QoYFN5bmM6ICR7ZXJyb3IubWVzc2FnZX1gKTtyZXR1cm4gZmFsc2U7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBmdW5jdGlvbiBkaXNjb25uZWN0U3luYygpe2lmKCFjb25maXJtKCJEaWVzZXMgR2Vyw6R0IGxva2FsIHZvbSBFbGRlaG9mLVN5bmMgdHJlbm5lbj8gRGllIERhdGVuIGF1ZiBkZW0gR2Vyw6R0IGJsZWliZW4gZXJoYWx0ZW4uIikpcmV0dXJuO3N5bmNTdGF0ZT17Y29uZmlndXJlZDpmYWxzZSx2YXVsdElkOiIiLGRldmljZUlkOiIiLGRldmljZU5hbWU6IiIsZGV2aWNlVG9rZW46IiIscmVjb3ZlcnlLZXk6IiIscm9sZToibWVtYmVyIixzY29wZToiZnVsbCIsc2VydmVyUmV2aXNpb246MCxsYXN0U3luY0F0OiIiLGxhc3RFcnJvcjoiIn07c2F2ZVN5bmNTdGF0ZSgpO3NjaGVkdWxlU3luY1BvbGwoKTtyZW5kZXJTeW5jUGFuZWwoKTt0b2FzdCgiR2Vyw6R0IHZvbSBTeW5jIGdldHJlbm50Iik7fQogIGZ1bmN0aW9uIHJlbmRlclN5bmNQYW5lbCgpe2lmKCEkKCJzeW5jUGFuZWwiKSlyZXR1cm47JCgic3luY1NldHVwQm94IikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIixzeW5jU3RhdGUuY29uZmlndXJlZCk7JCgic3luY0FjdGl2ZUJveCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIXN5bmNTdGF0ZS5jb25maWd1cmVkKTtjb25zdCBiYWRnZT0kKCJzeW5jQmFkZ2UiKTtiYWRnZS5jbGFzc05hbWU9YHN5bmMtYmFkZ2UgJHtzeW5jQnVzeT8iYnVzeSI6c3luY1N0YXRlLmxhc3RFcnJvcj8iZXJyb3IiOnN5bmNTdGF0ZS5jb25maWd1cmVkPyJvayI6IiJ9YDtiYWRnZS50ZXh0Q29udGVudD1zeW5jQnVzeT8ic3luY2hyb25pc2llcnQg4oCmIjpzeW5jU3RhdGUubGFzdEVycm9yPyJGZWhsZXIiOnN5bmNTdGF0ZS5jb25maWd1cmVkPyJ2ZXJidW5kZW4iOiJuaWNodCBlaW5nZXJpY2h0ZXQiO2lmKCFzeW5jU3RhdGUuY29uZmlndXJlZClyZXR1cm47JCgic3luY0RldmljZVRleHQiKS50ZXh0Q29udGVudD1zeW5jU3RhdGUuZGV2aWNlTmFtZXx8ImRpZXNlcyBHZXLDpHQiOyQoInN5bmNSb2xlVGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5yb2xlPT09ImFkbWluIj8iVmVyd2FsdHVuZ3NnZXLDpHQiOiJnZWtvcHBlbHRlcyBHZXLDpHQiOyQoInN5bmNSZXZpc2lvblRleHQiKS50ZXh0Q29udGVudD1TdHJpbmcoc3luY1N0YXRlLnNlcnZlclJldmlzaW9ufHwwKTskKCJzeW5jTGFzdFRleHQiKS50ZXh0Q29udGVudD1zeW5jU3RhdGUubGFzdFN5bmNBdD9genVsZXR6dCAke2Zvcm1hdERhdGVUaW1lKHN5bmNTdGF0ZS5sYXN0U3luY0F0KX1gOiJub2NoIG5pZSI7JCgic3luY1N0YXR1cyIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5sYXN0RXJyb3I/YExldHp0ZXIgRmVobGVyOiAke3N5bmNTdGF0ZS5sYXN0RXJyb3J9YDoiw4RuZGVydW5nZW4gd2VyZGVuIGF1dG9tYXRpc2NoIGFiZ2VnbGljaGVuLiI7JCgic3luY1N0YXR1cyIpLmNsYXNzTmFtZT1gc3RhdHVzLXRleHQgJHtzeW5jU3RhdGUubGFzdEVycm9yPyJlcnJvciI6Im9rIn1gOyQoInN5bmNQYWlyQnRuIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIixzeW5jU3RhdGUucm9sZSE9PSJhZG1pbiIpO30KCiAgZnVuY3Rpb24gc2F2ZUNvc3RTZXR0aW5ncygpeyBzZXR0aW5ncy5mYWxsYmFja1ByaWNlPU1hdGgubWF4KDAsTnVtYmVyKCQoImZhbGxiYWNrUHJpY2VJbnB1dCIpLnZhbHVlKXx8MCk7c2V0dGluZ3MuZGVmYXVsdEJhc2VGZWU9TWF0aC5tYXgoMCxOdW1iZXIoJCgiZGVmYXVsdEJhc2VGZWVJbnB1dCIpLnZhbHVlKXx8MCk7c2F2ZVNldHRpbmdzKCk7c2NoZWR1bGVDbG91ZFN5bmMoKTtyZW5kZXJBbGwoKTt0b2FzdCgiS29zdGVuLUVpbnN0ZWxsdW5nZW4gZ2VzcGVpY2hlcnQiKTsgfQoKICBmdW5jdGlvbiByZW5kZXJBbGwoKXsgdXBkYXRlUmVjb3ZlcnlCYW5uZXIoKTtyZW5kZXJEYXNoYm9hcmQoKTtyZW5kZXJSZWNvcmRzKCk7cmVuZGVyQW5hbHlzaXMoKTtyZW5kZXJEYXRhKCk7IH0KICBmdW5jdGlvbiByZXNpemVDaGFydHMoKXsgY2xlYXJUaW1lb3V0KHJlc2l6ZVRpbWVyKTtyZXNpemVUaW1lcj1zZXRUaW1lb3V0KCgpPT57IGlmKGN1cnJlbnRWaWV3PT09ImRhc2hib2FyZFZpZXciKXJlbmRlckRhc2hib2FyZCgpOyBpZihjdXJyZW50Vmlldz09PSJhbmFseXNpc1ZpZXciKXJlbmRlckFuYWx5c2lzKCk7IH0sMTAwKTsgfQoKICBmdW5jdGlvbiBiaW5kKCl7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXZlbnQ9PnsKICAgICAgY29uc3QgbmF2PWV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1uYXZdIik7IGlmKG5hdil7c3dpdGNoVmlldyhuYXYuZGF0YXNldC5uYXYpO3JldHVybjt9CiAgICAgIGNvbnN0IGVkaXQ9ZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLWVkaXQtbW9udGhdIik7IGlmKGVkaXQpe29wZW5SZWNvcmRNb2RhbChlZGl0LmRhdGFzZXQuZWRpdE1vbnRoKTtyZXR1cm47fQogICAgICBpZihldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtY2xvc2UtcmVjb3JkLW1vZGFsXSIpKXtjbG9zZVJlY29yZE1vZGFsKCk7cmV0dXJuO30KICAgICAgaWYoZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLWNsb3NlLW1ldGVyLW1vZGFsXSIpKXtjbG9zZU1ldGVyTW9kYWwoKTtyZXR1cm47fQogICAgfSk7CiAgICAkKCJkYXNoYm9hcmRBZGRCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsb3Blbk1ldGVyTW9kYWwpOyAkKCJhZGRSZWNvcmRCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsb3Blbk1ldGVyTW9kYWwpOyAkKCJhZGRNZXRlckJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7CiAgICAkKCJlZGl0TGF0ZXN0QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5vcGVuUmVjb3JkTW9kYWwoJCgiZWRpdExhdGVzdEJ0biIpLmRhdGFzZXQubW9udGgpKTsKICAgICQoInJlY29yZEZvcm0iKS5hZGRFdmVudExpc3RlbmVyKCJzdWJtaXQiLHNhdmVFZGl0ZWRSZWNvcmQpOyBbInJlY29yZFRvdGFsIiwicmVjb3JkSGVhdFB1bXAiLCJyZWNvcmRBbm5leCJdLmZvckVhY2goaWQ9PiQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoImlucHV0Iix1cGRhdGVEZXJpdmVkUHJldmlldykpOwogICAgJCgibWV0ZXJGb3JtIikuYWRkRXZlbnRMaXN0ZW5lcigic3VibWl0IixzYXZlTWV0ZXJSZWFkaW5nRnJvbUZvcm0pOyBbIm1ldGVyRGF0ZSIsIm1ldGVyVG90YWwiLCJtZXRlckFubmV4Il0uZm9yRWFjaChpZD0+JChpZCkuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLHVwZGF0ZU1ldGVyUHJldmlldykpOwogICAgJCgidW5kb0xhdGVzdE1ldGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHVuZG9MYXRlc3RNZXRlclJlYWRpbmcpOwogICAgJCgicmVjb3JkWWVhckZpbHRlciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIscmVuZGVyUmVjb3Jkcyk7ICQoImFuYWx5c2lzWWVhciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIscmVuZGVyQW5hbHlzaXMpOwogICAgJCgicmVzdG9yZVNoYWRvd0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixyZXN0b3JlU2hhZG93KTsgJCgiZXhwb3J0QmFja3VwQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV4cG9ydEJhY2t1cCk7ICQoImV4cG9ydENzdkJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixleHBvcnRDc3YpOyAkKCJpbXBvcnRCYWNrdXBJbnB1dCIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsKCk9Pntjb25zdCBmPSQoImltcG9ydEJhY2t1cElucHV0IikuZmlsZXM/LlswXTtpZihmKWltcG9ydEJhY2t1cChmKTt9KTsKICAgICQoInZhaWxsYW50Q3N2RmlsZXNJbnB1dCIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsKCk9PmltcG9ydFZhaWxsYW50Q3N2RmlsZXMoJCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikuZmlsZXMpKTsKICAgICQoInNhdmVPc3Ryb21CdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsc2F2ZUFuZENoZWNrT3N0cm9tKTsgJCgiZGlzY29ubmVjdE9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixkaXNjb25uZWN0T3N0cm9tKTsgJCgicmVmcmVzaE9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+cmVmcmVzaE9zdHJvbSh0cnVlKSk7ICQoInJlZnJlc2hPc3Ryb21IaXN0b3J5QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5yZWZyZXNoT3N0cm9tSGlzdG9yeSgpKTsgJCgicmVmcmVzaE9zdHJvbVByaWNlU3RhdHNCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PnJlZnJlc2hPc3Ryb21QcmljZVN0YXRzKE51bWJlcigkKCJhbmFseXNpc1llYXIiKS52YWx1ZSl8fG5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSkpOyAkKCJnb09zdHJvbVNldHRpbmdzQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT57c3dpdGNoVmlldygiZGF0YVZpZXciKTtzZXRUaW1lb3V0KCgpPT4kKCJvc3Ryb21TZXR0aW5nc1BhbmVsIikuc2Nyb2xsSW50b1ZpZXcoe2JlaGF2aW9yOiJzbW9vdGgiLGJsb2NrOiJzdGFydCJ9KSwxMDApO30pOwogICAgJCgic3luY0NyZWF0ZUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixjcmVhdGVTeW5jVmF1bHQpOyAkKCJzeW5jSm9pbkJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixqb2luU3luY1ZhdWx0KTsgJCgic3luY05vd0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+c3luY05vdyh7c2lsZW50OmZhbHNlfSkpOyAkKCJzeW5jUGFpckJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixjcmVhdGVTeW5jUGFpcmluZyk7ICQoInN5bmNEaXNjb25uZWN0QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGRpc2Nvbm5lY3RTeW5jKTsKICAgICQoInNhdmVDb3N0U2V0dGluZ3NCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsc2F2ZUNvc3RTZXR0aW5ncyk7CiAgICAkKCJsb2FkQ2xpbWF0ZVdlYXRoZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsbG9hZENsaW1hdGVXZWF0aGVyKTsKICAgICQoImRhc2hib2FyZENsaW1hdGVXZWF0aGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGxvYWRDbGltYXRlV2VhdGhlcik7CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlRGV0YWlsc0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+e3N3aXRjaFZpZXcoImFuYWx5c2lzVmlldyIpO3NldFRpbWVvdXQoKCk9PiQoImNsaW1hdGVBbmFseXNpc1BhbmVsIikuc2Nyb2xsSW50b1ZpZXcoe2JlaGF2aW9yOiJzbW9vdGgiLGJsb2NrOiJzdGFydCJ9KSw3MCk7fSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1kYXNoYm9hcmQtY2xpbWF0ZS1tb2RlXSIpLmZvckVhY2goYnRuPT5idG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT57ZGFzaGJvYXJkQ2xpbWF0ZU1vZGU9YnRuLmRhdGFzZXQuZGFzaGJvYXJkQ2xpbWF0ZU1vZGU7cmVuZGVyRGFzaGJvYXJkQ2xpbWF0ZSgpO30pKTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJyZXNpemUiLHJlc2l6ZUNoYXJ0cyk7IGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoInZpc2liaWxpdHljaGFuZ2UiLCgpPT57aWYoZG9jdW1lbnQuaGlkZGVuKXJldHVybjtpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe2NvbnN0IGFnZT1EYXRlLm5vdygpLURhdGUucGFyc2Uob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKTtpZighTnVtYmVyLmlzRmluaXRlKGFnZSl8fGFnZT4xMCo2MGUzKXJlZnJlc2hPc3Ryb20oZmFsc2UpO31pZihzeW5jU3RhdGUuY29uZmlndXJlZClzeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pO30pOwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsZXZlbnQ9PntpZihldmVudC5rZXkhPT0iRXNjYXBlIilyZXR1cm47aWYoISQoInJlY29yZE1vZGFsIikuY2xhc3NMaXN0LmNvbnRhaW5zKCJoaWRkZW4iKSljbG9zZVJlY29yZE1vZGFsKCk7ZWxzZSBpZighJCgibWV0ZXJNb2RhbCIpLmNsYXNzTGlzdC5jb250YWlucygiaGlkZGVuIikpY2xvc2VNZXRlck1vZGFsKCk7fSk7CiAgfQoKICBmdW5jdGlvbiBpbml0KCl7CiAgICBhcHBseUhpc3RvcmljYWxTZWVkKCk7ZW5zdXJlTWV0ZXJCYXNlbGluZSgpOwogICAgYmluZCgpO3JlbmRlckFsbCgpO3NjaGVkdWxlT3N0cm9tKCk7c2NoZWR1bGVTeW5jUG9sbCgpOwogICAgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXsgY29uc3QgYWdlPURhdGUubm93KCktRGF0ZS5wYXJzZShvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpOyBpZighb3N0cm9tTGl2ZXx8IU51bWJlci5pc0Zpbml0ZShhZ2UpfHxhZ2U+MTAqNjBlMylyZWZyZXNoT3N0cm9tKGZhbHNlKTsgc2V0VGltZW91dCgoKT0+cmVmcmVzaE9zdHJvbUhpc3Rvcnkoe3NpbGVudDp0cnVlLG9ubHlNaXNzaW5nOnRydWUsbWF4TW9udGhzOjJ9KSw0MjAwKTsgfQogICAgaWYoc3luY1N0YXRlLmNvbmZpZ3VyZWQpc2V0VGltZW91dCgoKT0+c3luY05vdyh7c2lsZW50OnRydWV9KSw2NTApOwogICAgaWYoInNlcnZpY2VXb3JrZXIiIGluIG5hdmlnYXRvcil3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigibG9hZCIsKCk9Pm5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLnJlZ2lzdGVyKCJzdy5qcz92PTYuMy4xIikuY2F0Y2goKCk9Pnt9KSk7CiAgICBjb25zb2xlLmluZm8oYEVsZGVob2YgJHtBUFBfQlVJTER9YCk7CiAgfQogIGluaXQoKTsKfSkoKTsK","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/sw.js":{"body":"Y29uc3QgQ0FDSEU9ImVsZGVob2YtdjYtMy0xLWNsaW1hdGUtZGFzaGJvYXJkLTIwMjYxMDMxIjsKY29uc3QgQ09SRT1bIi4vIiwiLi8/dj02LjMuMSIsIi4vaW5kZXguaHRtbCIsIi4vc3R5bGVzLmNzcz92PTYuMy4xIiwiLi9hcHAuanM/dj02LjMuMSIsIi4vbWFuaWZlc3Qud2VibWFuaWZlc3QiLCIuL2ljb24tMTkyLnBuZyIsIi4vaWNvbi01MTIucG5nIl07CnNlbGYuYWRkRXZlbnRMaXN0ZW5lcigiaW5zdGFsbCIsZXZlbnQ9PntldmVudC53YWl0VW50aWwoY2FjaGVzLm9wZW4oQ0FDSEUpLnRoZW4oYz0+Yy5hZGRBbGwoQ09SRSkpLnRoZW4oKCk9PnNlbGYuc2tpcFdhaXRpbmcoKSkpfSk7CnNlbGYuYWRkRXZlbnRMaXN0ZW5lcigiYWN0aXZhdGUiLGV2ZW50PT57ZXZlbnQud2FpdFVudGlsKGNhY2hlcy5rZXlzKCkudGhlbihrZXlzPT5Qcm9taXNlLmFsbChrZXlzLmZpbHRlcihrPT5rIT09Q0FDSEUpLm1hcChrPT5jYWNoZXMuZGVsZXRlKGspKSkpLnRoZW4oKCk9PnNlbGYuY2xpZW50cy5jbGFpbSgpKSl9KTsKc2VsZi5hZGRFdmVudExpc3RlbmVyKCJmZXRjaCIsZXZlbnQ9PnsKICBjb25zdCB1cmw9bmV3IFVSTChldmVudC5yZXF1ZXN0LnVybCk7CiAgaWYoZXZlbnQucmVxdWVzdC5tZXRob2QhPT0iR0VUInx8dXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoIi9hcGkvIikpcmV0dXJuOwogIGV2ZW50LnJlc3BvbmRXaXRoKGZldGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4ocmVzcG9uc2U9Pntjb25zdCBjb3B5PXJlc3BvbnNlLmNsb25lKCk7Y2FjaGVzLm9wZW4oQ0FDSEUpLnRoZW4oYz0+Yy5wdXQoZXZlbnQucmVxdWVzdCxjb3B5KSk7cmV0dXJuIHJlc3BvbnNlO30pLmNhdGNoKCgpPT5jYWNoZXMubWF0Y2goZXZlbnQucmVxdWVzdCkudGhlbihjYWNoZWQ9PmNhY2hlZHx8Y2FjaGVzLm1hdGNoKCIuL2luZGV4Lmh0bWwiKSkpKTsKfSk7Cg==","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/manifest.webmanifest":{"body":"ewogICJuYW1lIjogIkVsZGVob2YgNi4yLjEg4oCTIFZlcmJyYXVjaHNidWNoIiwKICAic2hvcnRfbmFtZSI6ICJFbGRlaG9mIiwKICAiZGVzY3JpcHRpb24iOiAiU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4g4oCTIG1pdCBrb21wYWt0ZXIgT3N0cm9tLVByZWlzw7xiZXJzaWNodC4iLAogICJzdGFydF91cmwiOiAiLi8/dj02LjIuMSIsCiAgInNjb3BlIjogIi4vIiwKICAiZGlzcGxheSI6ICJzdGFuZGFsb25lIiwKICAib3JpZW50YXRpb24iOiAicG9ydHJhaXQtcHJpbWFyeSIsCiAgImJhY2tncm91bmRfY29sb3IiOiAiIzA2MTAxYyIsCiAgInRoZW1lX2NvbG9yIjogIiMwNzExMWYiLAogICJpY29ucyI6IFsKICAgIHsic3JjIjoiaWNvbi0xOTIucG5nIiwic2l6ZXMiOiIxOTJ4MTkyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifSwKICAgIHsic3JjIjoiaWNvbi01MTIucG5nIiwic2l6ZXMiOiI1MTJ4NTEyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifQogIF0KfQo=","type":"application/manifest+json; charset=utf-8","cache":"no-cache"},"/icon-192.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFk0lEQVR42u3du24TQRiG4fVoBShpkKJ0hi6iTEqKKAURJbdASZcqN5AbSJWOkkuAEoUiSkFLSW/RWC6RKFxQWFrlZO96ZnbmP7xfGeWwh8ffzOx6ncnOwVFDbGU5XxT7W4HDbS/t/h6AiI4AiBICEKGBiNISAhCGAEQYwojSEgIQARCpV0IAIgAi9UoIQARApF4JAYgAiNQrIQARABEAEaWjGIAIgEi9EgIQSeOobotPLqe2T8nN+UzR1k7kPxdmXkwVTLmeHZMLaJ2b27OZYTHHV9MykiwDekzHNpqtPOWSZBPQXTpu0QyRlIVRFkNSAEEnQlIiIyOAoFOLkQVAnR7opDCKM6QbEHQkVFG6oTqA0COkitIBBfQYSHcky190Ld1Aqz2EzqhVNLyHlDUQespU0fAeSr8zH9Dj3JAOQOixaiigB0OiAaHHtqFQQA+pm81nIXEeHYq9FEitEtLaQAxeHgaygB4MKVjGE6sZBRD146eEaCAiDBD146qEaCCSdCkoMyDqx1sJ0UBEDCCT9fPp+g0lRAMl6TFmiEl0he7B0NoJeN7xy/Cwtfri59PfNvbx5HKa5fnozA1kYAK0uWwMVFHec8QQtrUPhjMApcrAEIBSTWAoJyDtV4DiNNz9qT9fD9VNg7Kse1rnL6DEIjG2NGMIK6pHaf0ASJYe5kDoScrF3xeeRQb00GoAqnaOu/pxa6iFzkh/yMnSLKAnY/04rKKAHhZ6KZ9TFtAzRv346aGAHnoIQKXP3MD68WCohQ5LMxqoqJ5t68d2FQX0sIUAKnduUurHpKGAHudbm/hh9QE9hevHWA+10GFp5reBSurJWz9mXgMBPeyLR0CFj/h49VPXUPq/e2rRUx3Zxe6/br/UzYcCeurWT6dH6VjWQqdmad3Xo3FpFtBTffaj+tUS0COqftTtdUBPlfrp1aPFUECPwO5RdAQCegrXz1Z65BtqoaNoFihwaRbQI7x+hL+uAnpkTn20HB9xQ9iQlpb8rudEPdzKIGN1D5Noy+d7Q2kZ1kMDiZ5xA4gYrx9rQ9jV2+/Dv/ns5/ux62fv9FuZbaCBSuuJ+P5t06unwDYASOvsZ4ge5kCEAIj6AZCouNIDoMz1400PgLKSsn7JB0Cjz34ARKif7cLN1HsZcmVvcf0BPTRQpJ4nJ84GLigDqJCeB/XTLbvcGgIQAVBUIu6Er6ufktsAIBEg0s/ck3oKbwOrsPqlElc/G7rHBguGsBHj8H4FgLLVD3oARABE/QCIqQ+AHNUPegBE9wCo3uyHAIj6AVDx+kEPgOgeABEAEQARAiACIAIgAiBCsgM6vppyQFVkdaZ+fPwlBdDN+azk/qv+R+vG9oshjLgEZK+ElO5R4Iivkvg4TuKP6309THYOjnL9rpPLadM0t2ezwvuQ8X+vxD3inqKnPJ2MM+jGxoOFGc/B893XjKfbDWHL+YKZIEmaAy3niyyMVot5rgZJTt7x694kmioiqaswDJHUZXzicMYo5mr8atZdB6KKSBKglCqihPzUT9N7JZoqIkmA4qqIEnJSP83we2FxVYQhOXqqNVBcFRV+hxDpzRj100TcjR/OiIHM9uAVCSiijTBkVU+T+H6gXkYMZFanPnkADWHEQGZy6pMTUC8jDJkcvFaZPHv5aozf2+7vPfhKrfcrokdHA/UWEj1kT8+IDbSukOihArPmYnrKAboraWUIRgb0NOUf61nOF90eMpxp11Ohgbq8+3JID6mmUxkQjAzoqQ/oriEYRdCpq0cEIBgppSMLEIyGuxFCRyKgx4ycY3q8UJVDRy6gdYw8YFp3aUOaGwWAeiV5iFg3mgC58iRfjHpARFT4jEQCIAIgAiACIEIARABEAEQARAiACIAIgAiACAEQARABEAEQIQAiACIAIgAibvMfGKe/xgpKwHYAAAAASUVORK5CYII=","type":"image/png","cache":"public, max-age=31536000, immutable"},"/icon-512.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAPpUlEQVR42u3dvW5UVxcG4OORFUWkiYToSIkooaRAFEEucwsp6VxxA9wAlTvKXEJSIlIgCtqU9CiN5TJSChcpiCw09gwz4/Oz93qfp8ynLzFnznnftc62zdGdB48HgIouzy9chC1WLgGAAgAo5fjeXRdBAQCgAABLAAoA0AEKAAAFAGAJUAAAOkABAKAAACwBCgAABQBgCVAAACgAAEuAAgDQAQoAAAUAYAlQAAAoAABLgAIAQAEAWAIUAAAKAMASoAAAUAAAlgAFAKADFAAACgAgfglQAAA2AABLgAIAQAEAoAAAqot6C6QAAGwAACQtAQoAwAYAQNISoAAAbAAAJC0BCgDABgBA0hKgAABsAAAoAACG6m+BFACADQCApCVAAQDYAABIWgIUAIANAAAFAMDXSr4FUgAANgAAFAAAa+q9BVIAADYAAJKWAAUAYAMAQAEAcKNKb4EUAEBqmbkEIZ69vu8isKP3Lz+7CAmO7jx47CrIelAMe7k8v1AAiHv0gQJQAAh9lIECUADIfZSBDlAACH00gQJQACyd+x9OneCxk6dnI99+JZtAAdBi9At6mm2FYk3QewcogAq5L/HprhJqNIECYJnoF/oUKIPea0ABMF/0C31KNkHXNdB1BygAuQ9NlEGnNaAAmCT65T5qQAEogLj0F/2EN0FfNdBvByiAhqJf7qMJeqwBBYDoh9AaUACIfpiqBhrvAAXA3ukv+qFMDXTaAQpA9IMaUABMn/6iH25fAw12gAIQ/aIfcmugxw5QAJOnv+iHhA5QANJf+sOsNdBOBygA0S/6IbQGeiyAlRtL+kP7tj9TLfzNqcf37toA0tNf9MNSq8Die0B3S4ACMPiDDlAASH/ovwMWrAEFkJj+oh+sAj12gENg6Q+92vL0tXAsrACkP6ADGuUV0IHpL/qhHe28C+rrFZACkP5QvAbm7ABnANIfWMCmZ3POd0F9/TiYApD+oANCKQDpDzpAASD9QQcoAOkv/UEHKADpL/1BB+yho3NgBSD9QQfYAKS/9IeYDkABuG8g9Fm2BCiAjfeB9AcdoACkP5CVALfXyznwymcPxC4B4TngFZDxHzzdCsD47/6AyA6IXQJCC0D6gw7QAYkF4NU/IBkGZwDGf/C8T6GLbwSKKwAvf4DBi6DAApD+gA7I3QAAiCsA4z9gCUgsAOkP6IDcDQCAuAIw/gPzLwHtfyfoyucNYAMIGv8BZlgCFIDxH5AMCsD4D8gQBbDUJ2f8BywBERsAgCUgrgCM/4AlwAYAsMwS0PiPAgQVgPEfkBX1C8A3/wBSxQZg/AckRkwBGP8B2WIDMP4DciOmAIz/gISxARj/AemRXQAA1C8A738AOWMDSNngABmiAIz/gLSxARj/gWaSpOVfB+QQmGgv3j10EYhVpAC8/+Hg9NcBxGZO2Q3A+x92n/11AJl5cuyjJTn61/7hm+efXB9yOANA+u/6v4ICaM71l3He/3BwvusAbnQ9VQocA9gAkP46ABsASH8dQJLuD4F9AygTRbljYXbJn/cvO37hXHADcADAiIO8VYDC2eIVENJfBxBKASD9dQAKoEMOAJgtr3UA9VKo2k8COwAQ/VP/yx0LJ/tw+vnpmb8QBsLS3ypAPQoA6a8DUAAg/XUACgCkvw6gvKM7Dx53+qX7HXA0EsGOhdNcPwfe/vPAl+cXNgCoOYBbBeiUAkD6z/H1/P37I58aCgBqTtz2ABQA5Obspq/N+E+b/J3AiP7xv0jHwtgAICv9b/xqjf8ogJH5NXDS39eMRLIB/M8PAUj/Br9y439JZdLGKyCkP4RSAEj/qbz653sfIi3zXUCIfrABgPSfcvzXaigAyJ39dQAKAIrn45a3/zoABQC5yagDojT7u6AHh8AIxDnH/7U/st8YgQ0A6e/PDgoACRgw/usAFADSX/a5DigApF7k+K8DWJZDYER/Q5fFsTA2AKR/0PivHVEASH9cJRQAci1y/NcBKACkP64Yc3AIjCBra/xfu3SOhbEBIP1dQ/rT8i8CUgBIrkbHfx2AAkD643qiAJBWkeO/DmA6DoERUp1dXsfC2ACQ/kHjv5ZFASD9cbVRAMijyPFfB6AAkP648q1r/IcABofACKAex/+1j8CxMDYApL/PAhQAEidg/PeJoACQNfhcUABImcjx36fDYRwCI1wKfkyOhbEBIP2Dxn+fV1Pa/x5QBYA08alhAwA5UmX899mhAJAg+ATZxiEwgqPm+L/2UToWxgaA9PeZggJAUgSM/z7ZRXTxLUAKABnh88UGANKh9PjvU+Y6h8AIhdCP27EwNgCkf9D473NHASAF8OlPpZcTYAXg+ff8h47/7gEUgPQHd0Iuh8AeeHLH/7VbwrGwDQDpj3sDBYAn3PjvDmEfHZ0AKwDPNrhPbAB4qokf/90taRwCe5hh423jWNgGgPQ3/rt/UAB4enEXsUFfJ8CDV0CeW2Yb/1teL1798O/2e8m7IBsA0p+Kzbc1/d1RCgDpb/zPTX/3VVVeAYl+2O8G8zroRt0dANgApD/Gf3daLgUg/UmtvYPS3/2mAJD+xv/c9HfXKQCkP7np796rwSGw6Df+S//b3oSOhW0ASH/cjSgAPG/G/4Dx3z2pAJD+pKe/O1MBIP2N/7np7/7skUNg0Y/0H/9GdSxsA0D6G/+z0t8dqwDwLIH7VgHgKTL+543/7l4FgOeH6PR3D7fPIbDoN/5L/zluZsfCNgCkP1np765WAHhOjP/R6e/eVgB4QnCHu8MVAJ4N43/Y+O8+b5BDYI8E0n+ZG96xsA0A6W/8z0p/d74CwDNAdPq7/1vgFdDCJt2CPV0h4//U6e9djQ0AAAUAxv+Y8R8FAEh/FAAY/6U/JTgExoDcZRVJf2wAkLiISH8UAAAKAIz/oACgcp1IfxQABI7/0h8FAGZ/UACQMf5LfxQAAAoAjP9wO34SmG87e/J2hv/K6ccTl/q6u8//cIWxAVA5/ef8D3U0/o+Y/sWuMAqAaqEsoaZLf1cYBUDrYVEgoUYZ/6dIfx2AAqD1mJBQrjAKAIz/oAAghvRHAUDi+C/9UQBg9gcFABnjv/RHAQCgAMD4DwoACpP+KABIHP+lPwoAzP6gACBj/Jf+KAAAFADEjP/+ki8UAETWhvRHAUDg+C/9UQBg9gcFADHjPygAMP6DAoCM8V/6owDA7A8KADLGf+lPs45dAoo5e/J22gJ494v0xwYAcel/sU/6z/D1gAKA4ezJ29bS9suve9MBKADo3l7j/9e/7FMHoABgwvG/wdm/5a8QFADSf/zxf9Mv+tcBKACozF/zggKAUvb95h9QAGD8BwUA1cd/6Y8CALM/KAA4yOnHk77G/+7Sv6krjAJARsTN/q4wCgAd0Pf47wqjANABidl0+5c/rjAKgPQOOP140lo2fXP8H+vVf+wVZnH+PgCMjcvM/q4wNgBo0fbx3zd9ogDA7A8KAGLGf1AAYPwHBQAZ47/0RwGA2R8UAGSM/9IfBQBmf1AAEDP+gwIA4z8oAMgY/6U/CgDM/qAAIGP8l/4oADD7gwKAmPEfFAAY/0EBQMb4L/1RAGD2BwUAGeO/9EcBgNkfFADEjP+gAMD4DwoAMsZ/6Y8CALM/KADIGP+lPygAzP6gACBm/AcUAMZ/UACQMf5Lf1AAmP1BAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAK45v3Lz2v/5OnZfR8nMIPrafPnr38pAAAUAAAKAAAFAIACAEABAKAAbsV3gq558/yTi4C7SM4ULIDrPwoAML9Ofwhg8AoIIJYCsL+D+0cBAKAAMMSBO0cBNM2vhPMk456ZU5lfA2cDAKS/DQCPdM9OP574Ot0qKAA82LhJ2NXRnQePe/8zPHu9/lbuw6mfEdvmxbuH9f5QZ0/eGv+l/6SKHQDYAEx5dbScsNIfBUBbT3u9B77NnG0//UveDOyi5iugwVugPVV6KdTOu6DGo1/o7+XGbzHv/RVQhQIYHAMAsxdA7+k/DMPq8vzCRwsQaDUMgw4ACC2AAh3gd0IA0yn5/mf4+ruA7AEAiRtAyQ6wBACSZNcC+NIBndaAvyESmEeN9z/Dph8E8zoIoLyNPwlcowO8BQJkyN4FMHT4OshbIGBqZd7/DLv8LiCvgwDjf9wGUKMDvAUCjP+HF8DQz+sgb4EARi6ArlcBSwAgN25bAF10gCUAmEKx9z/DYX8hTI8/LGYJACTGCAXQ/ipgCQCM/xMWQHergCUAkBWjFUDLq4AlADD+T14AHa0ClgBASoxcAG2uApYAwPg/UwF0sQpYAgD5MEkBtLYKWAIA4/+sBdD4KmAJACTDhAXQTg3cuAToAOCbmVB7/J+8AK5qwO0FkFgAi68ClgDA+L9YASxeA06DAem/ZAFc1UDLHzxAiNUi/9VFVgEvggDj//IFsGANAEj/5Qtg/hqwBAA0VAAz14AOAIz/bRXAVQ00dTcA0l8BlFoFfEsoSH9aLIB5asCLICB8/G+3AGaoAR0Axv/k9G+9AObZBnQASH8FEFcDmw4DdACEpH+4VV9f7ug14EAYktM/efwfhuHoux9/6verP753d5R/z7PXN9wcH051A0h/G0D1hcCBMKSR/t0XwLg1oAMgZPyX/nUKYJQacCAMIenPlb7PALY47HjgxsOAwXkAFEp/43/BDWCUhcAeANLfBhC9ENgDQPrbAEIXAnsASH8bQPRCYA+AGtEv/RXAIU2gA0D6K4DcJtjUAWoApH/vVi7BF5sOCbb8siBHAiD9bQD1dwJ7AEh/BZDbBDoAeol+6a8Axvfzb4+2/K9qAAz+CiC3BnQASH8FoAOAWaNf+iuAJjpADYD0VwA6ABD9CkANANJfAaR1gBqAKaJf+isAHQAGfxSAGgCDPwqg5Q5QAyD6FYAaUAOwa/RLfwVQrQPUAIh+BaAG1ACiX/orADUAcl/0K4DMGtAEiH7RrwDUgBogK/dFvwJQA5oA0Y8CUAOagNKhL/oVgBp4dMD/SxnQe+6LfgXArWpAGdBd6Mt9BcAkTaAPaDDuRb8CYO4aUAwsm/VyXwHQYhPAPOS+AkAZIPdRAGgChD4KAGWA0EcBoBKQ+CgAtAKCHgUAwKRWLgGAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgAABQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAEv6D8v4I+AK37xrAAAAAElFTkSuQmCC","type":"image/png","cache":"public, max-age=31536000, immutable"}}