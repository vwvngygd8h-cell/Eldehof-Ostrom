const ELDEHOF_BUILD = "6.3.2-CLIMATE-WEATHER-RECOVERY-20261031";
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

const EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjMuMiDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPGxpbmsgcmVsPSJpY29uIiBocmVmPSJpY29uLTE5Mi5wbmciPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0ic3R5bGVzLmNzcz92PTYuMy4yIj4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwLXNoZWxsIj4KICA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPgogICAgPGRpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPjxzcGFuIGNsYXNzPSJicmFuZC1tYXJrIj7ijII8L3NwYW4+PHNwYW4+RWxkZWhvZjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3VidGl0bGUiPlZlcmJyYXVjaHNidWNoPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJidWlsZC1waWxsIj42LjMuMjwvc3Bhbj4KICA8L2hlYWRlcj4KCiAgPG1haW4+CiAgICA8ZGl2IGlkPSJyZWNvdmVyeUJhbm5lciIgY2xhc3M9ImJhbm5lciB3YXJuaW5nIGhpZGRlbiIgcm9sZT0ic3RhdHVzIj4KICAgICAgPGRpdj48c3Ryb25nPkxva2FsZSBTaWNoZXJoZWl0c2tvcGllIGdlZnVuZGVuPC9zdHJvbmc+PHNwYW4+RGVyIG5vcm1hbGUgTW9uYXRzZGF0ZW5zcGVpY2hlciBpc3QgbGVlciwgYWJlciBlaW5lIGZyw7xoZXJlIGxva2FsZSBLb3BpZSBpc3Qgdm9yaGFuZGVuLjwvc3Bhbj48L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0icmVzdG9yZVNoYWRvd0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldpZWRlcmhlcnN0ZWxsZW48L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IGFjdGl2ZSIgaWQ9ImRhc2hib2FyZFZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGFzaGJvYXJkVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPsOcQkVSU0lDSFQ8L3NwYW4+PGgxIGlkPSJkYXNoYm9hcmRUaXRsZSI+VmVyYnJhdWNoIGF1ZiBlaW5lbiBCbGljazwvaDE+PHA+WsOkaGxlcnN0w6RuZGUsIFfDpHJtZXB1bXBlLCBPc3Ryb20tUHJlaXNlIHVuZCBLbGltYSBhdWYgZWluZW4gQmxpY2suPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJkYXNoYm9hcmRBZGRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBsYXRlc3QtcGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkxFVFpURVIgTU9OQVQ8L3NwYW4+PGgyIGlkPSJsYXRlc3RNb250aFRpdGxlIj5Ob2NoIGtlaW5lIE1vbmF0c3dlcnRlPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJlZGl0TGF0ZXN0QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QgaGlkZGVuIiB0eXBlPSJidXR0b24iPkJlYXJiZWl0ZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCIgaWQ9ImxhdGVzdE1ldHJpY3MiPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJjb21wYXJpc29uLWxpbmUiIGlkPSJsYXRlc3RDb21wYXJpc29uIj48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCBvc3Ryb20tcGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPgogICAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+T1NUUk9NPC9zcGFuPjxoMj5QcmVpc8O8YmVyc2ljaHQ8L2gyPjxzbWFsbCBpZD0ib3N0cm9tU3RhdHVzIj5Ob2NoIG5pY2h0IGdlbGFkZW48L3NtYWxsPjwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBpZD0icmVmcmVzaE9zdHJvbUJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPkFrdHVhbGlzaWVyZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJvc3Ryb21TZXR1cEhpbnQiIGNsYXNzPSJlbXB0eS1zdGF0ZSBoaWRkZW4iPjxzdHJvbmc+T3N0cm9tIGlzdCBub2NoIG5pY2h0IGVpbmdlcmljaHRldC48L3N0cm9uZz48c3Bhbj5EZW4gRWxkZWhvZi1BcHAtU2NobMO8c3NlbCBmaW5kZXN0IGR1IHVudGVyIERhdGVuIOKGkiBPc3Ryb20uPC9zcGFuPjxidXR0b24gaWQ9ImdvT3N0cm9tU2V0dGluZ3NCdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5FaW5yaWNodGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ib3N0cm9tRGFzaGJvYXJkIiBjbGFzcz0ib3N0cm9tLWdyaWQiPgogICAgICAgICAgPGFydGljbGUgY2xhc3M9InByaWNlLWNhcmQgY3VycmVudCI+PHNwYW4+QWt0dWVsbGVyIFByZWlzPC9zcGFuPjxzdHJvbmcgaWQ9Im9zdHJvbUN1cnJlbnRQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21DdXJyZW50TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8YXJ0aWNsZSBjbGFzcz0icHJpY2UtY2FyZCBiZXN0Ij48c3BhbiBpZD0ib3N0cm9tQmVzdExhYmVsIj5CZXN0ZXMgWmVpdGZlbnN0ZXI8L3NwYW4+PHN0cm9uZyBpZD0ib3N0cm9tQmVzdFByaWNlIj7igJM8L3N0cm9uZz48c21hbGwgaWQ9Im9zdHJvbUJlc3RNZXRhIj7igJM8L3NtYWxsPjwvYXJ0aWNsZT4KICAgICAgICAgIDxhcnRpY2xlIGNsYXNzPSJwcmljZS1jYXJkIHdvcnN0Ij48c3BhbiBpZD0ib3N0cm9tV29yc3RMYWJlbCI+U2NobGVjaHRlc3RlcyBaZWl0ZmVuc3Rlcjwvc3Bhbj48c3Ryb25nIGlkPSJvc3Ryb21Xb3JzdFByaWNlIj7igJM8L3N0cm9uZz48c21hbGwgaWQ9Im9zdHJvbVdvcnN0TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBwcmljZS1jaGFydC13cmFwIj48Y2FudmFzIGlkPSJvc3Ryb21NaW5pQ2hhcnQiIGFyaWEtbGFiZWw9Ik9zdHJvbSBQcmVpc3ZlcmxhdWYiPjwvY2FudmFzPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgZGFzaGJvYXJkLWNoYXJ0LXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5WRVJMQVVGPC9zcGFuPjxoMj5HZXNhbXR2ZXJicmF1Y2g8L2gyPjwvZGl2PjxidXR0b24gY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiBkYXRhLW5hdj0iYW5hbHlzaXNWaWV3IiB0eXBlPSJidXR0b24iPkF1c3dlcnR1bmcgw7ZmZm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAiPjxjYW52YXMgaWQ9ImRhc2hib2FyZENvbnN1bXB0aW9uQ2hhcnQiIGFyaWEtbGFiZWw9Ikdlc2FtdHZlcmJyYXVjaCBkZXIgbGV0enRlbiBNb25hdGUiPjwvY2FudmFzPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgZGFzaGJvYXJkLWNsaW1hdGUtcGFuZWwiIGlkPSJkYXNoYm9hcmRDbGltYXRlUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPgogICAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S0xJTUEgJmFtcDsgSEVJWlVORzwvc3Bhbj48aDI+V8Okcm1lICZhbXA7IFRlbXBlcmF0dXJlbjwvaDI+PHNtYWxsIGlkPSJkYXNoYm9hcmRDbGltYXRlWWVhciI+QWt0dWVsbGVzIEphaHI8L3NtYWxsPjwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBpZD0iZGFzaGJvYXJkQ2xpbWF0ZURldGFpbHNCdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5EZXRhaWxzIGFuc2VoZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBkYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzIiBpZD0iZGFzaGJvYXJkQ2xpbWF0ZU1ldHJpY3MiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRhc2hib2FyZC1jbGltYXRlLWNoYXJ0LXRvcCI+CiAgICAgICAgICA8c3Ryb25nPkxldHp0ZSBzZWNocyBNb25hdGU8L3N0cm9uZz4KICAgICAgICAgIDxkaXYgY2xhc3M9ImRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCIgcm9sZT0iZ3JvdXAiIGFyaWEtbGFiZWw9IktsaW1hLURpYWdyYW1tIj4KICAgICAgICAgICAgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJhY3RpdmUiIGRhdGEtZGFzaGJvYXJkLWNsaW1hdGUtbW9kZT0iaGVhdCIgYXJpYS1wcmVzc2VkPSJ0cnVlIj5Xw6RybWU8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGRhdGEtZGFzaGJvYXJkLWNsaW1hdGUtbW9kZT0idGVtcGVyYXR1cmUiIGFyaWEtcHJlc3NlZD0iZmFsc2UiPlRlbXBlcmF0dXJlbjwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBkYXNoYm9hcmQtY2xpbWF0ZS1jaGFydC13cmFwIj48Y2FudmFzIGlkPSJkYXNoYm9hcmRDbGltYXRlQ2hhcnQiIGFyaWEtbGFiZWw9IkhlaXp3w6RybWUgdW5kIFdpdHRlcnVuZ3NiZXJlaW5pZ3VuZyBkZXIgbGV0enRlbiBzZWNocyBNb25hdGUiPjwvY2FudmFzPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImRhc2hib2FyZENsaW1hdGVMZWdlbmQiIGNsYXNzPSJkYXNoYm9hcmQtY2xpbWF0ZS1sZWdlbmQiPjwvZGl2PgogICAgICAgIDxwIGlkPSJkYXNoYm9hcmRDbGltYXRlVHJlbmQiIGNsYXNzPSJkYXNoYm9hcmQtY2xpbWF0ZS10cmVuZCI+PC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImRhc2hib2FyZC1jbGltYXRlLWZvb3RlciI+CiAgICAgICAgICA8cCBpZD0iZGFzaGJvYXJkQ2xpbWF0ZVN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0IiByb2xlPSJzdGF0dXMiPjwvcD4KICAgICAgICAgIDxidXR0b24gaWQ9ImRhc2hib2FyZENsaW1hdGVXZWF0aGVyQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+V2V0dGVyZGF0ZW4gbGFkZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iY29uc3VtcHRpb25WaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImNvbnN1bXB0aW9uVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlZFUkJSQVVDSDwvc3Bhbj48aDEgaWQ9ImNvbnN1bXB0aW9uVGl0bGUiPk1vbmF0c3dlcnRlPC9oMT48cD5HZXNhbXQtIHVuZCBBbHRlbnRlaWwtVmVyYnJhdWNoIGVudHN0ZWhlbiBhdXMgZGVuIFrDpGhsZXJzdMOkbmRlbi4gV8Okcm1lcHVtcGUga29tbXQgYXVzIGRlciBteVZBSUxMQU5ULUNTVjsgU2NobGVlL0tsdXMgd2lyZCBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJhZGRSZWNvcmRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdG9vbGJhciI+PHN0cm9uZyBpZD0icmVjb3JkQ291bnQiPjAgTW9uYXRlPC9zdHJvbmc+PHNlbGVjdCBpZD0icmVjb3JkWWVhckZpbHRlciIgYXJpYS1sYWJlbD0iSmFociBmaWx0ZXJuIj48b3B0aW9uIHZhbHVlPSJhbGwiPkFsbGUgSmFocmU8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJyZWNvcmRMaXN0IiBjbGFzcz0icmVjb3JkLWxpc3QiPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJhbmFseXNpc1ZpZXciIGFyaWEtbGFiZWxsZWRieT0iYW5hbHlzaXNUaXRsZSI+CiAgICAgIDxkaXYgY2xhc3M9InBhZ2UtaGVhZCI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+QVVTV0VSVFVORzwvc3Bhbj48aDEgaWQ9ImFuYWx5c2lzVGl0bGUiPlZlcmJyYXVjaCB2ZXJzdGVoZW48L2gxPjxwPkphaHJlc3dlcnRlLCBBdWZ0ZWlsdW5nLCBLb3N0ZW4gdW5kIFfDpHJtZXB1bXBlbi1FZmZpemllbnouPC9wPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGZpbHRlci1wYW5lbCI+CiAgICAgICAgPGxhYmVsPkRldGFpbGphaHI8c2VsZWN0IGlkPSJhbmFseXNpc1llYXIiPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0iYW5hbHlzaXMtYWxsLXllYXJzLWhpbnQiPjxzdHJvbmc+TWVocmphaHJlc3ZlcmdsZWljaDwvc3Ryb25nPjxzcGFuPkFsbGUgdm9yaGFuZGVuZW4gSmFocmUgd2VyZGVuIGdlbWVpbnNhbSBkYXJnZXN0ZWxsdC4gVmVyZ2FuZ2VuZSBKYWhyZSBnZXN0cmljaGVsdCwgZGFzIGFrdHVlbGxlIEphaHIgZHVyY2hnZXpvZ2VuLjwvc3Bhbj48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0ibWV0cmljLWdyaWQgYW5hbHlzaXMtbWV0cmljcyIgaWQ9ImFuYWx5c2lzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkFVRlRFSUxVTkc8L3NwYW4+PGgyPlfDpHJtZXB1bXBlIMK3IEFsdGVudGVpbCDCtyBTY2hsZWUvS2x1czwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ibGVnZW5kIj48c3BhbiBjbGFzcz0iaGVhdCI+V8Okcm1lcHVtcGU8L3NwYW4+PHNwYW4gY2xhc3M9ImFubmV4Ij5BbHRlbnRlaWw8L3NwYW4+PHNwYW4gY2xhc3M9InJlc3QiPlNjaGxlZS9LbHVzPC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImFsbG9jYXRpb25DaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1FSFJKQUhSRVNWRVJHTEVJQ0g8L3NwYW4+PGgyPkdlc2FtdHZlcmJyYXVjaCBuYWNoIE1vbmF0ZW48L2gyPjwvZGl2PjwvZGl2PjxkaXYgaWQ9InllYXJDb21wYXJpc29uTGVnZW5kIiBjbGFzcz0ieWVhci1jb21wYXJpc29uLWxlZ2VuZCI+PC9kaXY+PGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBsYXJnZSI+PGNhbnZhcyBpZD0idG90YWxDaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJvc3Ryb21QcmljZVN0YXRzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTS1QUkVJU0U8L3NwYW4+PGgyPsOYIGtXaC1QcmVpcyDCtyBNb25hdCDCtyBRdWFydGFsIMK3IEphaHI8L2gyPjwvZGl2PjxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21QcmljZVN0YXRzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+T3N0cm9tLVByZWlzZSBha3R1YWxpc2llcmVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EZXIgQXJiZWl0c3ByZWlzIHdpcmQgYXVzIGRlbiB2b24gT3N0cm9tIGdlbGllZmVydGVuIFN0dW5kZW5wcmVpc2VuIHVuZCBkZWluZW0gdGF0c8OkY2hsaWNoZW4gT3N0cm9tLVZlcmJyYXVjaCB2ZXJicmF1Y2hzZ2V3aWNodGV0IGJlcmVjaG5ldC4gUXVhcnRhbHMtIHVuZCBKYWhyZXN3ZXJ0ZSBzaW5kIGRhaGVyIGtlaW4gZWluZmFjaGVyIE1pdHRlbHdlcnQgZGVyIE1vbmF0ZS48L3A+CiAgICAgICAgPHNlY3Rpb24gY2xhc3M9Im1ldHJpYy1ncmlkIGFuYWx5c2lzLW1ldHJpY3MiIGlkPSJvc3Ryb21QcmljZVN0YXRzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9Im9zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0IiBhcmlhLWxhYmVsPSJEdXJjaHNjaG5pdHRsaWNoZXIgT3N0cm9tLUFyYmVpdHNwcmVpcyBwcm8gTW9uYXQiPjwvY2FudmFzPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk1vbmF0PC90aD48dGg+w5ggQXJiZWl0c3ByZWlzPC90aD48dGg+RWZmZWt0aXYgaW5rbC4gRml4a29zdGVuPC90aD48dGg+T3N0cm9tLVZlcmJyYXVjaDwvdGg+PHRoPlN0YXR1czwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0ib3N0cm9tUHJpY2VTdGF0c1RhYmxlIj48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgICAgPHAgaWQ9Im9zdHJvbVByaWNlU3RhdHNTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+PC9wPgogICAgICA8L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9ImNsaW1hdGVBbmFseXNpc1BhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5XSVRURVJVTkdTQkVSRUlOSUdVTkc8L3NwYW4+PGgyPkhlaXp3w6RybWUgJiBXZXR0ZXI8L2gyPjwvZGl2PjxidXR0b24gY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiBpZD0ibG9hZENsaW1hdGVXZWF0aGVyQnRuIiB0eXBlPSJidXR0b24iPldldHRlcmRhdGVuIGxhZGVuPC9idXR0b24+PC9kaXY+PHAgY2xhc3M9Im11dGVkIj5IZWl6Z3JhZHRhZ2UgKEJhc2lzIDE1IMKwQyksIGdldHJlbm50ZSBIZWl6LSB1bmQgV2FybXdhc3NlcnfDpHJtZS4gVmVyZ2xlaWNoIGplIEthbGVuZGVybW9uYXQgbWl0IGRlbiBIZWl6Z3JhZHRhZ2VuIHZvbiAyMDI0IHVuZCAyMDI1LjwvcD48ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBhbmFseXNpcy1tZXRyaWNzIiBpZD0iY2xpbWF0ZU1ldHJpY3MiPjwvZGl2PjxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk1vbmF0PC90aD48dGg+w5ggV2V0dGVyIMKwQzwvdGg+PHRoPlZhaWxsYW50IGF1w59lbiDCsEM8L3RoPjx0aD5SYXVtIMKwQzwvdGg+PHRoPlNwZWljaGVyIMKwQzwvdGg+PHRoPkhHVDwvdGg+PHRoPkhlaXp3w6RybWUga1doPC90aD48dGg+V2FybXdhc3NlciBrV2g8L3RoPjx0aD5XaXR0ZXJ1bmdzYmVyZWluaWd0IGtXaDwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0iY2xpbWF0ZVJvd3MiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj48cCBpZD0iY2xpbWF0ZUluZm8iIGNsYXNzPSJzdGF0dXMtdGV4dCI+PC9wPjxkaXYgaWQ9ImNsaW1hdGVNdWx0aVllYXIiIGNsYXNzPSJjbGltYXRlLXllYXItY29tcGFyaXNvbiI+PC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5Nb25hdGxpY2hlIFN0cm9ta29zdGVuPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJjb3N0Q2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0iY29wUGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlfDhFJNRVBVTVBFPC9zcGFuPjxoMj5BcmJlaXRzemFobDwvaDI+PC9kaXY+PC9kaXY+PHAgY2xhc3M9Im11dGVkIj5XaXJkIG51ciBhdXMgTW9uYXRlbiBtaXQgZG9rdW1lbnRpZXJ0ZXIgZXJ6ZXVndGVyIFfDpHJtZSBiZXJlY2huZXQuPC9wPjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImNvcENoYXJ0Ij48L2NhbnZhcz48L2Rpdj48L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+TU9OQVRFPC9zcGFuPjxoMj5KYWhyZXPDvGJlcnNpY2h0PC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPkdlc2FtdDwvdGg+PHRoPldQPC90aD48dGg+QWx0ZW50ZWlsPC90aD48dGg+U2NobGVlL0tsdXM8L3RoPjx0aD5Lb3N0ZW48L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImFuYWx5c2lzVGFibGUiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj48L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJkYXRhVmlldyIgYXJpYS1sYWJlbGxlZGJ5PSJkYXRhVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkRBVEVOPC9zcGFuPjxoMSBpZD0iZGF0YVRpdGxlIj5CYWNrdXAgJiBFaW5zdGVsbHVuZ2VuPC9oMT48cD5aw6RobGVyc3TDpG5kZSwgbXlWQUlMTEFOVC1JbXBvcnQsIFNpY2hlcnVuZyB1bmQgT3N0cm9tLjwvcD48L2Rpdj48L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+REFURU5RVUFMSVTDhFQ8L3NwYW4+PGgyPk1vbmF0c3dlcnRlIHByw7xmZW48L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIGNvbXBhY3QtbWV0cmljcyIgaWQ9InF1YWxpdHlNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJxdWFsaXR5SXNzdWVzIiBjbGFzcz0iaXNzdWUtbGlzdCI+PC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KCgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJtZXRlclBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDI+R2VzYW10ICYgQWx0ZW50ZWlsPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJhZGRNZXRlckJ0biIgY2xhc3M9InByaW1hcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj4rIEVpbnRyYWdlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RHUgdHLDpGdzdCBudXIgZGllIGJlaWRlbiBha3R1ZWxsZW4gWsOkaGxlcnN0w6RuZGUgZWluLiBFbGRlaG9mIGJlcmVjaG5ldCBkYXJhdXMgYXV0b21hdGlzY2ggZGVuIE1vbmF0c3ZlcmJyYXVjaC4gQXVzZ2FuZ3NwdW5rdCBpc3QgZGVyIDAxLjEwLjIwMjYgbWl0IEdlc2FtdCAzNC4yNTUga1doIHVuZCBBbHRlbnRlaWwgOS4wNDUga1doLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBtZXRlci1sYXRlc3QiIGlkPSJtZXRlckxhdGVzdCI+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibWV0ZXJIaXN0b3J5IiBjbGFzcz0ibWV0ZXItaGlzdG9yeSI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyBtZXRlci1hY3Rpb25zIj48YnV0dG9uIGlkPSJ1bmRvTGF0ZXN0TWV0ZXJCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+TGV0enRlbiBaw6RobGVyc3RhbmQgenVyw7xja25laG1lbjwvYnV0dG9uPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJ2YWlsbGFudEltcG9ydFBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5Xw4RSTUVQVU1QRTwvc3Bhbj48aDI+bXlWQUlMTEFOVC1EYXRlbiBpbXBvcnRpZXJlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5Xw6RobGUgYXJvVEhFUk0gdW5kIHVuaVRPV0VSIGdlbWVpbnNhbSBvZGVyIGRpZSDDpGx0ZXJlIEVsZGVob2YtTW9uYXRzaW1wb3J0LUNTVi4gRGllIFRlbXBlcmF0dXJkYXRlaWVuIGF1cyBTeXN0ZW0sIFpvbmUgMCB1bmQgV2FybXdhc3NlcnNwZWljaGVyIGvDtm5uZW4genVzw6R0emxpY2ggb2RlciBlaW56ZWxuIGltcG9ydGllcnQgd2VyZGVuLiBOdXIgTW9uYXRzYWdncmVnYXRlIHdlcmRlbiBnZXNwZWljaGVydC4gWsOkaGxlcnN0w6RuZGUgdW5kIFByZWlzZSBibGVpYmVuIHVudmVyw6RuZGVydC48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpbGUtYnV0dG9uIHByaW1hcnkiPkNTVi1EYXRlaWVuIGF1c3fDpGhsZW48aW5wdXQgaWQ9InZhaWxsYW50Q3N2RmlsZXNJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSIuY3N2LHRleHQvY3N2LHRleHQvcGxhaW4iIG11bHRpcGxlIGhpZGRlbj48L2xhYmVsPgogICAgICAgIDwvZGl2PgogICAgICAgIDxwIGlkPSJ2YWlsbGFudEltcG9ydFN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij5Ob2NoIGtlaW5lIERhdGVpZW4gYXVzZ2V3w6RobHQuPC9wPgogICAgICA8L3NlY3Rpb24+CgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ic3luY1BhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5HRVLDhFRFLVNZTkM8L3NwYW4+PGgyPkF1ZiBhbGxlbiBHZXLDpHRlbiBha3R1ZWxsPC9oMj48L2Rpdj48c3BhbiBpZD0ic3luY0JhZGdlIiBjbGFzcz0ic3luYy1iYWRnZSI+bmljaHQgZWluZ2VyaWNodGV0PC9zcGFuPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RWxkZWhvZiBzeW5jaHJvbmlzaWVydCBNb25hdHN3ZXJ0ZSwgWsOkaGxlcnN0w6RuZGUsIGltcG9ydGllcnRlIFZhaWxsYW50LVdlcnRlIHVuZCBiZXJlY2huZXRlIE9zdHJvbS1Lb3N0ZW4gdmVyc2NobMO8c3NlbHQgw7xiZXIgZGVuIGJlc3RlaGVuZGVuIENsb3VkZmxhcmUtVHJlc29yLiBOYWNoIGVpbmVyIMOEbmRlcnVuZyB3aXJkIGF1dG9tYXRpc2NoIGhvY2hnZWxhZGVuOyBiZWltIMOWZmZuZW4gb2RlciBadXLDvGNra2VocmVuIGluIGRpZSBBcHAgd2lyZCBhdXRvbWF0aXNjaCBkZXIgbmV1ZXN0ZSBTdGFuZCBnZWxhZGVuLjwvcD4KICAgICAgICA8ZGl2IGlkPSJzeW5jU2V0dXBCb3giPgogICAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkRpZXNlcyBHZXLDpHQgYmVuZW5uZW48aW5wdXQgaWQ9InN5bmNDcmVhdGVEZXZpY2VOYW1lIiB0eXBlPSJ0ZXh0IiBtYXhsZW5ndGg9IjYwIiBwbGFjZWhvbGRlcj0iei4gQi4gaVBhZCBLw7xjaGUiPjwvbGFiZWw+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPjxidXR0b24gaWQ9InN5bmNDcmVhdGVCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkdlcsOkdGUtU3luYyBlaW5yaWNodGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgICA8ZGV0YWlscyBjbGFzcz0ic3luYy1qb2luLWJveCI+PHN1bW1hcnk+RGllc2VzIEdlcsOkdCBtaXQgYmVzdGVoZW5kZW0gRWxkZWhvZiBrb3BwZWxuPC9zdW1tYXJ5PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJzZXR0aW5ncy1ncmlkIj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5UcmVzb3ItSUQ8aW5wdXQgaWQ9InN5bmNKb2luVmF1bHRJZCIgdHlwZT0idGV4dCIgYXV0b2NvbXBsZXRlPSJvZmYiPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+S29wcGx1bmdzY29kZTxpbnB1dCBpZD0ic3luY0pvaW5Db2RlIiB0eXBlPSJ0ZXh0IiBhdXRvY29tcGxldGU9Im9uZS10aW1lLWNvZGUiIHBsYWNlaG9sZGVyPSJYWFhYLVhYWFgtWFhYWCI+PC9sYWJlbD4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5XaWVkZXJoZXJzdGVsbHVuZ3NzY2hsw7xzc2VsPHRleHRhcmVhIGlkPSJzeW5jSm9pblJlY292ZXJ5IiByb3dzPSIzIiBhdXRvY29tcGxldGU9Im9mZiI+PC90ZXh0YXJlYT48L2xhYmVsPgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkRpZXNlcyBHZXLDpHQgYmVuZW5uZW48aW5wdXQgaWQ9InN5bmNKb2luRGV2aWNlTmFtZSIgdHlwZT0idGV4dCIgbWF4bGVuZ3RoPSI2MCIgcGxhY2Vob2xkZXI9InouIEIuIGlQaG9uZSI+PC9sYWJlbD4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxidXR0b24gaWQ9InN5bmNKb2luQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5HZXLDpHQga29wcGVsbjwvYnV0dG9uPgogICAgICAgICAgPC9kZXRhaWxzPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9InN5bmNBY3RpdmVCb3giIGNsYXNzPSJoaWRkZW4iPgogICAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQgc3luYy1tZXRyaWNzIj4KICAgICAgICAgICAgPGFydGljbGU+PHNwYW4+R2Vyw6R0PC9zcGFuPjxzdHJvbmcgaWQ9InN5bmNEZXZpY2VUZXh0Ij7igJM8L3N0cm9uZz48c21hbGwgaWQ9InN5bmNSb2xlVGV4dCI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPlRyZXNvci1WZXJzaW9uPC9zcGFuPjxzdHJvbmcgaWQ9InN5bmNSZXZpc2lvblRleHQiPjA8L3N0cm9uZz48c21hbGwgaWQ9InN5bmNMYXN0VGV4dCI+bm9jaCBuaWU8L3NtYWxsPjwvYXJ0aWNsZT4KICAgICAgICAgICAgPGFydGljbGU+PHNwYW4+QXV0b21hdGlrPC9zcGFuPjxzdHJvbmc+YWt0aXY8L3N0cm9uZz48c21hbGw+YmVpIEFwcC1TdGFydCwgUsO8Y2trZWhyIHVuZCBuYWNoIMOEbmRlcnVuZ2VuPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPjxidXR0b24gaWQ9InN5bmNOb3dCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkpldHp0IHN5bmNocm9uaXNpZXJlbjwvYnV0dG9uPjxidXR0b24gaWQ9InN5bmNQYWlyQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPk5ldWVzIEdlcsOkdCBrb3BwZWxuPC9idXR0b24+PGJ1dHRvbiBpZD0ic3luY0Rpc2Nvbm5lY3RCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+RGllc2VzIEdlcsOkdCB0cmVubmVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgICA8ZGl2IGlkPSJzeW5jUGFpclJlc3VsdCIgY2xhc3M9InN5bmMtcGFpci1yZXN1bHQgaGlkZGVuIj48c3Ryb25nPktvcHBsdW5nc2RhdGVuIGbDvHIgZGFzIG5ldWUgR2Vyw6R0PC9zdHJvbmc+PHNwYW4+VHJlc29yLUlEPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpclZhdWx0Ij7igJM8L2NvZGU+PHNwYW4+Q29kZSAoMTAgTWludXRlbik8L3NwYW4+PGNvZGUgaWQ9InN5bmNQYWlyQ29kZSI+4oCTPC9jb2RlPjxzcGFuPldpZWRlcmhlcnN0ZWxsdW5nc3NjaGzDvHNzZWw8L3NwYW4+PGNvZGUgaWQ9InN5bmNQYWlyUmVjb3ZlcnkiPuKAkzwvY29kZT48c21hbGwgaWQ9InN5bmNQYWlyRXhwaXJ5Ij48L3NtYWxsPjwvZGl2PgogICAgICAgICAgPHAgaWQ9InN5bmNTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+PC9wPgogICAgICAgIDwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlNJQ0hFUlVORzwvc3Bhbj48aDI+UHJpdmF0ZXMgQmFja3VwPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkRhcyBwcml2YXRlIEJhY2t1cCBlbnRow6RsdCBkZWluZSBWZXJicmF1Y2hzZGF0ZW4gdW5kIOKAkyBzb2Zlcm4gZ2VzcGVpY2hlcnQg4oCTIGF1Y2ggZGVuIE9zdHJvbS1BcHAtU2NobMO8c3NlbC4gTmljaHQgw7ZmZmVudGxpY2ggaG9jaGxhZGVuLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij4KICAgICAgICAgIDxidXR0b24gaWQ9ImV4cG9ydEJhY2t1cEJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+QmFja3VwIGV4cG9ydGllcmVuPC9idXR0b24+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpbGUtYnV0dG9uIHNlY29uZGFyeSI+QmFja3VwIGltcG9ydGllcmVuPGlucHV0IGlkPSJpbXBvcnRCYWNrdXBJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSJhcHBsaWNhdGlvbi9qc29uLC5qc29uIiBoaWRkZW4+PC9sYWJlbD4KICAgICAgICAgIDxidXR0b24gaWQ9ImV4cG9ydENzdkJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5DU1YgZXhwb3J0aWVyZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0iYmFja3VwU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ib3N0cm9tU2V0dGluZ3NQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+T1NUUk9NPC9zcGFuPjxoMj5QcmVpc8O8YmVyc2ljaHQgdmVyYmluZGVuPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5FbGRlaG9mLUFwcC1TY2hsw7xzc2VsPGlucHV0IGlkPSJvc3Ryb21BcHBLZXlJbnB1dCIgdHlwZT0icGFzc3dvcmQiIGF1dG9jb21wbGV0ZT0ib2ZmIiBwbGFjZWhvbGRlcj0iQXBwLVNjaGzDvHNzZWwiPjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5aZWl0ZmVuc3RlcjxzZWxlY3QgaWQ9InByZWZlcnJlZFdpbmRvd0hvdXJzSW5wdXQiPjxvcHRpb24gdmFsdWU9IjEiPjEgU3R1bmRlPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iMiI+MiBTdHVuZGVuPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iMyI+MyBTdHVuZGVuPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iNCI+NCBTdHVuZGVuPC9vcHRpb24+PC9zZWxlY3Q+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0ic3dpdGNoLXJvdyI+PGlucHV0IGlkPSJvc3Ryb21BdXRvUmVmcmVzaElucHV0IiB0eXBlPSJjaGVja2JveCI+PHNwYW4+QXV0b21hdGlzY2ggYWxsZSAxMCBNaW51dGVuIGFrdHVhbGlzaWVyZW48L3NwYW4+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzYXZlT3N0cm9tQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5TcGVpY2hlcm4gJiBwcsO8ZmVuPC9idXR0b24+PGJ1dHRvbiBpZD0icmVmcmVzaE9zdHJvbUhpc3RvcnlCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+SGlzdG9yaXNjaGUgUHJlaXNlIGxhZGVuPC9idXR0b24+PGJ1dHRvbiBpZD0iZGlzY29ubmVjdE9zdHJvbUJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5WZXJiaW5kdW5nIGVudGZlcm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGlkPSJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgICA8cCBpZD0ib3N0cm9tSGlzdG9yeVN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij5IaXN0b3Jpc2NoZSBQcmVpc2Ugbm9jaCBuaWNodCBnZXByw7xmdC48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5GYWxsYmFjay1XZXJ0ZTwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BcmJlaXRzcHJlaXMg4oKsL2tXaDxpbnB1dCBpZD0iZmFsbGJhY2tQcmljZUlucHV0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5Nb25hdGxpY2hlIEZpeGtvc3RlbiDigqw8aW5wdXQgaWQ9ImRlZmF1bHRCYXNlRmVlSW5wdXQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAxIj48L2xhYmVsPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9InNhdmVDb3N0U2V0dGluZ3NCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuPC9idXR0b24+CiAgICAgIDwvc2VjdGlvbj4KICAgIDwvc2VjdGlvbj4KICA8L21haW4+CgogIDxuYXYgY2xhc3M9ImJvdHRvbS1uYXYiIGFyaWEtbGFiZWw9IkhhdXB0bmF2aWdhdGlvbiI+CiAgICA8YnV0dG9uIGNsYXNzPSJhY3RpdmUiIGRhdGEtbmF2PSJkYXNoYm9hcmRWaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKMgjwvc3Bhbj7DnGJlcnNpY2h0PC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtbmF2PSJjb25zdW1wdGlvblZpZXciIHR5cGU9ImJ1dHRvbiI+PHNwYW4+4pakPC9zcGFuPlZlcmJyYXVjaDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iYW5hbHlzaXNWaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKWpTwvc3Bhbj5BdXN3ZXJ0dW5nPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtbmF2PSJkYXRhVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7impk8L3NwYW4+RGF0ZW48L2J1dHRvbj4KICA8L25hdj4KPC9kaXY+Cgo8ZGl2IGlkPSJyZWNvcmRNb2RhbCIgY2xhc3M9Im1vZGFsIGhpZGRlbiIgcm9sZT0iZGlhbG9nIiBhcmlhLW1vZGFsPSJ0cnVlIiBhcmlhLWxhYmVsbGVkYnk9InJlY29yZE1vZGFsVGl0bGUiPgogIDxkaXYgY2xhc3M9Im1vZGFsLWJhY2tkcm9wIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbD48L2Rpdj4KICA8Zm9ybSBjbGFzcz0ibW9kYWwtY2FyZCIgaWQ9InJlY29yZEZvcm0iPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+TU9OQVQgQkVBUkJFSVRFTjwvc3Bhbj48aDIgaWQ9InJlY29yZE1vZGFsVGl0bGUiPk1vbmF0IGJlYXJiZWl0ZW48L2gyPjwvZGl2PjxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iaWNvbi1idXR0b24iIGRhdGEtY2xvc2UtcmVjb3JkLW1vZGFsIGFyaWEtbGFiZWw9IlNjaGxpZcOfZW4iPsOXPC9idXR0b24+PC9kaXY+CiAgICA8aW5wdXQgaWQ9ImVkaXRpbmdNb250aE9yaWdpbmFsIiB0eXBlPSJoaWRkZW4iPgogICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+TW9uYXQ8aW5wdXQgaWQ9InJlY29yZE1vbnRoIiB0eXBlPSJtb250aCIgcmVhZG9ubHk+PC9sYWJlbD4KICAgICAgPHNwYW4+PC9zcGFuPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5HZXNhbXR2ZXJicmF1Y2gga1doPGlucHV0IGlkPSJyZWNvcmRUb3RhbCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkFsdGVudGVpbCBrV2g8aW5wdXQgaWQ9InJlY29yZEFubmV4IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+V8Okcm1lcHVtcGUga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0UHVtcCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPsOYIFN0cm9tcHJlaXMgY3Qva1doPGlucHV0IGlkPSJyZWNvcmRQcmljZUN0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+Rml4a29zdGVuIOKCrDxpbnB1dCBpZD0icmVjb3JkQmFzZUZlZSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0iZGVyaXZlZFByZXZpZXciIGNsYXNzPSJkZXJpdmVkLXByZXZpZXciPlNjaGxlZS9LbHVzOiDigJM8L2Rpdj4KICAgIDxwIGlkPSJyZWNvcmRTb3VyY2VIaW50IiBjbGFzcz0ibXV0ZWQgY29tcGFjdC1ub3RlIj48L3A+CiAgICA8ZGV0YWlscyBjbGFzcz0iZGV0YWlscy1jYXJkIj48c3VtbWFyeT5Xw6RybWVwdW1wZW4tRGV0YWlscyAob3B0aW9uYWwpPC9zdW1tYXJ5PjxkaXYgY2xhc3M9ImZvcm0tZ3JpZCBkZXRhaWwtZ3JpZCI+PGxhYmVsIGNsYXNzPSJmaWVsZCI+RXJ6ZXVndGUgV8Okcm1lIGtXaDxpbnB1dCBpZD0icmVjb3JkSGVhdEdlbmVyYXRlZCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPkhlaXpzdHJvbSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPldhcm13YXNzZXJzdHJvbSBrV2g8aW5wdXQgaWQ9InJlY29yZERod0VsZWN0cmljaXR5IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PGxhYmVsIGNsYXNzPSJmaWVsZCI+SGVpenfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRpbmdIZWF0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PGxhYmVsIGNsYXNzPSJmaWVsZCI+V2FybXdhc3NlcnfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZERod0hlYXQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48L2Rpdj48L2RldGFpbHM+CiAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5Ob3Rpejx0ZXh0YXJlYSBpZD0icmVjb3JkTm90ZSIgcm93cz0iMyIgbWF4bGVuZ3RoPSI4MDAiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgIDxwIGlkPSJyZWNvcmRWYWxpZGF0aW9uIiBjbGFzcz0idmFsaWRhdGlvbi10ZXh0Ij48L3A+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj48c3BhbiBjbGFzcz0ic3BhY2VyIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iIGRhdGEtY2xvc2UtcmVjb3JkLW1vZGFsPkFiYnJlY2hlbjwvYnV0dG9uPjxidXR0b24gY2xhc3M9InByaW1hcnkiIHR5cGU9InN1Ym1pdCI+w4RuZGVydW5nZW4gc3BlaWNoZXJuPC9idXR0b24+PC9kaXY+CiAgPC9mb3JtPgo8L2Rpdj4KCjxkaXYgaWQ9Im1ldGVyTW9kYWwiIGNsYXNzPSJtb2RhbCBoaWRkZW4iIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbGxlZGJ5PSJtZXRlck1vZGFsVGl0bGUiPgogIDxkaXYgY2xhc3M9Im1vZGFsLWJhY2tkcm9wIiBkYXRhLWNsb3NlLW1ldGVyLW1vZGFsPjwvZGl2PgogIDxmb3JtIGNsYXNzPSJtb2RhbC1jYXJkIiBpZD0ibWV0ZXJGb3JtIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlrDhEhMRVJTVMOETkRFPC9zcGFuPjxoMiBpZD0ibWV0ZXJNb2RhbFRpdGxlIj5OZXVlIEFibGVzdW5nPC9oMj48L2Rpdj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imljb24tYnV0dG9uIiBkYXRhLWNsb3NlLW1ldGVyLW1vZGFsIGFyaWEtbGFiZWw9IlNjaGxpZcOfZW4iPsOXPC9idXR0b24+PC9kaXY+CiAgICA8cCBpZD0ibWV0ZXJQcmV2aW91cyIgY2xhc3M9Im1ldGVyLXByZXZpb3VzIj48L3A+CiAgICA8cCBpZD0ibWV0ZXJUYXJnZXRNb250aCIgY2xhc3M9Im11dGVkIj48L3A+CiAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BYmxlc2VkYXR1bTxpbnB1dCBpZD0ibWV0ZXJEYXRlIiB0eXBlPSJkYXRlIiByZXF1aXJlZD48L2xhYmVsPgogICAgICA8c3Bhbj48L3NwYW4+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkdlc2FtdC1aw6RobGVyc3RhbmQga1doPGlucHV0IGlkPSJtZXRlclRvdGFsIiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2g8aW5wdXQgaWQ9Im1ldGVyQW5uZXgiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIiByZXF1aXJlZD48L2xhYmVsPgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJtZXRlclByZXZpZXciIGNsYXNzPSJkZXJpdmVkLXByZXZpZXciPk1vbmF0c3ZlcmJyw6R1Y2hlIHdlcmRlbiBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9kaXY+CiAgICA8cCBjbGFzcz0ibXV0ZWQgY29tcGFjdC1ub3RlIj5EaWUgV8Okcm1lcHVtcGUgd2lyZCBuaWNodCBoaWVyIGVpbmdldHJhZ2VuLiBTaWUga29tbXQgYXVzc2NobGllw59saWNoIGF1cyBkZW0gbXlWQUlMTEFOVC1DU1YtSW1wb3J0LjwvcD4KICAgIDxwIGlkPSJtZXRlclZhbGlkYXRpb24iIGNsYXNzPSJ2YWxpZGF0aW9uLXRleHQiPjwvcD4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWFjdGlvbnMiPjxzcGFuIGNsYXNzPSJzcGFjZXIiPjwvc3Bhbj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbD5BYmJyZWNoZW48L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJzdWJtaXQiPlrDpGhsZXJzdMOkbmRlIHNwZWljaGVybjwvYnV0dG9uPjwvZGl2PgogIDwvZm9ybT4KPC9kaXY+Cgo8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9InRvYXN0IGhpZGRlbiIgcm9sZT0ic3RhdHVzIiBhcmlhLWxpdmU9InBvbGl0ZSI+PC9kaXY+CjxzY3JpcHQgc3JjPSJhcHAuanM/dj02LjMuMiI+PC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=","type":"text/html; charset=utf-8","cache":"no-cache"},"/styles.css":{"body":"OnJvb3R7CiAgY29sb3Itc2NoZW1lOmRhcms7CiAgLS1iZzojMDYxMDFjOwogIC0tcGFuZWw6IzBjMWEyYTsKICAtLXBhbmVsMjojMTAyMjM1OwogIC0tbGluZTpyZ2JhKDE3MSwxOTgsMjIwLC4xNCk7CiAgLS10ZXh0OiNmNGY4ZmI7CiAgLS1tdXRlZDojOTRhOGJhOwogIC0tZ3JlZW46IzcyZGM1NzsKICAtLW9yYW5nZTojZmY5ZjQzOwogIC0tYmx1ZTojNGQ5Y2ZmOwogIC0teWVsbG93OiNmMmQxNWY7CiAgLS1yZWQ6I2ZmNmI2YjsKICAtLXNoYWRvdzowIDE4cHggNTVweCByZ2JhKDAsMCwwLC4yNCk7CiAgLS1yYWRpdXM6MjBweDsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbHtiYWNrZ3JvdW5kOnZhcigtLWJnKTttaW4taGVpZ2h0OjEwMCU7Zm9udC1mYW1pbHk6SW50ZXIsLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixzYW5zLXNlcmlmOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQpib2R5e21hcmdpbjowO2JhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCB0b3AgcmlnaHQscmdiYSg2MCwxMjAsMTcwLC4xMCksdHJhbnNwYXJlbnQgMzUlKSx2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7bWluLWhlaWdodDoxMDB2aH0KYnV0dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXR9CmJ1dHRvbntjdXJzb3I6cG9pbnRlcn0KYnV0dG9uOmRpc2FibGVke29wYWNpdHk6LjQ4O2N1cnNvcjpub3QtYWxsb3dlZH0KLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQouYXBwLXNoZWxse21heC13aWR0aDoxMTgwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjAgMjJweCAxMTJweH0KLnRvcGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6Y2FsYygxNnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKSAwIDE4cHg7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MzA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQodG8gYm90dG9tLHJnYmEoNiwxNiwyOCwuOTgpLHJnYmEoNiwxNiwyOCwuODYpLHJnYmEoNiwxNiwyOCwwKSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCl9Ci5icmFuZHtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0Ojg1MDtsZXR0ZXItc3BhY2luZzotLjAzZW19LmJyYW5kLW1hcmt7ZGlzcGxheTppbmxpbmUtZ3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6MzZweDtoZWlnaHQ6MzZweDtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxZTYzMzMsIzJmOGU0OSk7Ym94LXNoYWRvdzowIDZweCAyNHB4IHJnYmEoNTMsMTkwLDkxLC4xOCl9Ci5zdWJ0aXRsZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWxlZnQ6NDZweDttYXJnaW4tdG9wOi00cHh9LmJ1aWxkLXBpbGx7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4xMik7Y29sb3I6I2I5ZjVhYTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTE0LDIyMCw4NywuMjIpO3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLXJhZGl1czo5OTlweH0KbWFpbntkaXNwbGF5OmJsb2NrfS52aWV3e2Rpc3BsYXk6bm9uZTthbmltYXRpb246ZmFkZSAuMThzIGVhc2V9LnZpZXcuYWN0aXZle2Rpc3BsYXk6YmxvY2t9QGtleWZyYW1lcyBmYWRle2Zyb217b3BhY2l0eTouNTt0cmFuc2Zvcm06dHJhbnNsYXRlWSg0cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5wYWdlLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDoyMnB4O21hcmdpbjoxOHB4IDAgMjRweH0ucGFnZS1oZWFkIGgxe2ZvbnQtc2l6ZTpjbGFtcCgyOHB4LDV2dyw0NHB4KTttYXJnaW46M3B4IDAgN3B4O2xpbmUtaGVpZ2h0OjEuMDU7bGV0dGVyLXNwYWNpbmc6LS4wNGVtfS5wYWdlLWhlYWQgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7bWF4LXdpZHRoOjY4MHB4O2xpbmUtaGVpZ2h0OjEuNX0uZXllYnJvd3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xNmVtO2ZvbnQtd2VpZ2h0Ojg1MDtjb2xvcjojN2Y5ZGI0O21hcmdpbi1ib3R0b206NXB4fQoucGFuZWx7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHJnYmEoMTUsMzEsNDgsLjk2KSxyZ2JhKDEwLDI0LDM5LC45OCkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjE4cHg7Ym94LXNoYWRvdzp2YXIoLS1zaGFkb3cpfQoucGFuZWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE4cHh9LnBhbmVsLWhlYWQgaDJ7bWFyZ2luOjJweCAwIDJweDtmb250LXNpemU6MjFweDtsZXR0ZXItc3BhY2luZzotLjAyNWVtfS5wYW5lbC1oZWFkIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0KLnByaW1hcnksLnNlY29uZGFyeSwuZGFuZ2VyLC5maWxlLWJ1dHRvbnthcHBlYXJhbmNlOm5vbmU7Ym9yZGVyLXJhZGl1czoxM3B4O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnQ7cGFkZGluZzoxMXB4IDE1cHg7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLXRleHQpO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjhweDt0ZXh0LWRlY29yYXRpb246bm9uZTttaW4taGVpZ2h0OjQ0cHh9LnByaW1hcnl7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyZjhlNDksIzFmNmMzOCk7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMjgpO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDQ0LDE2MSw3NywuMTgpfS5wcmltYXJ5OmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMDYpfS5zZWNvbmRhcnksLmZpbGUtYnV0dG9ue2JhY2tncm91bmQ6IzEyMjYzYTtib3JkZXItY29sb3I6cmdiYSgxNzAsMjAwLDIyNCwuMTQpO2NvbG9yOiNkY2U5ZjN9LnNlY29uZGFyeTpob3ZlciwuZmlsZS1idXR0b246aG92ZXJ7YmFja2dyb3VuZDojMTczMDQ5fS5kYW5nZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xMCk7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjI1KTtjb2xvcjojZmZhYWE5fS5jb21wYWN0e21pbi1oZWlnaHQ6MzZweDtwYWRkaW5nOjhweCAxMXB4O2ZvbnQtc2l6ZToxM3B4fS5pY29uLWJ1dHRvbntib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjOWQ3ZTI7Zm9udC1zaXplOjMwcHg7bGluZS1oZWlnaHQ6MTtwYWRkaW5nOjAgNnB4fQoubWV0cmljLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNSxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxNnB4O21pbi13aWR0aDowfS5tZXRyaWMtZ3JpZCBhcnRpY2xlIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbTo3cHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZTpjbGFtcCgxOXB4LDN2dywyNnB4KTtsaW5lLWhlaWdodDoxLjE7ZGlzcGxheTpibG9jazt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Lm1ldHJpYy1ncmlkIGFydGljbGUgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojN2Y5NmFhO2ZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NnB4O2xpbmUtaGVpZ2h0OjEuMzV9LmNvbXBhcmlzb24tbGluZXttYXJnaW46MTVweCAwIDA7Y29sb3I6I2I4YzhkNTtmb250LXNpemU6MTNweH0uY29tcGFyaXNvbi1saW5lLnBvc2l0aXZle2NvbG9yOiNmZmIxYTh9LmNvbXBhcmlzb24tbGluZS5uZWdhdGl2ZXtjb2xvcjojYTVlNjlhfS5jb21wYXJpc29uLWxpbmUubmV1dHJhbHtjb2xvcjojYjhjOGQ1fQoub3N0cm9tLXBhbmVse292ZXJmbG93OmhpZGRlbn0ub3N0cm9tLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ucHJpY2UtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMGIxYjJiO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MThweH0ucHJpY2UtY2FyZDpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowIGF1dG8gMCAwO3dpZHRoOjRweDtiYWNrZ3JvdW5kOiM2ZDg1OTl9LnByaWNlLWNhcmQuYmVzdDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ncmVlbil9LnByaWNlLWNhcmQud29yc3Q6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tcmVkKX0ucHJpY2UtY2FyZC5jdXJyZW50OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLWJsdWUpfS5wcmljZS1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9LnByaWNlLWNhcmQgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjI3cHg7bWFyZ2luOjhweCAwIDRweH0ucHJpY2UtY2FyZCBzbWFsbHtjb2xvcjojOWNiMGMwfS5lbXB0eS1zdGF0ZXtib3JkZXI6MXB4IGRhc2hlZCByZ2JhKDE3MCwyMDAsMjI0LC4yKTtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjAyKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6OXB4IDE0cHg7YWxpZ24taXRlbXM6Y2VudGVyfS5lbXB0eS1zdGF0ZSBzdHJvbmd7d2lkdGg6MTAwJX0uZW1wdHktc3RhdGUgc3Bhbntjb2xvcjp2YXIoLS1tdXRlZCk7ZmxleDoxO21pbi13aWR0aDoyMDBweH0ucHJpY2UtY2hhcnQtd3JhcHttYXJnaW4tdG9wOjE2cHh9Ci5jaGFydC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDoyNjBweDt3aWR0aDoxMDAlO21pbi13aWR0aDowfS5jaGFydC13cmFwLmxhcmdle2hlaWdodDozNDBweH0uY2hhcnQtd3JhcCBjYW52YXN7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtkaXNwbGF5OmJsb2NrfS5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjI2MHB4fS5sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNXB4O21hcmdpbjotNnB4IDAgMTRweDtjb2xvcjojYjhjNmQyO2ZvbnQtc2l6ZToxMnB4fS5sZWdlbmQgc3BhbjpiZWZvcmV7Y29udGVudDoiIjtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjNweDttYXJnaW4tcmlnaHQ6NnB4fS5sZWdlbmQgLmhlYXQ6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tb3JhbmdlKX0ubGVnZW5kIC5hbm5leDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ibHVlKX0ubGVnZW5kIC5yZXN0OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyl9Ci5yZWNvcmQtdG9vbGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MTRweH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0LC5maWx0ZXItcGFuZWwgc2VsZWN0e2JhY2tncm91bmQ6IzBiMWEyYTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEwcHggMTJweH0ucmVjb3JkLWxpc3R7ZGlzcGxheTpncmlkO2dhcDoxMHB4fS5yZWNvcmQtcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6bWlubWF4KDE1MHB4LDEuM2ZyKSByZXBlYXQoNCxtaW5tYXgoOTBweCwuODVmcikpIGF1dG87Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGExOTI4O2JvcmRlci1yYWRpdXM6MTVweDtwYWRkaW5nOjEzcHggMTRweH0ucmVjb3JkLXJvdzpob3ZlcntiYWNrZ3JvdW5kOiMwZTIwMzJ9LnJlY29yZC1tb250aCBzdHJvbmd7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTVweH0ucmVjb3JkLW1vbnRoIHNtYWxse2Rpc3BsYXk6YmxvY2s7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6M3B4fS5yZWNvcmQtdmFsdWUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOiM3Zjk2YWE7Zm9udC1zaXplOjEwcHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wOGVtfS5yZWNvcmQtdmFsdWUgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kfS5yZWNvcmQtcm93LmludmFsaWR7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjMpfQouZmlsdGVyLXBhbmVse2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczplbmR9LmZpbHRlci1wYW5lbCBsYWJlbHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWluLXdpZHRoOjE1MHB4fS5hbmFseXNpcy1tZXRyaWNze21hcmdpbi1ib3R0b206MThweH0uYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDUsbWlubWF4KDAsMWZyKSl9Ci50YWJsZS1zY3JvbGx7b3ZlcmZsb3c6YXV0bztib3JkZXItcmFkaXVzOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzIwcHh9dGgsdGR7cGFkZGluZzoxMnB4IDEzcHg7dGV4dC1hbGlnbjpyaWdodDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmb250LXNpemU6MTNweH10aDpmaXJzdC1jaGlsZCx0ZDpmaXJzdC1jaGlsZHt0ZXh0LWFsaWduOmxlZnR9dGh7Zm9udC1zaXplOjExcHg7Y29sb3I6Izg4YTBiNTtsZXR0ZXItc3BhY2luZzouMDVlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7YmFja2dyb3VuZDojMGExOTI4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MH10Ym9keSB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLmNvbXBhY3QtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSl9Lmlzc3VlLWxpc3R7ZGlzcGxheTpncmlkO2dhcDo4cHg7bWFyZ2luLXRvcDoxNHB4fS5pc3N1ZXtkaXNwbGF5OmZsZXg7Z2FwOjEycHg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTJweCAxM3B4O2JvcmRlci1yYWRpdXM6MTNweDtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0uaXNzdWUud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yMil9Lmlzc3VlLmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4yNSl9Lmlzc3VlIGRpdnttaW4td2lkdGg6MH0uaXNzdWUgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEzcHh9Lmlzc3VlIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6M3B4fS5tdXRlZHtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS41NX0uYWN0aW9uLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5zdGF0dXMtdGV4dHttaW4taGVpZ2h0OjEuNGVtO21hcmdpbjoxMnB4IDAgMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHh9LnN0YXR1cy10ZXh0Lm9re2NvbG9yOiNhNWU2OWF9LnN0YXR1cy10ZXh0LmVycm9ye2NvbG9yOiNmZmFhYTl9LnNldHRpbmdzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTNweDttYXJnaW46MTRweCAwfS5maWVsZHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjojOWRiMGMwO2ZvbnQtc2l6ZToxMnB4fS5maWVsZCBpbnB1dCwuZmllbGQgc2VsZWN0LC5maWVsZCB0ZXh0YXJlYXt3aWR0aDoxMDAlO2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTcxLDE5OCwyMjAsLjE2KTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEycHg7b3V0bGluZTpub25lfS5maWVsZCBpbnB1dDpmb2N1cywuZmllbGQgc2VsZWN0OmZvY3VzLC5maWVsZCB0ZXh0YXJlYTpmb2N1c3tib3JkZXItY29sb3I6cmdiYSg3NywxNTYsMjU1LC41NSk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NywxNTYsMjU1LC4wOCl9LnN3aXRjaC1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjExcHggMTNweDtjb2xvcjojYzdkNWRmfS5zd2l0Y2gtcm93IGlucHV0e3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7YWNjZW50LWNvbG9yOiMzYzlhNTN9Ci5iYW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTZweDttYXJnaW46MTJweCAwIDE4cHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxNXB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGQyMDMyfS5iYW5uZXIud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yOCk7YmFja2dyb3VuZDpyZ2JhKDI0MiwyMDksOTUsLjA2KX0uYmFubmVyIHN0cm9uZywuYmFubmVyIHNwYW57ZGlzcGxheTpibG9ja30uYmFubmVyIHNwYW57Y29sb3I6I2IzYzBjYTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjNweH0KLmJvdHRvbS1uYXZ7cG9zaXRpb246Zml4ZWQ7ei1pbmRleDo0MDtsZWZ0OjUwJTtib3R0b206bWF4KDEycHgsZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7d2lkdGg6bWluKDYyMHB4LGNhbGMoMTAwJSAtIDI0cHgpKTtiYWNrZ3JvdW5kOnJnYmEoOCwyMCwzMywuOTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTYpO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjdweDtib3gtc2hhZG93OjAgMTZweCA1MHB4IHJnYmEoMCwwLDAsLjQyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxNnB4KX0uYm90dG9tLW5hdiBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojODU5OWFhO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjlweCA4cHg7ZGlzcGxheTpncmlkO2dhcDozcHg7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MDttaW4td2lkdGg6MH0uYm90dG9tLW5hdiBidXR0b24gc3Bhbntmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfS5ib3R0b20tbmF2IGJ1dHRvbi5hY3RpdmV7YmFja2dyb3VuZDojMTUzMTQ3O2NvbG9yOiNmNGY4ZmJ9Ci5tb2RhbHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7cGFkZGluZzoxOHB4fS5tb2RhbC1iYWNrZHJvcHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNzIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDVweCl9Lm1vZGFsLWNhcmR7cG9zaXRpb246cmVsYXRpdmU7d2lkdGg6bWluKDc2MHB4LDEwMCUpO21heC1oZWlnaHQ6Y2FsYygxMDB2aCAtIDM2cHgpO292ZXJmbG93OmF1dG87YmFja2dyb3VuZDojMGIxYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTgpO2JvcmRlci1yYWRpdXM6MjJweDtwYWRkaW5nOjIycHg7Ym94LXNoYWRvdzowIDMwcHggOTBweCByZ2JhKDAsMCwwLC41NSl9Lm1vZGFsLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxOHB4fS5tb2RhbC1oZWFkIGgye21hcmdpbjoycHggMCAwfS5mb3JtLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0uZGVyaXZlZC1wcmV2aWV3e21hcmdpbjoxNHB4IDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTJweCAxNHB4O2ZvbnQtd2VpZ2h0OjgwMH0uZGVyaXZlZC1wcmV2aWV3LmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zNSk7Y29sb3I6I2ZmYWFhOX0uZGV0YWlscy1jYXJke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbjoxMnB4IDA7YmFja2dyb3VuZDojMDgxNzI1fS5kZXRhaWxzLWNhcmQgc3VtbWFyeXtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjEycHggMTRweDtjb2xvcjojYzdkNWRmO2ZvbnQtd2VpZ2h0OjcwMH0uZGV0YWlscy1jYXJkIC5kZXRhaWwtZ3JpZHtwYWRkaW5nOjAgMTRweCAxNHB4fS52YWxpZGF0aW9uLXRleHR7bWluLWhlaWdodDoxLjJlbTtjb2xvcjojZmZhYWE5O2ZvbnQtc2l6ZToxMnB4fS5tb2RhbC1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OXB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjE2cHh9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntmbGV4OjF9Ci50b2FzdHtwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjE1MDtsZWZ0OjUwJTtib3R0b206MTAwcHg7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7YmFja2dyb3VuZDojMTkzNjRkO2NvbG9yOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIwMCwyMjAsMjM2LC4xNik7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTFweCAxNXB4O2JveC1zaGFkb3c6MCAxNnB4IDUwcHggcmdiYSgwLDAsMCwuNCk7bWF4LXdpZHRoOm1pbig5MHZ3LDU2MHB4KTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpey5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9LnJlY29yZC1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxNTBweCwxLjJmcikgcmVwZWF0KDIsbWlubWF4KDk1cHgsLjhmcikpIGF1dG99LnJlY29yZC1yb3cgLnJlY29yZC12YWx1ZTpudGgtb2YtdHlwZSg0KSwucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVlOm50aC1vZi10eXBlKDUpe2Rpc3BsYXk6bm9uZX0ub3N0cm9tLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnByaWNlLWNhcmQuY3VycmVudHtncmlkLWNvbHVtbjoxLy0xfS5jb21wYWN0LW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfX0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmFwcC1zaGVsbHtwYWRkaW5nOjAgMTJweCAxMDRweH0udG9wYmFye3BhZGRpbmctbGVmdDo0cHg7cGFkZGluZy1yaWdodDo0cHh9LmJyYW5ke2ZvbnQtc2l6ZToyMXB4fS5icmFuZC1tYXJre3dpZHRoOjMzcHg7aGVpZ2h0OjMzcHh9LnN1YnRpdGxle21hcmdpbi1sZWZ0OjQzcHh9LnBhZ2UtaGVhZHthbGlnbi1pdGVtczpzdHJldGNoO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjttYXJnaW4tdG9wOjlweH0ucGFnZS1oZWFkIC5wcmltYXJ5e3dpZHRoOjEwMCV9LnBhZ2UtaGVhZCBoMXtmb250LXNpemU6MzFweH0ucGFuZWx7cGFkZGluZzoxNnB4O2JvcmRlci1yYWRpdXM6MTdweDttYXJnaW4tYm90dG9tOjEzcHh9LnBhbmVsLWhlYWR7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5wYW5lbC1oZWFkIGgye2ZvbnQtc2l6ZToxOHB4fS5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsbWlubWF4KDAsMWZyKSk7Z2FwOjlweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtwYWRkaW5nOjEzcHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZToyMHB4fS5vc3Ryb20tZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5wcmljZS1jYXJkLmN1cnJlbnR7Z3JpZC1jb2x1bW46YXV0b30ucHJpY2UtY2FyZHtwYWRkaW5nOjE1cHh9LnByaWNlLWNhcmQgc3Ryb25ne2ZvbnQtc2l6ZToyNHB4fS5jaGFydC13cmFwLC5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjIyNXB4fS5jaGFydC13cmFwLmxhcmdle2hlaWdodDoyNzBweH0ucmVjb3JkLXRvb2xiYXJ7YWxpZ24taXRlbXM6c3RyZXRjaH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0e21heC13aWR0aDoxNDVweH0ucmVjb3JkLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjlweH0ucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVle2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9LnJlY29yZC1yb3cgLmVkaXQtcmVjb3Jke2dyaWQtY29sdW1uOjI7Z3JpZC1yb3c6MX0ucmVjb3JkLW1vbnRoIHNtYWxse21heC13aWR0aDoyMzBweH0uZmlsdGVyLXBhbmVse2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtwYWRkaW5nOjE0cHh9LmZpbHRlci1wYW5lbCBsYWJlbHttaW4td2lkdGg6MH0uc2V0dGluZ3MtZ3JpZCwuZm9ybS1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmRldGFpbHMtY2FyZCAuZGV0YWlsLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uYWN0aW9uLXJvdz4qe2ZsZXg6MSAxIDE1MHB4fS5ib3R0b20tbmF2e3dpZHRoOmNhbGMoMTAwJSAtIDE2cHgpO2JvdHRvbTptYXgoOHB4LGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7Ym9yZGVyLXJhZGl1czoxN3B4fS5ib3R0b20tbmF2IGJ1dHRvbntmb250LXNpemU6MTBweDtwYWRkaW5nOjhweCAzcHh9LmJvdHRvbS1uYXYgYnV0dG9uIHNwYW57Zm9udC1zaXplOjE4cHh9Lm1vZGFse3BhZGRpbmc6OHB4fS5tb2RhbC1jYXJke3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE4cHg7bWF4LWhlaWdodDpjYWxjKDEwMHZoIC0gMTZweCl9Lm1vZGFsLWFjdGlvbnN7ZmxleC13cmFwOndyYXB9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntkaXNwbGF5Om5vbmV9Lm1vZGFsLWFjdGlvbnMgYnV0dG9ue2ZsZXg6MSAxIDEyMHB4fS5iYW5uZXJ7YWxpZ24taXRlbXM6c3RyZXRjaDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59LmJhbm5lciBidXR0b257YWxpZ24tc2VsZjpmbGV4LXN0YXJ0fX0KQG1lZGlhKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsqe3Njcm9sbC1iZWhhdmlvcjphdXRvIWltcG9ydGFudDthbmltYXRpb246bm9uZSFpbXBvcnRhbnQ7dHJhbnNpdGlvbjpub25lIWltcG9ydGFudH19CgovKiBFbGRlaG9mIDYuMC4xIOKAkyBsb2thbGVyIG15VkFJTExBTlQtSW1wb3J0ICovCiN2YWlsbGFudEltcG9ydFBhbmVsIC5hY3Rpb24tcm93e21hcmdpbi10b3A6MTRweH0KI3ZhaWxsYW50SW1wb3J0U3RhdHVzLm9re2NvbG9yOiNhNWU2OWF9CiN2YWlsbGFudEltcG9ydFN0YXR1cy5lcnJvcntjb2xvcjojZmZhYWE5fQoKLyogRWxkZWhvZiA2LjEuMCDigJMgWsOkaGxlcnN0w6RuZGUgYWxzIGVpbnppZ2UgbWFudWVsbGUgVmVyYnJhdWNoc2VpbmdhYmUgKi8KLnJlY29yZC1zdGF0dXMtYmFkZ2V7anVzdGlmeS1zZWxmOmVuZDtmb250LXNpemU6MTFweDtjb2xvcjojOWRiMGMwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzo2cHggOHB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDojMDgxNzI1fQoubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfQoubWV0ZXItaGlzdG9yeXtkaXNwbGF5OmdyaWQ7Z2FwOjdweDttYXJnaW46MTRweCAwfS5tZXRlci1oaXN0b3J5LXJvd3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxMDBweCwxZnIpIHJlcGVhdCgyLG1pbm1heCgxMTBweCwxZnIpKSBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjEwcHggMTJweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiMwODE3MjU7Zm9udC1zaXplOjEycHh9Lm1ldGVyLWhpc3Rvcnktcm93IHNwYW4sLm1ldGVyLWhpc3Rvcnktcm93IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0ubWV0ZXItaGlzdG9yeS1yb3cgc3Ryb25ne2ZvbnQtc2l6ZToxMnB4fS5tZXRlci1hY3Rpb25ze21hcmdpbi10b3A6MTJweH0ubWV0ZXItcHJldmlvdXN7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1O2NvbG9yOiNiOWM3ZDI7bGluZS1oZWlnaHQ6MS41fS5jb21wYWN0LW5vdGV7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfS5tZXRlci1sYXRlc3QubWV0cmljLWdyaWQgYXJ0aWNsZTpmaXJzdC1jaGlsZHtncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0ubWV0ZXItaGlzdG9yeS1yb3cgc3BhbntncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvdyBzbWFsbHtkaXNwbGF5Om5vbmV9LnJlY29yZC1zdGF0dXMtYmFkZ2V7Zm9udC1zaXplOjEwcHh9fQoKLyogRWxkZWhvZiA2LjEuMSDigJMgTW9uYXRzd2VydGUgd2llZGVyIGJlYXJiZWl0YmFyICovCi5maWVsZCBpbnB1dFtyZWFkb25seV17b3BhY2l0eTouNzI7Y3Vyc29yOmRlZmF1bHQ7YmFja2dyb3VuZDojMGIxNzIyfS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kO3doaXRlLXNwYWNlOm5vd3JhcH0KCi8qIEVsZGVob2YgNi4yLjAgKi8KLmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e2Rpc3BsYXk6Z3JpZDtnYXA6NXB4O2ZsZXg6MTttaW4td2lkdGg6MjQwcHg7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDojMGIxYTJhfS5hbmFseXNpcy1hbGwteWVhcnMtaGludCBzdHJvbmd7Zm9udC1zaXplOjEzcHh9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50IHNwYW57Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2xpbmUtaGVpZ2h0OjEuNH0ueWVhci1jb21wYXJpc29uLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHggMTZweDttYXJnaW46LTRweCAwIDEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgc3BhbntkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2NvbG9yOiNiOGM2ZDI7Zm9udC1zaXplOjEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgaXtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDoyOHB4O2hlaWdodDowO2JvcmRlci10b3A6M3B4IHNvbGlkIGN1cnJlbnRDb2xvcn0ueWVhci1jb21wYXJpc29uLWxlZ2VuZCAucGFzdCBpe2JvcmRlci10b3Atc3R5bGU6ZGFzaGVkfS5zeW5jLWJhZGdle2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGIxYTJhO2NvbG9yOnZhcigtLW11dGVkKTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6ODAwfS5zeW5jLWJhZGdlLm9re2NvbG9yOiNhNWU2OWE7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMyl9LnN5bmMtYmFkZ2UuYnVzeXtjb2xvcjojOWZkMGZmO2JvcmRlci1jb2xvcjpyZ2JhKDc3LDE1NiwyNTUsLjM1KX0uc3luYy1iYWRnZS5lcnJvcntjb2xvcjojZmZhYWE5O2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zKX0uc3luYy1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfS5zeW5jLWpvaW4tYm94e21hcmdpbi10b3A6MTRweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nLXRvcDoxMnB4fS5zeW5jLWpvaW4tYm94IHN1bW1hcnl7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6I2RjZTlmMztmb250LXdlaWdodDo4MDB9LnN5bmMtcGFpci1yZXN1bHR7ZGlzcGxheTpncmlkO2dhcDo3cHg7bWFyZ2luLXRvcDoxNHB4O3BhZGRpbmc6MTRweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzcsMTU2LDI1NSwuMjgpO2JhY2tncm91bmQ6IzBhMWQzMDtib3JkZXItcmFkaXVzOjE0cHh9LnN5bmMtcGFpci1yZXN1bHQgc3Bhbiwuc3luYy1wYWlyLXJlc3VsdCBzbWFsbHtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjExcHh9LnN5bmMtcGFpci1yZXN1bHQgY29kZXtkaXNwbGF5OmJsb2NrO3dvcmQtYnJlYWs6YnJlYWstYWxsO2NvbG9yOiNkYmVlZmY7YmFja2dyb3VuZDojMDcxNDIxO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6OHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH1AbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsuZmlsdGVyLXBhbmVse2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e21pbi13aWR0aDowfS5zeW5jLW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnN5bmMtbWV0cmljcy5tZXRyaWMtZ3JpZCBhcnRpY2xlOmxhc3QtY2hpbGR7Z3JpZC1jb2x1bW46MS8tMX19CgoucHJpY2UtcnVubmluZ3tkaXNwbGF5OmlubGluZS1ibG9jazttYXJnaW4tbGVmdDo1cHg7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDpyZ2JhKDc3LDE1NiwyNTUsLjEyKTtjb2xvcjojOWZkMGZmO2ZvbnQtc2l6ZTo5cHg7Zm9udC13ZWlnaHQ6ODAwO3ZlcnRpY2FsLWFsaWduOm1pZGRsZX0ucHJpY2Utc3RhdHMtbm90ZXtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9CgovKiBFbGRlaG9mIDYuMy4xIOKAkyBLbGltYS1Db2NrcGl0OiByZXNwb25zaXZlIGFuZCBsZWdpYmxlIGFjcm9zcyBpT1MsIEFuZHJvaWQgYW5kIGRlc2t0b3AuICovCi5kYXNoYm9hcmQtY2xpbWF0ZS1wYW5lbHtvdmVyZmxvdzpoaWRkZW59Ci5kYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzLm1ldHJpYy1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSk7bWFyZ2luLWJvdHRvbToxOHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtY2hhcnQtdG9we2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7bWFyZ2luOjEwcHggMH0KLmRhc2hib2FyZC1jbGltYXRlLWNoYXJ0LXRvcD5zdHJvbmd7Zm9udC1zaXplOjE0cHg7Y29sb3I6I2NjZGFlNX0KLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaHtkaXNwbGF5OmlubGluZS1mbGV4O2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTNweDtwYWRkaW5nOjRweDtnYXA6M3B4fQouZGFzaGJvYXJkLWNsaW1hdGUtc3dpdGNoIGJ1dHRvbntib3JkZXI6MDtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojOWViMmM0O2ZvbnQ6aW5oZXJpdDtmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7cGFkZGluZzo5cHggMTNweDtjdXJzb3I6cG9pbnRlcn0KLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6IzFiM2I1MTtjb2xvcjojZWVmYWZmfQouZGFzaGJvYXJkLWNsaW1hdGUtc3dpdGNoIGJ1dHRvbjpmb2N1cy12aXNpYmxle291dGxpbmU6MnB4IHNvbGlkICM4M2M3ZWM7b3V0bGluZS1vZmZzZXQ6MnB4fQouZGFzaGJvYXJkLWNsaW1hdGUtY2hhcnQtd3JhcC5jaGFydC13cmFwe2hlaWdodDoyMzVweH0KLmRhc2hib2FyZC1jbGltYXRlLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjlweCAxNXB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiNiNWM3ZDU7bWFyZ2luLXRvcDoxMHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtbGVnZW5kIHNwYW46OmJlZm9yZXtjb250ZW50OiIiO3dpZHRoOjEwcHg7aGVpZ2h0OjEwcHg7Ym9yZGVyLXJhZGl1czozcHg7ZGlzcGxheTppbmxpbmUtYmxvY2s7YmFja2dyb3VuZDp2YXIoLS1sZWdlbmQtY29sb3IpO21hcmdpbi1yaWdodDo2cHg7dmVydGljYWwtYWxpZ246YmFzZWxpbmV9Ci5kYXNoYm9hcmQtY2xpbWF0ZS10cmVuZHtjb2xvcjojYjhjYmQ4O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNDU7bWFyZ2luOjEwcHggMCAwO21pbi1oZWlnaHQ6MThweH0KLmRhc2hib2FyZC1jbGltYXRlLWZvb3RlcntkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2dhcDoxMnB4O2ZsZXgtd3JhcDp3cmFwO21hcmdpbi10b3A6OHB4fQouZGFzaGJvYXJkLWNsaW1hdGUtZm9vdGVyIC5zdGF0dXMtdGV4dHtmbGV4OjEgMSAxNjBweDttYXJnaW46MDtmb250LXNpemU6MTJweH0KI2NsaW1hdGVBbmFseXNpc1BhbmVse3Njcm9sbC1tYXJnaW4tdG9wOjEwMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsKIC5kYXNoYm9hcmQtY2xpbWF0ZS1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0KIC5kYXNoYm9hcmQtY2xpbWF0ZS1jaGFydC13cmFwLmNoYXJ0LXdyYXB7aGVpZ2h0OjIxNXB4fQogLmRhc2hib2FyZC1jbGltYXRlLXBhbmVsIC5wYW5lbC1oZWFke2FsaWduLWl0ZW1zOmZsZXgtc3RhcnR9CiAuZGFzaGJvYXJkLWNsaW1hdGUtcGFuZWwgLnBhbmVsLWhlYWQgYnV0dG9ue21heC13aWR0aDo0MCU7d2hpdGUtc3BhY2U6bm9ybWFsfQogLmRhc2hib2FyZC1jbGltYXRlLXN3aXRjaCBidXR0b257cGFkZGluZzo5cHggMTBweDtmb250LXNpemU6MTJweH0KIC5kYXNoYm9hcmQtY2xpbWF0ZS1mb290ZXIgYnV0dG9ue3dpZHRoOjEwMCV9Cn0K","type":"text/css; charset=utf-8","cache":"no-cache"},"/app.js":{"body":"KCgpID0+IHsKICAidXNlIHN0cmljdCI7CgogIGNvbnN0IEFQUF9CVUlMRCA9ICI2LjMuMi1DTElNQVRFLVdFQVRIRVItUkVDT1ZFUlktMjAyNjEwMzEiOwogIGNvbnN0IERBVEFfS0VZID0gImVsZGVob2YtdjMtcmVjb3JkcyI7CiAgY29uc3QgU0VUVElOR1NfS0VZID0gImVsZGVob2YtdjMtc2V0dGluZ3MiOwogIGNvbnN0IFZBSUxMQU5UX01PTlRIU19LRVkgPSAiZWxkZWhvZi12My12YWlsbGFudC1tb250aHMtdjM4MCI7CiAgY29uc3QgT1NUUk9NX0NBQ0hFX0tFWSA9ICJlbGRlaG9mLXYzLW9zdHJvbS1saXZlLWNhY2hlIjsKICBjb25zdCBPU1RST01fQ09OVFJPTF9LRVkgPSAiZWxkZWhvZi12NS1vc3Ryb20tY29udHJvbC12NTQxIjsKICBjb25zdCBTSEFET1dfS0VZID0gImVsZGVob2YtdjYtcmVjb3Jkcy1zaGFkb3ciOwogIGNvbnN0IFNIQURPV19NRVRBX0tFWSA9ICJlbGRlaG9mLXY2LXJlY29yZHMtc2hhZG93LW1ldGEiOwogIGNvbnN0IExBU1RfQkFDS1VQX0tFWSA9ICJlbGRlaG9mLXY2LWxhc3QtYmFja3VwLWF0IjsKICBjb25zdCBNRVRFUl9LRVkgPSAiZWxkZWhvZi12Ni1tZXRlci1yZWFkaW5ncy12NjEwIjsKICBjb25zdCBNRVRFUl9NRVRBX0tFWSA9ICJlbGRlaG9mLXY2LW1ldGVyLXJlYWRpbmdzLXVwZGF0ZWQtdjYyMCI7CiAgY29uc3QgSElTVE9SWV9TRUVEX0tFWSA9ICJlbGRlaG9mLXY2LWhpc3Rvcnktc2VlZC12NjEwIjsKICBjb25zdCBTWU5DX1NUQVRFX0tFWSA9ICJlbGRlaG9mLXY2LXN5bmMtc3RhdGUtdjYyMCI7CiAgY29uc3QgU1lOQ19TRUNSRVRfTEVHQUNZX0tFWSA9ICJlbGRlaG9mLXY2LXN5bmMtc2VjcmV0LXY2MjAiOwogIGNvbnN0IFNZTkNfUEFZTE9BRF9TQ0hFTUEgPSAiZWxkZWhvZi1zeW5jLXBheWxvYWQtdjYyMCI7CiAgY29uc3QgU1lOQ19FTlZFTE9QRV9TQ0hFTUEgPSAiZWxkZWhvZi1lbmNyeXB0ZWQtc3luYy12MSI7CiAgY29uc3QgT1NUUk9NX0hJU1RPUllfS0VZID0gImVsZGVob2YtdjYtb3N0cm9tLWhpc3Rvcnktc3RhdHVzLXY2MjAiOwogIGNvbnN0IE9TVFJPTV9QUklDRV9TVEFUU19LRVkgPSAiZWxkZWhvZi12Ni1vc3Ryb20tcHJpY2Utc3RhdHMtdjYyMSI7CiAgY29uc3QgTU9OVEhTID0gWyJKYW4iLCJGZWIiLCJNw6RyIiwiQXByIiwiTWFpIiwiSnVuIiwiSnVsIiwiQXVnIiwiU2VwIiwiT2t0IiwiTm92IiwiRGV6Il07CiAgY29uc3QgQ09MT1JTID0geyB0b3RhbDoiIzcyZGM1NyIsIGhlYXQ6IiNmZjlmNDMiLCBhbm5leDoiIzRkOWNmZiIsIHJlc3Q6IiNmMmQxNWYiLCBjb21wYXJlOiIjOWM3ZGZmIiwgY29zdDoiIzVmYzdjMiIsIGdyaWQ6InJnYmEoMTcxLDE5OCwyMjAsLjE0KSIsIHRleHQ6IiM5NGE4YmEiIH07CiAgY29uc3QgWUVBUl9DT0xPUlMgPSBbIiM3MmRjNTciLCIjNGQ5Y2ZmIiwiIzljN2RmZiIsIiNmZjlmNDMiLCIjZjJkMTVmIiwiIzVmYzdjMiIsIiNmZjdiOGEiXTsKICBjb25zdCBISVNUT1JJQ0FMX1NFRUQgPSB7ImhlYXRQdW1wIjp7IjIwMjMtMTIiOjE1NTAsIjIwMjQtMDEiOjE5ODAsIjIwMjQtMDIiOjExMTMsIjIwMjQtMDMiOjkwNywiMjAyNC0wNCI6NTM1LCIyMDI0LTA1IjoxNTYsIjIwMjQtMDYiOjExMCwiMjAyNC0wNyI6MTEwLCIyMDI0LTA4IjoxMDgsIjIwMjQtMDkiOjE5OCwiMjAyNC0xMCI6NDkwLCIyMDI0LTExIjoxMDAzLCIyMDI0LTEyIjoxMzA1LCIyMDI1LTAxIjoxNjk0LCIyMDI1LTAyIjoxNDc4LCIyMDI1LTAzIjoxMDA1LCIyMDI1LTA0Ijo0OTgsIjIwMjUtMDUiOjM2NywiMjAyNS0wNiI6MTM3LCIyMDI1LTA3IjoxMDYsIjIwMjUtMDgiOjEyOCwiMjAyNS0wOSI6MTg1LCIyMDI1LTEwIjo2MDcsIjIwMjUtMTEiOjEwNDAsIjIwMjUtMTIiOjEyNjUsIjIwMjYtMDEiOjE4NTUsIjIwMjYtMDIiOjE0ODgsIjIwMjYtMDMiOjg5NSwiMjAyNi0wNCI6NjU2LCIyMDI2LTA1IjozMDAsIjIwMjYtMDYiOjEyNiwiMjAyNi0wNyI6MTI4LCIyMDI2LTA4IjoxMjEsIjIwMjYtMDkiOjEzN30sImFubmV4Ijp7IjIwMjQtMDEiOjIxMCwiMjAyNC0wMiI6MjEwLCIyMDI0LTAzIjoyMTksIjIwMjQtMDQiOjIwMCwiMjAyNC0wNSI6MjIyLCIyMDI0LTA2IjoxNjQsIjIwMjQtMDciOjIxOSwiMjAyNC0wOCI6MjAxLCIyMDI0LTA5IjoxOTIsIjIwMjQtMTAiOjIzNywiMjAyNC0xMSI6MjI3LCIyMDI0LTEyIjoyNjYsIjIwMjUtMDEiOjI2MSwiMjAyNS0wMiI6MjM1LCIyMDI1LTAzIjoyMjEsIjIwMjUtMDQiOjIzOCwiMjAyNS0wNSI6MjIxLCIyMDI1LTA2IjoyMzcsIjIwMjUtMDciOjI0MCwiMjAyNS0wOCI6MjMyLCIyMDI1LTA5IjozMDgsIjIwMjUtMTAiOjIyMCwiMjAyNS0xMSI6MjM3LCIyMDI1LTEyIjoyNzMsIjIwMjYtMDEiOjI0MCwiMjAyNi0wMiI6MjI1LCIyMDI2LTAzIjoyNzAsIjIwMjYtMDQiOjIxNSwiMjAyNi0wNSI6MjIwLCIyMDI2LTA2IjoyNTAsIjIwMjYtMDciOjIxMCwiMjAyNi0wOCI6MjQwLCIyMDI2LTA5IjoyNjV9LCJ0b3RhbCI6eyIyMDI0LTAxIjoyNDUwLCIyMDI0LTAyIjoxNjE1LCIyMDI0LTAzIjoxMzIwLCIyMDI0LTA0Ijo5MzMsIjIwMjQtMDUiOjczMSwiMjAyNC0wNiI6NTg3LCIyMDI0LTA3Ijo2MjAsIjIwMjQtMDgiOjU0MCwiMjAyNC0wOSI6NjEyLCIyMDI0LTEwIjoxMDE5LCIyMDI0LTExIjoxNTIxLCIyMDI0LTEyIjoxODU3LCIyMDI1LTAxIjoyMjgyLCIyMDI1LTAyIjoyMDIzLCIyMDI1LTAzIjoxNDE0LCIyMDI1LTA0Ijo5NjAsIjIwMjUtMDUiOjkzMywiMjAyNS0wNiI6NzUxLCIyMDI1LTA3Ijo2ODAsIjIwMjUtMDgiOjY3NiwiMjAyNS0wOSI6ODE0LCIyMDI1LTEwIjoxMTA1LCIyMDI1LTExIjoxNjE1LCIyMDI1LTEyIjoxODUwLCIyMDI2LTAxIjoyNDUwLCIyMDI2LTAyIjoyMDYwLCIyMDI2LTAzIjoxNTk3LCIyMDI2LTA0IjoxMDUxLCIyMDI2LTA1Ijo3NjcsIjIwMjYtMDYiOjY2MiwiMjAyNi0wNyI6NjA4LCIyMDI2LTA4Ijo2ODUsIjIwMjYtMDkiOjY1NX19OwogIGNvbnN0IEJBU0VMSU5FX01FVEVSX1JFQURJTkcgPSB7ZGF0ZToiMjAyNi0xMC0wMSIsdG90YWw6MzQyNTUsYW5uZXg6OTA0NSxub3RlOiJTdGFydHdlcnQgZsO8ciBkaWUgYXV0b21hdGlzY2hlIEJlcmVjaG51bmcgYWIgT2t0b2JlciAyMDI2In07CiAgY29uc3QgJCA9IGlkID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKCiAgbGV0IHNldHRpbmdzID0gbG9hZFNldHRpbmdzKCk7CiAgbGV0IHJlY29yZHMgPSBsb2FkUmVjb3JkcygpOwogIGxldCB2YWlsbGFudE1vbnRocyA9IGxvYWRWYWlsbGFudE1vbnRocygpOwogIGxldCBvc3Ryb21MaXZlID0gbG9hZE9zdHJvbUNhY2hlKCk7CiAgbGV0IG9zdHJvbUJ1c3kgPSBmYWxzZTsKICBsZXQgb3N0cm9tVGltZXIgPSBudWxsOwogIGxldCB0b2FzdFRpbWVyID0gbnVsbDsKICBsZXQgcmVzaXplVGltZXIgPSBudWxsOwogIGxldCBjdXJyZW50VmlldyA9ICJkYXNoYm9hcmRWaWV3IjsKICBsZXQgbWV0ZXJSZWFkaW5ncyA9IGxvYWRNZXRlclJlYWRpbmdzKCk7CiAgbGV0IHN5bmNTdGF0ZSA9IGxvYWRTeW5jU3RhdGUoKTsKICBsZXQgc3luY0J1c3kgPSBmYWxzZTsKICBsZXQgc3luY0FwcGx5aW5nID0gZmFsc2U7CiAgbGV0IHN5bmNEZWJvdW5jZVRpbWVyID0gbnVsbDsKICBsZXQgc3luY1BvbGxUaW1lciA9IG51bGw7CiAgbGV0IG9zdHJvbUhpc3RvcnlCdXN5ID0gZmFsc2U7CiAgbGV0IG9zdHJvbVByaWNlU3RhdHMgPSBsb2FkT3N0cm9tUHJpY2VTdGF0cygpOwogIGxldCBvc3Ryb21QcmljZVN0YXRzQnVzeSA9IGZhbHNlOwoKICAvKiBDbGltYXRlIDYuMzogVmFpbGxhbnQgaG91cmx5IGRhdGEgYXJlIHJlZHVjZWQgdG8gcHJpdmFjeS1wcmVzZXJ2aW5nIG1vbnRobHkgYWdncmVnYXRlcy4gKi8KICBjb25zdCBDTElNQVRFX01PTlRIX0tFWT0iZWxkZWhvZi12Ni1jbGltYXRlLW1vbnRocy12NjMwIjsKICBjb25zdCBDTElNQVRFX1dFQVRIRVJfS0VZPSJlbGRlaG9mLXY2LWNsaW1hdGUtd2VhdGhlci12NjMwIjsKICBsZXQgY2xpbWF0ZU1vbnRocz1sb2FkQ2xpbWF0ZU1vbnRocygpOwogIGZ1bmN0aW9uIGNsaW1hdGVXZWF0aGVyT2JqZWN0KHZhbHVlKXsKICAgIHJldHVybiB2YWx1ZSAmJiB0eXBlb2YgdmFsdWU9PT0ib2JqZWN0IiAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk/dmFsdWU6e307CiAgfQogIGxldCBjbGltYXRlV2VhdGhlcj1jbGltYXRlV2VhdGhlck9iamVjdChzYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKENMSU1BVEVfV0VBVEhFUl9LRVkpLHt9KSk7CiAgbGV0IGNsaW1hdGVCdXN5PWZhbHNlOwogIGZ1bmN0aW9uIGNsaW1hdGVOdW1iZXIocmF3KXtyZXR1cm4gcmF3PT1udWxsfHxyYXc9PT0iIj9udWxsOihOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdykpP051bWJlcihyYXcpOm51bGwpO30KICBmdW5jdGlvbiBjbGltYXRlU2FuaXRpemUoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCB4IG9mIEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKXsKICAgICAgY29uc3QgbW9udGg9U3RyaW5nKHg/Lm1vbnRofHwiIik7CiAgICAgIGlmKCEvXlxkezR9LSgwWzEtOV18MVswLTJdKSQvLnRlc3QobW9udGgpKWNvbnRpbnVlOwogICAgICBjb25zdCByb3c9e21vbnRoLHVwZGF0ZWRBdDpTdHJpbmcoeC51cGRhdGVkQXR8fCIiKX07CiAgICAgIGZvcihjb25zdCBrIG9mIFsib3V0ZG9vck1lYW4iLCJvdXRkb29yTWluIiwib3V0ZG9vck1heCIsIm91dGRvb3JIb3VycyIsInJvb21NZWFuIiwicm9vbUhvdXJzIiwic2V0cG9pbnRNZWFuIiwic2V0cG9pbnRIb3VycyIsImRod01lYW4iLCJkaHdIb3VycyJdKXJvd1trXT1jbGltYXRlTnVtYmVyKHhba10pOwogICAgICBtYXAuc2V0KG1vbnRoLHJvdyk7CiAgICB9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gbG9hZENsaW1hdGVNb250aHMoKXtyZXR1cm4gY2xpbWF0ZVNhbml0aXplKHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oQ0xJTUFURV9NT05USF9LRVkpLFtdKSk7fQogIGZ1bmN0aW9uIHNhdmVDbGltYXRlTW9udGhzKGl0ZW1zKXsKICAgIGNsaW1hdGVNb250aHM9Y2xpbWF0ZVNhbml0aXplKGl0ZW1zKTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKENMSU1BVEVfTU9OVEhfS0VZLEpTT04uc3RyaW5naWZ5KGNsaW1hdGVNb250aHMpKTsKICAgIGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoMTIwMCk7CiAgfQogIGZ1bmN0aW9uIGNsaW1hdGVQcmV2aWV3KGZpbGVzKXsKICAgIGNvbnN0IGNvbHM9eyJzeXN0ZW0tdGVtcGVyYXR1cmUiOltbIk91dGRvb3JUZW1wZXJhdHVyZSIsIm91dGRvb3IiXV0sInpvbmUtdGVtcGVyYXR1cmUiOltbIkN1cnJlbnRSb29tVGVtcGVyYXR1cmUiLCJyb29tIl0sWyJNYW51YWxNb2RlU2V0cG9pbnRIZWF0aW5nIiwic2V0cG9pbnQiXV0sImRody10ZW1wZXJhdHVyZSI6W1siRGh3VGFua1RlbXBlcmF0dXJlIiwiZGh3Il1dfTsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgZmlsZSBvZiBmaWxlcy5maWx0ZXIoZj0+Y29sc1tmLnR5cGVdKSl7CiAgICAgIGZvcihjb25zdCByIG9mIGZpbGUucm93cyl7CiAgICAgICAgaWYoIW1hcC5oYXMoci5tb250aEtleSkpbWFwLnNldChyLm1vbnRoS2V5LHttb250aDpyLm1vbnRoS2V5LHNlcmllczp7fX0pOwogICAgICAgIGNvbnN0IGJ1Y2tldD1tYXAuZ2V0KHIubW9udGhLZXkpOwogICAgICAgIGZvcihjb25zdCBbY29sdW1uLGtpbmRdIG9mIGNvbHNbZmlsZS50eXBlXSl7CiAgICAgICAgICBjb25zdCB2YWx1ZT1yLnZhbHVlc1tjb2x1bW5dOwogICAgICAgICAgaWYoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpY29udGludWU7CiAgICAgICAgICBpZighYnVja2V0LnNlcmllc1traW5kXSlidWNrZXQuc2VyaWVzW2tpbmRdPW5ldyBNYXAoKTsKICAgICAgICAgIGNvbnN0IG9sZD1idWNrZXQuc2VyaWVzW2tpbmRdLmdldChyLmRhdGVUaW1lKTsKICAgICAgICAgIGlmKG9sZCE9PXVuZGVmaW5lZCYmTWF0aC5hYnMob2xkLXZhbHVlKT4uMDUpdGhyb3cgRXJyb3IoIkFid2VpY2hlbmRlIGRvcHBlbHRlIFRlbXBlcmF0dXJtZXNzdW5nZW4gaW4gIityLm1vbnRoS2V5KTsKICAgICAgICAgIGJ1Y2tldC5zZXJpZXNba2luZF0uc2V0KHIuZGF0ZVRpbWUsdmFsdWUpOwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgcmV0dXJuIFsuLi5tYXAudmFsdWVzKCldLm1hcChiPT57CiAgICAgIGNvbnN0IHJvdz17bW9udGg6Yi5tb250aCx1cGRhdGVkQXQ6c3RhbXB9OwogICAgICBmb3IoY29uc3Qga2luZCBvZiBbIm91dGRvb3IiLCJyb29tIiwic2V0cG9pbnQiLCJkaHciXSl7CiAgICAgICAgY29uc3Qgdj1bLi4uKGIuc2VyaWVzW2tpbmRdPy52YWx1ZXMoKXx8W10pXTsKICAgICAgICBpZighdi5sZW5ndGgpY29udGludWU7CiAgICAgICAgcm93W2tpbmQrIk1lYW4iXT1NYXRoLnJvdW5kKHYucmVkdWNlKChhLHgpPT5hK3gsMCkvdi5sZW5ndGgqMTAwKS8xMDA7CiAgICAgICAgcm93W2tpbmQrIkhvdXJzIl09di5sZW5ndGg7CiAgICAgICAgaWYoa2luZD09PSJvdXRkb29yIil7cm93Lm91dGRvb3JNaW49TWF0aC5taW4oLi4udik7cm93Lm91dGRvb3JNYXg9TWF0aC5tYXgoLi4udik7fQogICAgICB9CiAgICAgIHJldHVybiByb3c7CiAgICB9KTsKICB9CiAgZnVuY3Rpb24gY2xpbWF0ZUltcG9ydChpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcChjbGltYXRlTW9udGhzLm1hcChyPT5bci5tb250aCxyXSkpOwogICAgZm9yKGNvbnN0IHJvdyBvZiBpdGVtcyltYXAuc2V0KHJvdy5tb250aCx7Li4ubWFwLmdldChyb3cubW9udGgpLC4uLnJvd30pOwogICAgc2F2ZUNsaW1hdGVNb250aHMoWy4uLm1hcC52YWx1ZXMoKV0pOwogIH0KICBmdW5jdGlvbiBtb250aGx5VmFpbGxhbnRJbXBvcnRzKGZpbGVzKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgZmlsZSBvZiBmaWxlcy5maWx0ZXIoZj0+Zi50eXBlPT09Im1vbnRobHktZW5lcmd5IikpewogICAgICBmb3IoY29uc3Qgcm93IG9mIGZpbGUucm93cyl7CiAgICAgICAgY29uc3QgcmF3PXJvdy52YWx1ZXMsbT1yb3cubW9udGhLZXk7CiAgICAgICAgaWYocmF3LmNvbXBsZXRlIT09dHJ1ZXx8cmF3LmVzdGltYXRlZD09PXRydWV8fG0+Y3VycmVudE1vbnRoS2V5KCkpY29udGludWU7CiAgICAgICAgY29uc3QgZmllbGRzPVsiZWxlY3RyaWNpdHlLV2giLCJoZWF0R2VuZXJhdGVkS1doIiwiaGVhdGluZ0VsZWN0cmljaXR5S1doIiwiZGh3RWxlY3RyaWNpdHlLV2giLCJoZWF0aW5nSGVhdEtXaCIsImRod0hlYXRLV2giXTsKICAgICAgICBpZihmaWVsZHMuc29tZShrPT4hTnVtYmVyLmlzRmluaXRlKHJhd1trXSl8fHJhd1trXTwwKSljb250aW51ZTsKICAgICAgICBjb25zdCB5ZWFyPU51bWJlcihtLnNsaWNlKDAsNCkpLG1vbnRoPU51bWJlcihtLnNsaWNlKDUpKTsKICAgICAgICBtYXAuc2V0KG0se21vbnRoOm0sZWxlY3RyaWNpdHlLV2g6cmF3LmVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2g6cmF3LmhlYXRHZW5lcmF0ZWRLV2gsaGVhdGluZ0VsZWN0cmljaXR5S1doOnJhdy5oZWF0aW5nRWxlY3RyaWNpdHlLV2gsZGh3RWxlY3RyaWNpdHlLV2g6cmF3LmRod0VsZWN0cmljaXR5S1doLGhlYXRpbmdIZWF0S1doOnJhdy5oZWF0aW5nSGVhdEtXaCxkaHdIZWF0S1doOnJhdy5kaHdIZWF0S1doLGNvbXBsZXRlOnRydWUsY292ZXJhZ2VTdGFydDptKyItMDEiLGNvdmVyYWdlRW5kOm0rIi0iK1N0cmluZyhuZXcgRGF0ZSh5ZWFyLG1vbnRoLDApLmdldERhdGUoKSkucGFkU3RhcnQoMiwiMCIpLGJsb2NrZWQ6ZmFsc2V9KTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIFsuLi5tYXAudmFsdWVzKCldOwogIH0KICBjb25zdCBjbGltYXRlRm10PSh2LGQ9MCk9Pk51bWJlci5pc0Zpbml0ZSh2KT9udW0odixkKToi4oCTIjsKICBmdW5jdGlvbiBjbGltYXRlV2VhdGhlckZvcihtb250aCl7cmV0dXJuIGNsaW1hdGVXZWF0aGVyPy5bbW9udGguc2xpY2UoMCw0KV0/Lm1vbnRocz8uZmluZCh4PT54Lm1vbnRoPT09bW9udGgpfHxudWxsO30KICBmdW5jdGlvbiBjbGltYXRlUm93c0Zvcih5ZWFyKXsKICAgIGNvbnN0IHJlZmVyZW5jZT1uZXcgTWFwKCk7CiAgICBmb3IobGV0IGk9MTtpPD0xMjtpKyspewogICAgICBjb25zdCBtbT1TdHJpbmcoaSkucGFkU3RhcnQoMiwiMCIpOwogICAgICBjb25zdCBoaXN0PVsyMDI0LDIwMjVdLm1hcCh5PT5jbGltYXRlV2VhdGhlckZvcih5KyItIittbSkpLmZpbHRlcih3PT53Py5jb21wbGV0ZSYmTnVtYmVyLmlzRmluaXRlKHcuaGRkMTUpKTsKICAgICAgaWYoaGlzdC5sZW5ndGg9PT0yKXJlZmVyZW5jZS5zZXQobW0sKGhpc3RbMF0uaGRkMTUraGlzdFsxXS5oZGQxNSkvMik7CiAgICB9CiAgICByZXR1cm4gQXJyYXkuZnJvbSh7bGVuZ3RoOjEyfSwoXyxpKT0+ewogICAgICBjb25zdCBtb250aD15ZWFyKyItIitTdHJpbmcoaSsxKS5wYWRTdGFydCgyLCIwIik7CiAgICAgIGNvbnN0IHI9cmVjb3JkRm9yTW9udGgobW9udGgpLHc9Y2xpbWF0ZVdlYXRoZXJGb3IobW9udGgpLHNlbnNvcj1jbGltYXRlTW9udGhzLmZpbmQoeD0+eC5tb250aD09PW1vbnRoKSx2YWxpZD13Py5jb21wbGV0ZSYmTnVtYmVyLmlzRmluaXRlKHcuaGRkMTUpOwogICAgICBjb25zdCBoZWF0PU51bWJlci5pc0Zpbml0ZShyPy5oZWF0aW5nSGVhdCk/ci5oZWF0aW5nSGVhdDpudWxsOwogICAgICBjb25zdCBkaHc9TnVtYmVyLmlzRmluaXRlKHI/LmRod0hlYXQpP3IuZGh3SGVhdDpudWxsOwogICAgICBjb25zdCBiYXNlbGluZT1yZWZlcmVuY2UuZ2V0KG1vbnRoLnNsaWNlKDUpKTsKICAgICAgLy8gQmVsb3cgMTUgZGVncmVlLWRheXMsIG5vcm1hbGl6YXRpb24gaXMgbnVtZXJpY2FsbHkgdW5zdGFibGUgKHN1bW1lciBoZWF0aW5nIG5lYXJseSBvZmYpLgogICAgICBjb25zdCBub3JtYWxpemVkPWhlYXQhPT1udWxsJiZ2YWxpZCYmdy5oZGQxNT49MTUmJk51bWJlci5pc0Zpbml0ZShiYXNlbGluZSkmJmJhc2VsaW5lPj0xNT9oZWF0KmJhc2VsaW5lL3cuaGRkMTU6bnVsbDsKICAgICAgcmV0dXJuIHttb250aCx3LHNlbnNvcixoZWF0LGRodyx2YWxpZCxub3JtYWxpemVkfTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyQ2xpbWF0ZU11bHRpWWVhcigpewogICAgY29uc3QgZWw9JCgiY2xpbWF0ZU11bHRpWWVhciIpO2lmKCFlbClyZXR1cm47CiAgICBjb25zdCBhdmFpbGFibGU9Wy4uLm5ldyBTZXQocmVjb3Jkcy5tYXAocj0+TnVtYmVyKHIubW9udGg/LnNsaWNlKDAsNCkpKSldLmZpbHRlcih5PT55Pj0yMDI0JiZ5PD1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkpLnNvcnQoKTsKICAgIGNvbnN0IGNhbmRpZGF0ZXM9YXZhaWxhYmxlLm1hcCh5PT4oe3llYXI6eSxyb3dzOmNsaW1hdGVSb3dzRm9yKHkpfSkpLmZpbHRlcih4PT54LnJvd3MuZmlsdGVyKHI9PnIubm9ybWFsaXplZCE9PW51bGwpLmxlbmd0aD49Myk7CiAgICBpZihjYW5kaWRhdGVzLmxlbmd0aDwyKXtlbC50ZXh0Q29udGVudD0iRGVyIGRpcmVrdGUgSmFocmVzdmVyZ2xlaWNoIGVyc2NoZWludCwgc29iYWxkIG1pbmRlc3RlbnMgendlaSBKYWhyZSBqZXdlaWxzIGRyZWkgdm9sbHN0w6RuZGlnZSB2ZXJnbGVpY2hiYXJlIE1vbmF0ZSBtaXQgSGVpenfDpHJtZSB1bmQgV2V0dGVyZGF0ZW4gYmVzaXR6ZW4uIjtyZXR1cm47fQogICAgY29uc3QgbW9udGhzPUFycmF5LmZyb20oe2xlbmd0aDoxMn0sKF8saSk9PmkrMSkuZmlsdGVyKG09PmNhbmRpZGF0ZXMuZXZlcnkoYz0+Yy5yb3dzW20tMV0/Lm5vcm1hbGl6ZWQhPT1udWxsKSk7CiAgICBpZihtb250aHMubGVuZ3RoPDMpe2VsLnRleHRDb250ZW50PSJGw7xyIGRpZXNlIEphaHJlIGdpYnQgZXMgbm9jaCBuaWNodCBnZW7DvGdlbmQgZ2VtZWluc2FtZSBNb25hdGUuIEZlaGxlbmRlIFZhaWxsYW50LVfDpHJtZS0gb2RlciBXZXR0ZXJ3ZXJ0ZSBlcmfDpG56ZW4uIjtyZXR1cm47fQogICAgY29uc3QgYmFzZVllYXI9Y2FuZGlkYXRlc1swXS55ZWFyLGJhc2VIZWF0PW1vbnRocy5yZWR1Y2UoKHMsbSk9PnMrY2FuZGlkYXRlc1swXS5yb3dzW20tMV0ubm9ybWFsaXplZCwwKTsKICAgIGNvbnN0IGhlYWRlcj0nPHAgY2xhc3M9Im11dGVkIj5EaXJla3R2ZXJnbGVpY2ggbnVyIGdsZWljaGVyLCB2b2xsc3TDpG5kaWcgZXJmYXNzdGVyIE1vbmF0ZTogJyttb250aHMubWFwKG09Pk1PTlRIU1ttLTFdKS5qb2luKCIsICIpKycuIFdhcm13YXNzZXIgaXN0IGF1c2dlc2NobG9zc2VuLjwvcD4nOwogICAgY29uc3QgdGFibGU9JzxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPkphaHI8L3RoPjx0aD5IZWl6d8Okcm1lIGdlbWVzc2VuIGtXaDwvdGg+PHRoPldpdHRlcnVuZ3NiZXJlaW5pZ3Qga1doPC90aD48dGg+R2VnZW7DvGJlciAnK2Jhc2VZZWFyKyc8L3RoPjwvdHI+PC90aGVhZD48dGJvZHk+JysKICAgICAgY2FuZGlkYXRlcy5tYXAoYz0+ewogICAgICAgIGNvbnN0IG9yaWdpbmFsPW1vbnRocy5yZWR1Y2UoKHMsbSk9PnMrYy5yb3dzW20tMV0uaGVhdCwwKTsKICAgICAgICBjb25zdCBhZGp1c3RlZD1tb250aHMucmVkdWNlKChzLG0pPT5zK2Mucm93c1ttLTFdLm5vcm1hbGl6ZWQsMCk7CiAgICAgICAgY29uc3QgZGVsdGE9YmFzZUhlYXQ+MD8oYWRqdXN0ZWQvYmFzZUhlYXQtMSkqMTAwOm51bGw7CiAgICAgICAgcmV0dXJuICc8dHI+PHRkPicrYy55ZWFyKyc8L3RkPjx0ZD4nK251bShvcmlnaW5hbCkrJzwvdGQ+PHRkPicrbnVtKGFkanVzdGVkKSsnPC90ZD48dGQ+JysoZGVsdGE9PT1udWxsPyLigJMiOnBjdChkZWx0YSkpKyc8L3RkPjwvdHI+JzsKICAgICAgfSkuam9pbigiIikrJzwvdGJvZHk+PC90YWJsZT48L2Rpdj4nOwogICAgZWwuaW5uZXJIVE1MPWhlYWRlcit0YWJsZTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlckNsaW1hdGVBbmFseXNpcygpewogICAgaWYoISQoImNsaW1hdGVNZXRyaWNzIikpcmV0dXJuOwogICAgY29uc3QgeWVhcj1OdW1iZXIoJCgiYW5hbHlzaXNZZWFyIikudmFsdWUpfHxuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkscm93cz1jbGltYXRlUm93c0Zvcih5ZWFyKTsKICAgIGNvbnN0IGg9cm93cy5maWx0ZXIoeD0+eC5oZWF0IT09bnVsbCksdz1yb3dzLmZpbHRlcih4PT54LmRodyE9PW51bGwpLG49cm93cy5maWx0ZXIoeD0+eC5ub3JtYWxpemVkIT09bnVsbCksd2VhdGhlcj1yb3dzLmZpbHRlcih4PT54LnZhbGlkKTsKICAgIGNvbnN0IG1ldHJpY3M9WwogICAgICBbIkhlaXp3w6RybWUiLGgubGVuZ3RoP2NsaW1hdGVGbXQoaC5yZWR1Y2UoKHMseCk9PnMreC5oZWF0LDApKSsiIGtXaCI6IuKAkyIsaC5sZW5ndGgrIiBNb25hdGUiXSwKICAgICAgWyJXYXJtd2Fzc2Vyd8Okcm1lIix3Lmxlbmd0aD9jbGltYXRlRm10KHcucmVkdWNlKChzLHgpPT5zK3guZGh3LDApKSsiIGtXaCI6IuKAkyIsIm9obmUgV2l0dGVydW5nc2JlcmVpbmlndW5nIl0sCiAgICAgIFsiSGVpemdyYWR0YWdlIix3ZWF0aGVyLmxlbmd0aD9jbGltYXRlRm10KHdlYXRoZXIucmVkdWNlKChzLHgpPT5zK3gudy5oZGQxNSwwKSkrIiBLwrdkIjoi4oCTIiwiQmFzaXMgMTUgwrBDOyB2b2xsc3TDpG5kaWdlIE1vbmF0ZSJdLAogICAgICBbIkJlcmVpbmlndGUgSGVpenfDpHJtZSIsbi5sZW5ndGg/Y2xpbWF0ZUZtdChuLnJlZHVjZSgocyx4KT0+cyt4Lm5vcm1hbGl6ZWQsMCkpKyIga1doIjoi4oCTIixuLmxlbmd0aCsiIHZlcmdsZWljaGJhcmUgTW9uYXRlIl0KICAgIF07CiAgICAkKCJjbGltYXRlTWV0cmljcyIpLmlubmVySFRNTD1tZXRyaWNzLm1hcCgoW2EsYixjXSk9Pic8YXJ0aWNsZT48c3Bhbj4nK2VzY2FwZUh0bWwoYSkrJzwvc3Bhbj48c3Ryb25nPicrZXNjYXBlSHRtbChiKSsnPC9zdHJvbmc+PHNtYWxsPicrZXNjYXBlSHRtbChjKSsnPC9zbWFsbD48L2FydGljbGU+Jykuam9pbigiIik7CiAgICAkKCJjbGltYXRlUm93cyIpLmlubmVySFRNTD1yb3dzLm1hcCh4PT4nPHRyPjx0ZD4nK2VzY2FwZUh0bWwobW9udGhMYWJlbCh4Lm1vbnRoLGZhbHNlKSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4Lnc/Lm1lYW5UZW1wLDEpKyc8L3RkPjx0ZD4nK2NsaW1hdGVGbXQoeC5zZW5zb3I/Lm91dGRvb3JNZWFuLDEpKyc8L3RkPjx0ZD4nK2NsaW1hdGVGbXQoeC5zZW5zb3I/LnJvb21NZWFuLDEpKyc8L3RkPjx0ZD4nK2NsaW1hdGVGbXQoeC5zZW5zb3I/LmRod01lYW4sMSkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LnZhbGlkP3gudy5oZGQxNTpudWxsKSsnPC90ZD48dGQ+JytjbGltYXRlRm10KHguaGVhdCkrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4LmRodykrJzwvdGQ+PHRkPicrY2xpbWF0ZUZtdCh4Lm5vcm1hbGl6ZWQpKyc8L3RkPjwvdHI+Jykuam9pbigiIik7CiAgICByZW5kZXJDbGltYXRlTXVsdGlZZWFyKCk7CiAgICAkKCJjbGltYXRlSW5mbyIpLnRleHRDb250ZW50PShjbGltYXRlQnVzeT8iSGlzdG9yaXNjaGUgV2V0dGVyZGF0ZW4gd2VyZGVuIGdlbGFkZW4g4oCmICI6IiIpKyhuLmxlbmd0aD9uLmxlbmd0aCsiIHdpdHRlcnVuZ3NiZXJlaW5pZ3RlIE1vbmF0ZS4iOiJCaXR0ZSBoaXN0b3Jpc2NoZSBXZXR0ZXJkYXRlbiBsYWRlbi4gIikrIlJlZmVyZW56IGplIEthbGVuZGVybW9uYXQ6IEhlaXpncmFkdGFnZSAyMDI0LzIwMjUuIE51ciBnbGVpY2hlIFplaXRyw6R1bWUgdmVyZ2xlaWNoZW4sIFdhcm13YXNzZXIgZ2V0cmVubnQuIjsKICB9CiAgYXN5bmMgZnVuY3Rpb24gbG9hZENsaW1hdGVXZWF0aGVyKCl7CiAgICBpZihjbGltYXRlQnVzeSlyZXR1cm47CiAgICBpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXt0b2FzdCgiRWxkZWhvZi1BcHAtU2NobMO8c3NlbCB1bnRlciBEYXRlbiDihpIgT3N0cm9tIHNwZWljaGVybiIpO3JldHVybjt9CiAgICAvLyBKU09OLnBhcnNlKG51bGwpIHJldHVybnMgbnVsbDsgYWx3YXlzIHJlc3RvcmUgYSBtdXRhYmxlIG9iamVjdCB3aXRob3V0IGNsZWFyaW5nIGFueSBvdGhlciBhcHAgZGF0YS4KICAgIGNsaW1hdGVXZWF0aGVyPWNsaW1hdGVXZWF0aGVyT2JqZWN0KGNsaW1hdGVXZWF0aGVyKTsKICAgIGNsaW1hdGVCdXN5PXRydWU7Y2xpbWF0ZVdlYXRoZXJFcnJvcj0iIjtyZW5kZXJDbGltYXRlQW5hbHlzaXMoKTtyZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7CiAgICB0cnl7CiAgICAgIGNvbnN0IHllYXJzPVsuLi5uZXcgU2V0KFsuLi5yZWNvcmRzLm1hcChyPT5OdW1iZXIoci5tb250aC5zbGljZSgwLDQpKSksMjAyNCwyMDI1XSldLmZpbHRlcih5PT55Pj0yMDIzJiZ5PD1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkpLnNvcnQoKTsKICAgICAgZm9yKGNvbnN0IHllYXIgb2YgeWVhcnMpewogICAgICAgIGlmKGNsaW1hdGVXZWF0aGVyPy5beWVhcl0/LmNvbXBsZXRlJiZEYXRlLm5vdygpLURhdGUucGFyc2UoY2xpbWF0ZVdlYXRoZXJbeWVhcl0uY2FjaGVkQXR8fCIiKTw5MCo4NjQwMGUzKWNvbnRpbnVlOwogICAgICAgIGNvbnN0IHJlc3BvbnNlPWF3YWl0IGZldGNoKCIvYXBpL3dlYXRoZXIvYXJjaGl2ZT95ZWFyPSIreWVhcix7aGVhZGVyczp7IngtZWxkZWhvZi1rZXkiOnNldHRpbmdzLm9zdHJvbUFwcEtleX0sY2FjaGU6Im5vLXN0b3JlIn0pOwogICAgICAgIGNvbnN0IHBheWxvYWQ9YXdhaXQgcmVzcG9uc2UuanNvbigpOwogICAgICAgIGlmKCFyZXNwb25zZS5vayl0aHJvdyBFcnJvcihwYXlsb2FkLmVycm9yfHwiSGlzdG9yaXNjaGUgV2V0dGVyZGF0ZW4gZmVobGVuIik7CiAgICAgICAgaWYoIXBheWxvYWR8fCFBcnJheS5pc0FycmF5KHBheWxvYWQubW9udGhzKXx8cGF5bG9hZC55ZWFyIT09eWVhcil7CiAgICAgICAgICB0aHJvdyBFcnJvcigiRGFzIFdldHRlcmFyY2hpdiBsaWVmZXJ0ZSBrZWluZSBnw7xsdGlnZW4gTW9uYXRzd2VydGUgZsO8ciAiK3llYXIrIi4iKTsKICAgICAgICB9CiAgICAgICAgY2xpbWF0ZVdlYXRoZXJbeWVhcl09cGF5bG9hZDsKICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShDTElNQVRFX1dFQVRIRVJfS0VZLEpTT04uc3RyaW5naWZ5KGNsaW1hdGVXZWF0aGVyKSk7CiAgICAgICAgcmVuZGVyQ2xpbWF0ZUFuYWx5c2lzKCk7cmVuZGVyRGFzaGJvYXJkQ2xpbWF0ZSgpOwogICAgICB9CiAgICAgIHRvYXN0KCJXZXR0ZXJoaXN0b3JpZSBha3R1YWxpc2llcnQiKTsKICAgIH1jYXRjaChlKXtjbGltYXRlV2VhdGhlckVycm9yPWUubWVzc2FnZTt0b2FzdCgiV2V0dGVyOiAiK2UubWVzc2FnZSk7fQogICAgZmluYWxseXtjbGltYXRlQnVzeT1mYWxzZTtyZW5kZXJDbGltYXRlQW5hbHlzaXMoKTtyZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7fQogIH0KCiAgZnVuY3Rpb24gc2FmZUpzb25QYXJzZSh2YWx1ZSwgZmFsbGJhY2s9bnVsbCl7IHRyeXtyZXR1cm4gSlNPTi5wYXJzZSh2YWx1ZSk7fWNhdGNoe3JldHVybiBmYWxsYmFjazt9IH0KICBmdW5jdGlvbiBudWxsYWJsZU51bWJlcih2YWx1ZSl7IGlmKHZhbHVlPT09IiJ8fHZhbHVlPT09bnVsbHx8dmFsdWU9PT11bmRlZmluZWQpcmV0dXJuIG51bGw7IGNvbnN0IG49TnVtYmVyKHZhbHVlKTsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKT9uOm51bGw7IH0KICBmdW5jdGlvbiBzb3J0ZWQoaXRlbXM9cmVjb3Jkcyl7IHJldHVybiBbLi4uaXRlbXNdLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7IH0KICBmdW5jdGlvbiBjdXJyZW50TW9udGhLZXkoKXsgY29uc3QgZD1uZXcgRGF0ZSgpOyByZXR1cm4gYCR7ZC5nZXRGdWxsWWVhcigpfS0ke1N0cmluZyhkLmdldE1vbnRoKCkrMSkucGFkU3RhcnQoMiwiMCIpfWA7IH0KICBmdW5jdGlvbiBtb250aExhYmVsKG1vbnRoLGxvbmc9dHJ1ZSl7IGNvbnN0IFt5LG1dPVN0cmluZyhtb250aCkuc3BsaXQoIi0iKS5tYXAoTnVtYmVyKTsgaWYoIXl8fCFtKXJldHVybiBtb250aDsgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIsbG9uZz97bW9udGg6ImxvbmciLHllYXI6Im51bWVyaWMifTp7bW9udGg6InNob3J0Iix5ZWFyOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZSh5LG0tMSwxKSk7IH0KICBmdW5jdGlvbiBudW0odmFsdWUsZGlnaXRzPTApeyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcih2YWx1ZSkpP25ldyBJbnRsLk51bWJlckZvcm1hdCgiZGUtREUiLHttaW5pbXVtRnJhY3Rpb25EaWdpdHM6ZGlnaXRzLG1heGltdW1GcmFjdGlvbkRpZ2l0czpkaWdpdHN9KS5mb3JtYXQoTnVtYmVyKHZhbHVlKSk6IuKAkyI7IH0KICBmdW5jdGlvbiBldXJvKHZhbHVlKXsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIodmFsdWUpKT9uZXcgSW50bC5OdW1iZXJGb3JtYXQoImRlLURFIix7c3R5bGU6ImN1cnJlbmN5IixjdXJyZW5jeToiRVVSIn0pLmZvcm1hdChOdW1iZXIodmFsdWUpKToi4oCTIjsgfQogIGZ1bmN0aW9uIHBjdCh2YWx1ZSl7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHZhbHVlKSk/YCR7dmFsdWU+MD8iKyI6IiJ9JHtudW0odmFsdWUsMSl9ICVgOiLigJMiOyB9CiAgZnVuY3Rpb24gZXNjYXBlSHRtbCh2YWx1ZSl7IHJldHVybiBTdHJpbmcodmFsdWU/PyIiKS5yZXBsYWNlKC9bJjw+IiddL2csY2g9Pih7IiYiOiImYW1wOyIsIjwiOiImbHQ7IiwiPiI6IiZndDsiLCJcIiI6IiZxdW90OyIsIiciOiImIzM5OyJ9W2NoXSkpOyB9CiAgZnVuY3Rpb24gY3N2Q2VsbCh2YWx1ZSl7IGNvbnN0IHM9U3RyaW5nKHZhbHVlPz8iIik7IHJldHVybiBgIiR7cy5yZXBsYWNlKC8iL2csJyIiJyl9ImA7IH0KICBmdW5jdGlvbiBkYXRlU3RhbXAoKXsgY29uc3QgZD1uZXcgRGF0ZSgpOyByZXR1cm4gYCR7ZC5nZXRGdWxsWWVhcigpfS0ke1N0cmluZyhkLmdldE1vbnRoKCkrMSkucGFkU3RhcnQoMiwiMCIpfS0ke1N0cmluZyhkLmdldERhdGUoKSkucGFkU3RhcnQoMiwiMCIpfWA7IH0KCiAgZnVuY3Rpb24gc2FuaXRpemVSZWNvcmQocmF3KXsKICAgIGNvbnN0IG1vbnRoPVN0cmluZyhyYXc/Lm1vbnRofHwiIik7CiAgICBpZighL15cZHs0fS1cZHsyfSQvLnRlc3QobW9udGgpKXJldHVybiBudWxsOwogICAgcmV0dXJuIHsKICAgICAgbW9udGgsCiAgICAgIGhlYXRQdW1wOm51bGxhYmxlTnVtYmVyKHJhdy5oZWF0UHVtcCksCiAgICAgIGFubmV4Om51bGxhYmxlTnVtYmVyKHJhdy5hbm5leCksCiAgICAgIHRvdGFsOm51bGxhYmxlTnVtYmVyKHJhdy50b3RhbCksCiAgICAgIHByaWNlQ3Q6bnVsbGFibGVOdW1iZXIocmF3LnByaWNlQ3QgPz8gcmF3LmF2ZXJhZ2VQcmljZUN0KSwKICAgICAgYmFzZUZlZTpudWxsYWJsZU51bWJlcihyYXcuYmFzZUZlZSksCiAgICAgIG5vdGU6U3RyaW5nKHJhdy5ub3RlfHwiIikudHJpbSgpLnNsaWNlKDAsODAwKSwKICAgICAgaGVhdEdlbmVyYXRlZDpudWxsYWJsZU51bWJlcihyYXcuaGVhdEdlbmVyYXRlZCksCiAgICAgIGhlYXRpbmdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcihyYXcuaGVhdGluZ0VsZWN0cmljaXR5KSwKICAgICAgZGh3RWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIocmF3LmRod0VsZWN0cmljaXR5KSwKICAgICAgaGVhdGluZ0hlYXQ6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRpbmdIZWF0KSwKICAgICAgZGh3SGVhdDpudWxsYWJsZU51bWJlcihyYXcuZGh3SGVhdCksCiAgICAgIGhlYXRQdW1wU291cmNlOlN0cmluZyhyYXcuaGVhdFB1bXBTb3VyY2V8fCIiKS5zbGljZSgwLDYwKSwKICAgICAgaGVhdFB1bXBVcGRhdGVkQXQ6cmF3LmhlYXRQdW1wVXBkYXRlZEF0P1N0cmluZyhyYXcuaGVhdFB1bXBVcGRhdGVkQXQpOm51bGwsCiAgICAgIG1ldGVyUmVhZGluZ0RhdGU6cmF3Lm1ldGVyUmVhZGluZ0RhdGU/U3RyaW5nKHJhdy5tZXRlclJlYWRpbmdEYXRlKTpudWxsLAogICAgICBwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6cmF3LnByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZT9TdHJpbmcocmF3LnByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZSk6bnVsbCwKICAgICAgdG90YWxNZXRlclJlYWRpbmc6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsTWV0ZXJSZWFkaW5nKSwKICAgICAgYW5uZXhNZXRlclJlYWRpbmc6bnVsbGFibGVOdW1iZXIocmF3LmFubmV4TWV0ZXJSZWFkaW5nKSwKICAgICAgbWV0ZXJTb3VyY2U6U3RyaW5nKHJhdy5tZXRlclNvdXJjZXx8IiIpLnNsaWNlKDAsNjApLAogICAgICBwcmljZVNvdXJjZTpTdHJpbmcocmF3LnByaWNlU291cmNlfHwiIikuc2xpY2UoMCw4MCksCiAgICAgIHByaWNlVXBkYXRlZEF0OnJhdy5wcmljZVVwZGF0ZWRBdD9TdHJpbmcocmF3LnByaWNlVXBkYXRlZEF0KTpudWxsLAogICAgICBvc3Ryb21WYXJpYWJsZUNvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3Lm9zdHJvbVZhcmlhYmxlQ29zdEV1ciksCiAgICAgIG9zdHJvbVRvdGFsQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tVG90YWxDb3N0RXVyKSwKICAgICAgb3N0cm9tQ29uc3VtcHRpb25LV2g6bnVsbGFibGVOdW1iZXIocmF3Lm9zdHJvbUNvbnN1bXB0aW9uS1doKSwKICAgICAgb3N0cm9tUHJpY2VDb21wbGV0ZTpCb29sZWFuKHJhdy5vc3Ryb21QcmljZUNvbXBsZXRlKSwKICAgICAgdXBkYXRlZEF0OnJhdy51cGRhdGVkQXQ/U3RyaW5nKHJhdy51cGRhdGVkQXQpOm51bGwsCiAgICAgIGNsb3NlZDpCb29sZWFuKHJhdy5jbG9zZWQpLAogICAgICBjbG9zZWRBdDpyYXcuY2xvc2VkQXQ/U3RyaW5nKHJhdy5jbG9zZWRBdCk6bnVsbAogICAgfTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVSZWNvcmRzKGl0ZW1zKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgcmF3IG9mIEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKXsgY29uc3Qgcj1zYW5pdGl6ZVJlY29yZChyYXcpOyBpZihyKW1hcC5zZXQoci5tb250aCxyKTsgfQogICAgcmV0dXJuIFsuLi5tYXAudmFsdWVzKCldLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7CiAgfQogIGZ1bmN0aW9uIGRlcml2ZWQocil7IGlmKCFbcj8uaGVhdFB1bXAscj8uYW5uZXgscj8udG90YWxdLmV2ZXJ5KE51bWJlci5pc0Zpbml0ZSkpcmV0dXJuIG51bGw7IHJldHVybiByLnRvdGFsLXIuaGVhdFB1bXAtci5hbm5leDsgfQogIGZ1bmN0aW9uIGNvbXBsZXRlKHIpeyBjb25zdCByZXN0PWRlcml2ZWQocik7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q+PTA7IH0KICBmdW5jdGlvbiByZWNvcmRDb3N0KHIpewogICAgaWYoTnVtYmVyLmlzRmluaXRlKHI/Lm9zdHJvbVRvdGFsQ29zdEV1cikmJnI/Lm9zdHJvbVByaWNlQ29tcGxldGUpcmV0dXJuIE51bWJlcihyLm9zdHJvbVRvdGFsQ29zdEV1cik7CiAgICBpZighTnVtYmVyLmlzRmluaXRlKHI/LnRvdGFsKSlyZXR1cm4gbnVsbDsKICAgIGNvbnN0IHByaWNlPU51bWJlci5pc0Zpbml0ZShyLnByaWNlQ3QpP3IucHJpY2VDdC8xMDA6TnVtYmVyKHNldHRpbmdzLmZhbGxiYWNrUHJpY2V8fDAuMzIpOwogICAgY29uc3QgYmFzZT1OdW1iZXIuaXNGaW5pdGUoci5iYXNlRmVlKT9yLmJhc2VGZWU6TnVtYmVyKHNldHRpbmdzLmRlZmF1bHRCYXNlRmVlfHwwKTsKICAgIHJldHVybiByLnRvdGFsKnByaWNlK2Jhc2U7CiAgfQogIGZ1bmN0aW9uIHJlY29yZENvcChyKXsgcmV0dXJuIE51bWJlcihyPy5oZWF0UHVtcCk+MCYmTnVtYmVyLmlzRmluaXRlKE51bWJlcihyPy5oZWF0R2VuZXJhdGVkKSk/TnVtYmVyKHIuaGVhdEdlbmVyYXRlZCkvTnVtYmVyKHIuaGVhdFB1bXApOm51bGw7IH0KCiAgZnVuY3Rpb24gcmF3U2V0dGluZ3MoKXsgY29uc3Qgdj1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNFVFRJTkdTX0tFWSkse30pOyByZXR1cm4gdiYmdHlwZW9mIHY9PT0ib2JqZWN0IiYmIUFycmF5LmlzQXJyYXkodik/djp7fTsgfQogIGZ1bmN0aW9uIGxvYWRTZXR0aW5ncygpewogICAgY29uc3QgcmF3PXJhd1NldHRpbmdzKCk7CiAgICByZXR1cm4gewogICAgICAuLi5yYXcsCiAgICAgIGZhbGxiYWNrUHJpY2U6TnVtYmVyLmlzRmluaXRlKE51bWJlcihyYXcuZmFsbGJhY2tQcmljZSkpP051bWJlcihyYXcuZmFsbGJhY2tQcmljZSk6TnVtYmVyLmlzRmluaXRlKE51bWJlcihyYXcucHJpY2UpKT9OdW1iZXIocmF3LnByaWNlKTowLjMyLAogICAgICBkZWZhdWx0QmFzZUZlZTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5kZWZhdWx0QmFzZUZlZSkpP051bWJlcihyYXcuZGVmYXVsdEJhc2VGZWUpOjAsCiAgICAgIG9zdHJvbUFwcEtleTpTdHJpbmcocmF3Lm9zdHJvbUFwcEtleXx8IiIpLAogICAgICBvc3Ryb21BdXRvUmVmcmVzaDpyYXcub3N0cm9tQXV0b1JlZnJlc2ghPT1mYWxzZSwKICAgICAgcHJlZmVycmVkV2luZG93SG91cnM6WzEsMiwzLDRdLmluY2x1ZGVzKE51bWJlcihyYXcucHJlZmVycmVkV2luZG93SG91cnMpKT9OdW1iZXIocmF3LnByZWZlcnJlZFdpbmRvd0hvdXJzKTozCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYXZlU2V0dGluZ3MoKXsKICAgIGNvbnN0IHByZXZpb3VzPXJhd1NldHRpbmdzKCk7CiAgICBjb25zdCBtZXJnZWQ9ey4uLnByZXZpb3VzLAogICAgICBmYWxsYmFja1ByaWNlOk51bWJlcihzZXR0aW5ncy5mYWxsYmFja1ByaWNlKXx8MCwKICAgICAgZGVmYXVsdEJhc2VGZWU6TnVtYmVyKHNldHRpbmdzLmRlZmF1bHRCYXNlRmVlKXx8MCwKICAgICAgb3N0cm9tQXBwS2V5OlN0cmluZyhzZXR0aW5ncy5vc3Ryb21BcHBLZXl8fCIiKSwKICAgICAgb3N0cm9tQXV0b1JlZnJlc2g6c2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2ghPT1mYWxzZSwKICAgICAgcHJlZmVycmVkV2luZG93SG91cnM6WzEsMiwzLDRdLmluY2x1ZGVzKE51bWJlcihzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3VycykpP051bWJlcihzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vycyk6MwogICAgfTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNFVFRJTkdTX0tFWSxKU09OLnN0cmluZ2lmeShtZXJnZWQpKTsKICAgIHNldHRpbmdzPXsuLi5zZXR0aW5ncywuLi5tZXJnZWR9OwogIH0KCiAgZnVuY3Rpb24gcmVhZFByaW1hcnlSZWNvcmRzKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKERBVEFfS0VZKSxudWxsKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9zYW5pdGl6ZVJlY29yZHMocmF3KTpudWxsOyB9CiAgZnVuY3Rpb24gcmVhZFNoYWRvd1JlY29yZHMoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU0hBRE9XX0tFWSksbnVsbCk7IHJldHVybiBBcnJheS5pc0FycmF5KHJhdyk/c2FuaXRpemVSZWNvcmRzKHJhdyk6W107IH0KICBmdW5jdGlvbiBsb2FkUmVjb3JkcygpewogICAgY29uc3QgcHJpbWFyeT1yZWFkUHJpbWFyeVJlY29yZHMoKTsKICAgIGlmKHByaW1hcnkhPT1udWxsKXJldHVybiBwcmltYXJ5OwogICAgZm9yKGNvbnN0IGtleSBvZiBbImVsZGVob2YtdjEtZGF0YSIsImVuZXJoYXVzLXYxLWRhdGEiXSl7CiAgICAgIGNvbnN0IGxlZ2FjeT1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKGtleSksbnVsbCk7CiAgICAgIGlmKEFycmF5LmlzQXJyYXkobGVnYWN5KSl7CiAgICAgICAgY29uc3QgbWlncmF0ZWQ9c2FuaXRpemVSZWNvcmRzKGxlZ2FjeSk7CiAgICAgICAgaWYobWlncmF0ZWQubGVuZ3RoKWxvY2FsU3RvcmFnZS5zZXRJdGVtKERBVEFfS0VZLEpTT04uc3RyaW5naWZ5KG1pZ3JhdGVkKSk7CiAgICAgICAgcmV0dXJuIG1pZ3JhdGVkOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gW107CiAgfQogIGZ1bmN0aW9uIHNhdmVSZWNvcmRzKG5leHQse3JlYXNvbj0iw4RuZGVydW5nIixhbGxvd0VtcHR5PWZhbHNlfT17fSl7CiAgICBjb25zdCBjbGVhbj1zYW5pdGl6ZVJlY29yZHMobmV4dCk7CiAgICBjb25zdCBwcmV2aW91cz1yZWFkUHJpbWFyeVJlY29yZHMoKXx8W107CiAgICBpZighYWxsb3dFbXB0eSAmJiBwcmV2aW91cy5sZW5ndGg+MCAmJiBjbGVhbi5sZW5ndGg9PT0wKXRocm93IG5ldyBFcnJvcigiTGVlcmVyIE1vbmF0c2Jlc3RhbmQgd2lyZCBhdXMgU2ljaGVyaGVpdHNncsO8bmRlbiBuaWNodCBhdXRvbWF0aXNjaCBnZXNwZWljaGVydC4iKTsKICAgIGlmKHByZXZpb3VzLmxlbmd0aCl7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNIQURPV19LRVksSlNPTi5zdHJpbmdpZnkocHJldmlvdXMpKTsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0hBRE9XX01FVEFfS0VZLEpTT04uc3RyaW5naWZ5KHtzYXZlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxyZWFzb24scmVjb3JkczpwcmV2aW91cy5sZW5ndGh9KSk7CiAgICB9CiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShEQVRBX0tFWSxKU09OLnN0cmluZ2lmeShjbGVhbikpOwogICAgcmVjb3Jkcz1jbGVhbjsKICAgIHVwZGF0ZVJlY292ZXJ5QmFubmVyKCk7CiAgICBpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKCk7CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplTWV0ZXJSZWFkaW5nKHJhdyl7CiAgICBjb25zdCBkYXRlPVN0cmluZyhyYXc/LmRhdGV8fCIiKTsKICAgIGNvbnN0IHRvdGFsPW51bGxhYmxlTnVtYmVyKHJhdz8udG90YWwpLGFubmV4PW51bGxhYmxlTnVtYmVyKHJhdz8uYW5uZXgpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0tXGR7Mn0kLy50ZXN0KGRhdGUpfHwhTnVtYmVyLmlzRmluaXRlKHRvdGFsKXx8IU51bWJlci5pc0Zpbml0ZShhbm5leCl8fHRvdGFsPDB8fGFubmV4PDApcmV0dXJuIG51bGw7CiAgICByZXR1cm4ge2RhdGUsdG90YWwsYW5uZXgsbm90ZTpTdHJpbmcocmF3Py5ub3RlfHwiIikuc2xpY2UoMCwxODApLHVwZGF0ZWRBdDpyYXc/LnVwZGF0ZWRBdD9TdHJpbmcocmF3LnVwZGF0ZWRBdCk6bnVsbH07CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplTWV0ZXJSZWFkaW5ncyhpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHJhdyBvZiBBcnJheS5pc0FycmF5KGl0ZW1zKT9pdGVtczpbXSl7Y29uc3Qgcj1zYW5pdGl6ZU1ldGVyUmVhZGluZyhyYXcpO2lmKHIpbWFwLnNldChyLmRhdGUscik7fQogICAgcmV0dXJuIFsuLi5tYXAudmFsdWVzKCldLnNvcnQoKGEsYik9PmEuZGF0ZS5sb2NhbGVDb21wYXJlKGIuZGF0ZSkpOwogIH0KICBmdW5jdGlvbiBsb2FkTWV0ZXJSZWFkaW5ncygpe3JldHVybiBzYW5pdGl6ZU1ldGVyUmVhZGluZ3Moc2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShNRVRFUl9LRVkpLFtdKSk7fQogIGZ1bmN0aW9uIHNhdmVNZXRlclJlYWRpbmdzKG5leHQse3RvdWNoPXRydWUsdGltZXN0YW1wPW51bGx9PXt9KXttZXRlclJlYWRpbmdzPXNhbml0aXplTWV0ZXJSZWFkaW5ncyhuZXh0KTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShNRVRFUl9LRVksSlNPTi5zdHJpbmdpZnkobWV0ZXJSZWFkaW5ncykpO2lmKHRvdWNoKWxvY2FsU3RvcmFnZS5zZXRJdGVtKE1FVEVSX01FVEFfS0VZLHRpbWVzdGFtcHx8bmV3IERhdGUoKS50b0lTT1N0cmluZygpKTtpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKCk7fQogIGZ1bmN0aW9uIGxhdGVzdE1ldGVyUmVhZGluZygpe3JldHVybiBtZXRlclJlYWRpbmdzLmF0KC0xKXx8bnVsbDt9CiAgZnVuY3Rpb24gZGF0ZUxhYmVsKHZhbHVlKXtjb25zdCBkPW5ldyBEYXRlKGAke3ZhbHVlfVQxMjowMDowMGApO3JldHVybiBOdW1iZXIuaXNOYU4oZC52YWx1ZU9mKCkpP3ZhbHVlOm5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2RheToiMi1kaWdpdCIsbW9udGg6IjItZGlnaXQiLHllYXI6Im51bWVyaWMifSkuZm9ybWF0KGQpO30KICBmdW5jdGlvbiBuZXh0TW9udGhGaXJzdChkYXRlKXtjb25zdCBbeSxtXT1TdHJpbmcoZGF0ZSkuc3BsaXQoIi0iKS5tYXAoTnVtYmVyKTtjb25zdCBkPW5ldyBEYXRlKHksbSwxKTtyZXR1cm4gYCR7ZC5nZXRGdWxsWWVhcigpfS0ke1N0cmluZyhkLmdldE1vbnRoKCkrMSkucGFkU3RhcnQoMiwiMCIpfS0wMWA7fQogIGZ1bmN0aW9uIGFwcGx5SGlzdG9yaWNhbFNlZWQoKXsKICAgIGlmKGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUllfU0VFRF9LRVkpKXJldHVybjsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKHJlY29yZHMubWFwKHI9PltyLm1vbnRoLHsuLi5yfV0pKTsKICAgIGNvbnN0IG1vbnRocz1bLi4ubmV3IFNldChbLi4uT2JqZWN0LmtleXMoSElTVE9SSUNBTF9TRUVELnRvdGFsKSwuLi5PYmplY3Qua2V5cyhISVNUT1JJQ0FMX1NFRUQuYW5uZXgpLC4uLk9iamVjdC5rZXlzKEhJU1RPUklDQUxfU0VFRC5oZWF0UHVtcCldKV0uc29ydCgpOwogICAgZm9yKGNvbnN0IG1vbnRoIG9mIG1vbnRocyl7CiAgICAgIGNvbnN0IHI9bWFwLmdldChtb250aCl8fHNhbml0aXplUmVjb3JkKHttb250aH0pOwogICAgICBpZihPYmplY3QuaGFzT3duKEhJU1RPUklDQUxfU0VFRC50b3RhbCxtb250aCkpci50b3RhbD1ISVNUT1JJQ0FMX1NFRUQudG90YWxbbW9udGhdOwogICAgICBpZihPYmplY3QuaGFzT3duKEhJU1RPUklDQUxfU0VFRC5hbm5leCxtb250aCkpci5hbm5leD1ISVNUT1JJQ0FMX1NFRUQuYW5uZXhbbW9udGhdOwogICAgICBpZihPYmplY3QuaGFzT3duKEhJU1RPUklDQUxfU0VFRC5oZWF0UHVtcCxtb250aCkpewogICAgICAgIGNvbnN0IHNlZWQ9SElTVE9SSUNBTF9TRUVELmhlYXRQdW1wW21vbnRoXTsKICAgICAgICBjb25zdCBrZWVwRXhpc3Rpbmc9TnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApJiZNYXRoLmFicyhyLmhlYXRQdW1wLXNlZWQpPD0yOwogICAgICAgIGlmKCFrZWVwRXhpc3Rpbmcpci5oZWF0UHVtcD1zZWVkOwogICAgICAgIGlmKCFyLmhlYXRQdW1wU291cmNlKXIuaGVhdFB1bXBTb3VyY2U9Imhpc3RvcmljYWwtdXNlci1kYXRhIjsKICAgICAgfQogICAgICBpZihtb250aD09PSIyMDI0LTAzIil7CiAgICAgICAgY29uc3Qgbm90ZT0iWsOkaGxlcndlY2hzZWwgR2VzYW10c3Ryb20gYW0gMDEuMDQuMjAyNDogYWx0ZXIgWsOkaGxlciA2Mi4yOTYga1doLCBuZXVlciBaw6RobGVyIDE5NyBrV2g7IE1vbmF0c3ZlcmJyYXVjaCBrb3JyZWt0IG1pdCAxLjMyMCBrV2ggYmVyw7xja3NpY2h0aWd0LiI7CiAgICAgICAgaWYoIVN0cmluZyhyLm5vdGV8fCIiKS5pbmNsdWRlcygiWsOkaGxlcndlY2hzZWwgR2VzYW10c3Ryb20iKSlyLm5vdGU9ci5ub3RlP2Ake3Iubm90ZX0g4oCiICR7bm90ZX1gOm5vdGU7CiAgICAgIH0KICAgICAgaWYobW9udGg9PT0iMjAyMy0xMiImJiFyLm5vdGUpci5ub3RlPSJIaXN0b3Jpc2NoIGlzdCBmw7xyIERlemVtYmVyIDIwMjMgbnVyIGRlciBXw6RybWVwdW1wZW52ZXJicmF1Y2ggZG9rdW1lbnRpZXJ0LiI7CiAgICAgIG1hcC5zZXQobW9udGgscik7CiAgICB9CiAgICBzYXZlUmVjb3JkcyhbLi4ubWFwLnZhbHVlcygpXSx7cmVhc29uOiJIaXN0b3Jpc2NoZSBWZXJicmF1Y2hzZGF0ZW4gMjAyNOKAkzA5LzIwMjYgw7xiZXJub21tZW4ifSk7CiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZX1NFRURfS0VZLG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7CiAgfQogIGZ1bmN0aW9uIGVuc3VyZU1ldGVyQmFzZWxpbmUoKXsKICAgIGlmKG1ldGVyUmVhZGluZ3Muc29tZShyPT5yLmRhdGU9PT1CQVNFTElORV9NRVRFUl9SRUFESU5HLmRhdGUpKXJldHVybjsKICAgIGlmKG1ldGVyUmVhZGluZ3MubGVuZ3RoPT09MClzYXZlTWV0ZXJSZWFkaW5ncyhbQkFTRUxJTkVfTUVURVJfUkVBRElOR10se3RvdWNoOmZhbHNlfSk7CiAgfQogIGZ1bmN0aW9uIGxvYWRWYWlsbGFudE1vbnRocygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShWQUlMTEFOVF9NT05USFNfS0VZKSxbXSk7IHJldHVybiBBcnJheS5pc0FycmF5KHJhdyk/cmF3OltdOyB9CiAgZnVuY3Rpb24gc2F2ZVZhaWxsYW50TW9udGhzKCl7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFZBSUxMQU5UX01PTlRIU19LRVksSlNPTi5zdHJpbmdpZnkoQXJyYXkuaXNBcnJheSh2YWlsbGFudE1vbnRocyk/dmFpbGxhbnRNb250aHM6W10pKTsgaWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygpOyB9CiAgZnVuY3Rpb24gbG9hZE9zdHJvbUNhY2hlKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE9TVFJPTV9DQUNIRV9LRVkpLG51bGwpOyByZXR1cm4gcmF3JiZyYXcuZ2VuZXJhdGVkQXQ/cmF3Om51bGw7IH0KICBmdW5jdGlvbiBzYXZlT3N0cm9tQ2FjaGUocGF5bG9hZCl7IG9zdHJvbUxpdmU9cGF5bG9hZHx8bnVsbDsgaWYocGF5bG9hZClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShPU1RST01fQ0FDSEVfS0VZLEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTsgZWxzZSBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShPU1RST01fQ0FDSEVfS0VZKTsgaWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygxODAwKTsgfQogIGZ1bmN0aW9uIHNhbml0aXplT3N0cm9tUHJpY2VTdGF0KHJhdyl7CiAgICBjb25zdCBtb250aD1TdHJpbmcocmF3Py5tb250aHx8IiIpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0kLy50ZXN0KG1vbnRoKSlyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7CiAgICAgIG1vbnRoLAogICAgICB3ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaDpudWxsYWJsZU51bWJlcihyYXcud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2ggPz8gcmF3LnByaWNlQ3QpLAogICAgICB0b3RhbEtXaDpudWxsYWJsZU51bWJlcihyYXcudG90YWxLV2ggPz8gcmF3Lm9zdHJvbUNvbnN1bXB0aW9uS1doKSwKICAgICAgdmFyaWFibGVDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy52YXJpYWJsZUNvc3RFdXIgPz8gcmF3Lm9zdHJvbVZhcmlhYmxlQ29zdEV1ciksCiAgICAgIGZpeGVkQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcuZml4ZWRDb3N0RXVyID8/IHJhdy5iYXNlRmVlKSwKICAgICAgdG90YWxDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy50b3RhbENvc3RFdXIgPz8gcmF3Lm9zdHJvbVRvdGFsQ29zdEV1ciksCiAgICAgIGNvbXBsZXRlOkJvb2xlYW4ocmF3LmNvbXBsZXRlID8/IHJhdy5vc3Ryb21QcmljZUNvbXBsZXRlKSwKICAgICAgcGFydGlhbDpCb29sZWFuKHJhdy5wYXJ0aWFsKSwKICAgICAgdXBkYXRlZEF0OlN0cmluZyhyYXcudXBkYXRlZEF0fHxyYXcucHJpY2VVcGRhdGVkQXR8fCIiKQogICAgfTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKGl0ZW1zKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgcmF3IG9mIEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKXtjb25zdCBpdGVtPXNhbml0aXplT3N0cm9tUHJpY2VTdGF0KHJhdyk7aWYoaXRlbSltYXAuc2V0KGl0ZW0ubW9udGgsaXRlbSk7fQogICAgcmV0dXJuIFsuLi5tYXAudmFsdWVzKCldLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7CiAgfQogIGZ1bmN0aW9uIGxvYWRPc3Ryb21QcmljZVN0YXRzKCl7IHJldHVybiBzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdHMoc2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShPU1RST01fUFJJQ0VfU1RBVFNfS0VZKSxbXSkpOyB9CiAgZnVuY3Rpb24gc2F2ZU9zdHJvbVByaWNlU3RhdHMoaXRlbXMpeyBvc3Ryb21QcmljZVN0YXRzPXNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhpdGVtcyk7bG9jYWxTdG9yYWdlLnNldEl0ZW0oT1NUUk9NX1BSSUNFX1NUQVRTX0tFWSxKU09OLnN0cmluZ2lmeShvc3Ryb21QcmljZVN0YXRzKSk7aWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygxMjAwKTsgfQogIGZ1bmN0aW9uIHVwc2VydE9zdHJvbVByaWNlU3RhdChtb250aCxkYXRhLHtwYXJ0aWFsPWZhbHNlfT17fSl7CiAgICBpZighL15cZHs0fS1cZHsyfSQvLnRlc3QoU3RyaW5nKG1vbnRofHwiIikpKXJldHVybjsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKG9zdHJvbVByaWNlU3RhdHMubWFwKGl0ZW09PltpdGVtLm1vbnRoLGl0ZW1dKSk7CiAgICBtYXAuc2V0KG1vbnRoLHNhbml0aXplT3N0cm9tUHJpY2VTdGF0KHsKICAgICAgbW9udGgsd2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2g6TnVtYmVyKGRhdGE/LndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSx0b3RhbEtXaDpOdW1iZXIoZGF0YT8udG90YWxLV2gpLHZhcmlhYmxlQ29zdEV1cjpOdW1iZXIoZGF0YT8udmFyaWFibGVDb3N0RXVyKSxmaXhlZENvc3RFdXI6TnVtYmVyKGRhdGE/LmZpeGVkQ29zdEV1ciksdG90YWxDb3N0RXVyOk51bWJlcihkYXRhPy50b3RhbENvc3RFdXIpLGNvbXBsZXRlOkJvb2xlYW4oZGF0YT8uY29tcGxldGUpLHBhcnRpYWwsdXBkYXRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKQogICAgfSkpOwogICAgc2F2ZU9zdHJvbVByaWNlU3RhdHMoWy4uLm1hcC52YWx1ZXMoKV0pOwogIH0KCiAgZnVuY3Rpb24gdXBkYXRlUmVjb3ZlcnlCYW5uZXIoKXsKICAgIGNvbnN0IHByaW1hcnk9cmVhZFByaW1hcnlSZWNvcmRzKCk7CiAgICBjb25zdCBzaGFkb3c9cmVhZFNoYWRvd1JlY29yZHMoKTsKICAgIGNvbnN0IHNob3c9KCFwcmltYXJ5fHxwcmltYXJ5Lmxlbmd0aD09PTApJiZzaGFkb3cubGVuZ3RoPjA7CiAgICAkKCJyZWNvdmVyeUJhbm5lciIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIXNob3cpOwogIH0KICBmdW5jdGlvbiByZXN0b3JlU2hhZG93KCl7CiAgICBjb25zdCBzaGFkb3c9cmVhZFNoYWRvd1JlY29yZHMoKTsKICAgIGlmKCFzaGFkb3cubGVuZ3RoKXJldHVybjsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKERBVEFfS0VZLEpTT04uc3RyaW5naWZ5KHNoYWRvdykpOwogICAgcmVjb3Jkcz1zaGFkb3c7CiAgICB0b2FzdChgJHtzaGFkb3cubGVuZ3RofSBNb25hdHN3ZXJ0ZSB3aWVkZXJoZXJnZXN0ZWxsdGApOwogICAgcmVuZGVyQWxsKCk7CiAgfQoKICBmdW5jdGlvbiB0b2FzdChtZXNzYWdlKXsgY2xlYXJUaW1lb3V0KHRvYXN0VGltZXIpOyAkKCJ0b2FzdCIpLnRleHRDb250ZW50PW1lc3NhZ2U7ICQoInRvYXN0IikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7IHRvYXN0VGltZXI9c2V0VGltZW91dCgoKT0+JCgidG9hc3QiKS5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKSwyNjAwKTsgfQogIGZ1bmN0aW9uIHNldFN0YXR1cyhpZCx0ZXh0LGtpbmQ9IiIpeyBjb25zdCBlbD0kKGlkKTsgZWwudGV4dENvbnRlbnQ9dGV4dHx8IiI7IGVsLmNsYXNzTmFtZT1gc3RhdHVzLXRleHQgJHtraW5kfWAudHJpbSgpOyB9CgogIGZ1bmN0aW9uIHN3aXRjaFZpZXcoaWQpewogICAgY3VycmVudFZpZXc9aWQ7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIudmlldyIpLmZvckVhY2godj0+di5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLHYuaWQ9PT1pZCkpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLmJvdHRvbS1uYXYgW2RhdGEtbmF2XSIpLmZvckVhY2goYj0+Yi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLGIuZGF0YXNldC5uYXY9PT1pZCkpOwogICAgd2luZG93LnNjcm9sbFRvKHt0b3A6MCxiZWhhdmlvcjoiaW5zdGFudCJ9KTsKICAgIGlmKGlkPT09ImFuYWx5c2lzVmlldyIpcmVuZGVyQW5hbHlzaXMoKTsKICAgIGlmKGlkPT09ImNvbnN1bXB0aW9uVmlldyIpcmVuZGVyUmVjb3JkcygpOwogICAgaWYoaWQ9PT0iZGF0YVZpZXciKXJlbmRlckRhdGEoKTsKICAgIGlmKGlkPT09ImRhc2hib2FyZFZpZXciKXJlbmRlckRhc2hib2FyZCgpOwogIH0KCiAgZnVuY3Rpb24geWVhcnMoKXsgcmV0dXJuIFsuLi5uZXcgU2V0KHJlY29yZHMubWFwKHI9Pk51bWJlcihyLm1vbnRoLnNsaWNlKDAsNCkpKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKSldLnNvcnQoKGEsYik9PmItYSk7IH0KICBmdW5jdGlvbiBsYXRlc3RSZWNvcmQoKXsgcmV0dXJuIHNvcnRlZCgpLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpLmF0KC0xKXx8c29ydGVkKCkuYXQoLTEpfHxudWxsOyB9CiAgZnVuY3Rpb24gcmVjb3JkRm9yTW9udGgobW9udGgpeyByZXR1cm4gcmVjb3Jkcy5maW5kKHI9PnIubW9udGg9PT1tb250aCl8fG51bGw7IH0KCgogIC8qIEVsZGVob2YgNi4zLjE6IGNsaW1hdGUgb3ZlcnZpZXcsIGJhc2VkIGV4Y2x1c2l2ZWx5IG9uIGV4aXN0aW5nIGxvY2FsL3N5bmNlZCBtb250aGx5IGRhdGEuICovCiAgbGV0IGRhc2hib2FyZENsaW1hdGVNb2RlPSJoZWF0IjsKICBsZXQgY2xpbWF0ZVdlYXRoZXJFcnJvcj0iIjsKICBmdW5jdGlvbiBkYXNoYm9hcmRDbGltYXRlRGF0YSgpewogICAgY29uc3Qga2V5cz1bLi4ubmV3IFNldChbLi4ucmVjb3Jkcy5tYXAocj0+ci5tb250aCksLi4uY2xpbWF0ZU1vbnRocy5tYXAocj0+ci5tb250aCldKV0KICAgICAgLmZpbHRlcihrPT4vXlxkezR9LVxkezJ9JC8udGVzdChrKSkuc29ydCgpOwogICAgY29uc3QgZW5kPWtleXMuYXQoLTEpfHxjdXJyZW50TW9udGhLZXkoKTsKICAgIGNvbnN0IHllYXI9TnVtYmVyKGVuZC5zbGljZSgwLDQpKSxtb250aD1OdW1iZXIoZW5kLnNsaWNlKDUsNykpOwogICAgcmV0dXJuIEFycmF5LmZyb20oe2xlbmd0aDo2fSwoXyxpKT0+ewogICAgICBjb25zdCBkPW5ldyBEYXRlKHllYXIsbW9udGgtNitpLDEpOwogICAgICBjb25zdCBrZXk9ZC5nZXRGdWxsWWVhcigpKyItIitTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsIjAiKTsKICAgICAgY29uc3Qgdj1jbGltYXRlUm93c0ZvcihkLmdldEZ1bGxZZWFyKCkpW2QuZ2V0TW9udGgoKV07CiAgICAgIGNvbnN0IHJlY29yZD1yZWNvcmRGb3JNb250aChrZXkpOwogICAgICBjb25zdCBwYXJ0aWFsPVN0cmluZyhyZWNvcmQ/LmhlYXRQdW1wU291cmNlfHwiIikuaW5jbHVkZXMoInBhcnRpYWwiKTsKICAgICAgY29uc3Qgb3V0ZG9vcj1OdW1iZXIuaXNGaW5pdGUodi5zZW5zb3I/Lm91dGRvb3JNZWFuKT92LnNlbnNvci5vdXRkb29yTWVhbjoKICAgICAgICBOdW1iZXIuaXNGaW5pdGUodi53Py5tZWFuVGVtcCk/di53Lm1lYW5UZW1wOm51bGw7CiAgICAgIHJldHVybiB7bW9udGg6a2V5LGxhYmVsOk1PTlRIU1tkLmdldE1vbnRoKCldLGhlYXQ6cGFydGlhbD9udWxsOnYuaGVhdCwKICAgICAgICBub3JtYWxpemVkOnBhcnRpYWw/bnVsbDp2Lm5vcm1hbGl6ZWQsb3V0ZG9vciwKICAgICAgICByb29tOk51bWJlci5pc0Zpbml0ZSh2LnNlbnNvcj8ucm9vbU1lYW4pP3Yuc2Vuc29yLnJvb21NZWFuOm51bGwsCiAgICAgICAgc3RvcmFnZTpOdW1iZXIuaXNGaW5pdGUodi5zZW5zb3I/LmRod01lYW4pP3Yuc2Vuc29yLmRod01lYW46bnVsbCxwYXJ0aWFsfTsKICAgIH0pOwogIH0KICBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmRDbGltYXRlKCl7CiAgICBpZighJCgiZGFzaGJvYXJkQ2xpbWF0ZVBhbmVsIikpcmV0dXJuOwogICAgY29uc3QgeWVhcj1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk7CiAgICBjb25zdCByb3dzPWNsaW1hdGVSb3dzRm9yKHllYXIpLmZpbHRlcihyPT4hU3RyaW5nKHJlY29yZEZvck1vbnRoKHIubW9udGgpPy5oZWF0UHVtcFNvdXJjZXx8IiIpLmluY2x1ZGVzKCJwYXJ0aWFsIikpOwogICAgY29uc3QgdmFsaWQ9a2V5PT5yb3dzLmZpbHRlcih4PT5OdW1iZXIuaXNGaW5pdGUoeFtrZXldKSk7CiAgICBjb25zdCBoZWF0aW5nPXZhbGlkKCJoZWF0Iiksd2F0ZXI9dmFsaWQoImRodyIpLG5vcm1hbGl6ZWQ9dmFsaWQoIm5vcm1hbGl6ZWQiKTsKICAgIGNvbnN0IHdlYXRoZXI9cm93cy5maWx0ZXIoeD0+eC52YWxpZCk7CiAgICBjb25zdCBzdW09KGl0ZW1zLGtleSk9Pml0ZW1zLnJlZHVjZSgobixyKT0+bityW2tleV0sMCk7CiAgICBjb25zdCBtZXRyaWNzPVsKICAgICAgWyJIZWl6d8Okcm1lIixoZWF0aW5nLmxlbmd0aD9udW0oc3VtKGhlYXRpbmcsImhlYXQiKSwwKSsiIGtXaCI6IuKAkyIsaGVhdGluZy5sZW5ndGgrIiBlcmZhc3N0ZSBNb25hdGUiXSwKICAgICAgWyJXYXJtd2Fzc2VyIix3YXRlci5sZW5ndGg/bnVtKHN1bSh3YXRlciwiZGh3IiksMCkrIiBrV2giOiLigJMiLHdhdGVyLmxlbmd0aCsiIGVyZmFzc3RlIE1vbmF0ZSJdLAogICAgICBbIkhlaXpncmFkdGFnZSIsd2VhdGhlci5sZW5ndGg/bnVtKHdlYXRoZXIucmVkdWNlKChuLHIpPT5uK3Iudy5oZGQxNSwwKSwwKSsiIEvCt2QiOiLigJMiLHdlYXRoZXIubGVuZ3RoKyIgV2V0dGVybW9uYXRlIl0sCiAgICAgIFsiV2l0dGVydW5nc2JlcmVpbmlndCIsbm9ybWFsaXplZC5sZW5ndGg/bnVtKHN1bShub3JtYWxpemVkLCJub3JtYWxpemVkIiksMCkrIiBrV2giOiLigJMiLG5vcm1hbGl6ZWQubGVuZ3RoKyIgdmVyZ2xlaWNoYmFyZSBNb25hdGUiXQogICAgXTsKICAgICQoImRhc2hib2FyZENsaW1hdGVZZWFyIikudGV4dENvbnRlbnQ9IkphbnVhciBiaXMgIitNT05USFNbbmV3IERhdGUoKS5nZXRNb250aCgpXSsiICIreWVhcisiIMK3IG51ciBlcmZhc3N0ZSwgdm9sbHN0w6RuZGlnZSBXZXJ0ZSI7CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlTWV0cmljcyIpLmlubmVySFRNTD1tZXRyaWNzLm1hcChtPT4iPGFydGljbGU+PHNwYW4+Iitlc2NhcGVIdG1sKG1bMF0pKyI8L3NwYW4+PHN0cm9uZz4iK2VzY2FwZUh0bWwobVsxXSkrIjwvc3Ryb25nPjxzbWFsbD4iK2VzY2FwZUh0bWwobVsyXSkrIjwvc21hbGw+PC9hcnRpY2xlPiIpLmpvaW4oIiIpOwogICAgY29uc3QgbGF0ZXN0PWhlYXRpbmcuYXQoLTEpOwogICAgY29uc3QgcHJldmlvdXM9bGF0ZXN0JiZjbGltYXRlUm93c0Zvcih5ZWFyLTEpW051bWJlcihsYXRlc3QubW9udGguc2xpY2UoNSw3KSktMV07CiAgICBjb25zdCBoZWF0aW5nU2Vhc29uPWxhdGVzdCYmWzEsMiwzLDQsMTAsMTEsMTJdLmluY2x1ZGVzKE51bWJlcihsYXRlc3QubW9udGguc2xpY2UoNSw3KSkpOwogICAgY29uc3QgZGVsdGE9aGVhdGluZ1NlYXNvbiYmbGF0ZXN0LmhlYXQ+PTEwMCYmTnVtYmVyLmlzRmluaXRlKHByZXZpb3VzPy5oZWF0KSYmcHJldmlvdXMuaGVhdD49MTAwPyhsYXRlc3QuaGVhdC9wcmV2aW91cy5oZWF0LTEpKjEwMDpudWxsOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVRyZW5kIikudGV4dENvbnRlbnQ9TnVtYmVyLmlzRmluaXRlKGRlbHRhKT8KICAgICAgbW9udGhMYWJlbChsYXRlc3QubW9udGgsZmFsc2UpKyIgZ2VnZW7DvGJlciBWb3JqYWhyIChIZWl6d8Okcm1lLCBuaWNodCBiZXJlaW5pZ3QpOiAiK3BjdChkZWx0YSk6CiAgICAgIChoZWF0aW5nU2Vhc29uPyJGw7xyIGRlbiBWb3JqYWhyZXN0cmVuZCBmZWhsZW4gYXVzcmVpY2hlbmQgYmVsYXN0YmFyZSBIZWl6d8Okcm1lLVdlcnRlLiI6IlNvbW1lcmJldHJpZWI6IEVpbiBIZWl6d8Okcm1lLVZlcmdsZWljaCBpc3QgYmVpIHNlaHIgZ2VyaW5nZW0gSGVpemJlZGFyZiB3ZW5pZyBhdXNzYWdla3LDpGZ0aWcuIik7CiAgICBjb25zdCByZWFkeT1Cb29sZWFuKGNsaW1hdGVXZWF0aGVyPy5bMjAyNF0/LmNvbXBsZXRlJiZjbGltYXRlV2VhdGhlcj8uWzIwMjVdPy5jb21wbGV0ZSk7CiAgICBjb25zdCBidXR0b249JCgiZGFzaGJvYXJkQ2xpbWF0ZVdlYXRoZXJCdG4iKTsKICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHJlYWR5JiYhY2xpbWF0ZVdlYXRoZXJFcnJvcik7CiAgICBidXR0b24uZGlzYWJsZWQ9Y2xpbWF0ZUJ1c3k7CiAgICBidXR0b24udGV4dENvbnRlbnQ9Y2xpbWF0ZUJ1c3k/IldldHRlciB3aXJkIGdlbGFkZW4g4oCmIjoiV2V0dGVyZGF0ZW4gbGFkZW4iOwogICAgY29uc3QgZGF0YT1kYXNoYm9hcmRDbGltYXRlRGF0YSgpOwogICAgY29uc3QgcGFydGlhbD1kYXRhLnNvbWUocj0+ci5wYXJ0aWFsKTsKICAgICQoImRhc2hib2FyZENsaW1hdGVTdGF0dXMiKS50ZXh0Q29udGVudD0oY2xpbWF0ZVdlYXRoZXJFcnJvcj8iV2V0dGVyOiAiK2NsaW1hdGVXZWF0aGVyRXJyb3I6CiAgICAgICFyZWFkeT8iSGlzdG9yaXNjaGUgV2V0dGVyZGF0ZW4gZmVobGVuLiBGw7xyIGRpZSBCZXJlaW5pZ3VuZyBiaXR0ZSBsYWRlbi4iOiJXZXR0ZXJyZWZlcmVueiAyMDI0LzIwMjUgdm9yaGFuZGVuLiIpKwogICAgICAocGFydGlhbD8iIEVpbiBsYXVmZW5kZXIgVGVpbG1vbmF0IGlzdCB2b24gZGVyIEhlaXp3w6RybWVzdW1tZSBhdXNnZXNjaGxvc3Nlbi4iOiIiKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRhc2hib2FyZC1jbGltYXRlLW1vZGVdIikuZm9yRWFjaChidG49PnsKICAgICAgY29uc3QgYWN0aXZlPWJ0bi5kYXRhc2V0LmRhc2hib2FyZENsaW1hdGVNb2RlPT09ZGFzaGJvYXJkQ2xpbWF0ZU1vZGU7CiAgICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLGFjdGl2ZSk7CiAgICAgIGJ0bi5zZXRBdHRyaWJ1dGUoImFyaWEtcHJlc3NlZCIsU3RyaW5nKGFjdGl2ZSkpOwogICAgfSk7CiAgICBkcmF3RGFzaGJvYXJkQ2xpbWF0ZUNoYXJ0KGRhdGEpOwogIH0KICBmdW5jdGlvbiBkcmF3RGFzaGJvYXJkQ2xpbWF0ZUNoYXJ0KGRhdGE9ZGFzaGJvYXJkQ2xpbWF0ZURhdGEoKSl7CiAgICBjb25zdCBjYW52YXM9JCgiZGFzaGJvYXJkQ2xpbWF0ZUNoYXJ0IiksYz1jYW52YXNTZXR1cChjYW52YXMpOwogICAgaWYoIWMpcmV0dXJuOwogICAgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7CiAgICBjb25zdCBsZWZ0PTQ2LHJpZ2h0PTEyLHRvcD0xNyxib3R0b209MzQscGxvdFc9d2lkdGgtbGVmdC1yaWdodCxwbG90SD1oZWlnaHQtdG9wLWJvdHRvbTsKICAgIGNvbnN0IHg9aT0+bGVmdCtwbG90VyooaSsuNSkvZGF0YS5sZW5ndGg7CiAgICBjb25zdCBoZWF0TW9kZT1kYXNoYm9hcmRDbGltYXRlTW9kZT09PSJoZWF0IjsKICAgIGNvbnN0IHNlcmllcz1oZWF0TW9kZT9bCiAgICAgIHtrZXk6ImhlYXQiLG5hbWU6IkhlaXp3w6RybWUiLGNvbG9yOkNPTE9SUy5oZWF0fSwKICAgICAge2tleToibm9ybWFsaXplZCIsbmFtZToiV2l0dGVydW5nc2JlcmVpbmlndCIsY29sb3I6Q09MT1JTLmNvbXBhcmV9CiAgICBdOlsKICAgICAge2tleToib3V0ZG9vciIsbmFtZToiQXXDn2VudGVtcGVyYXR1ciIsY29sb3I6Q09MT1JTLmJsdWV8fCIjNGQ5Y2ZmIn0sCiAgICAgIHtrZXk6InJvb20iLG5hbWU6IlJhdW10ZW1wZXJhdHVyIixjb2xvcjoiIzVmYzdjMiJ9LAogICAgICB7a2V5OiJzdG9yYWdlIixuYW1lOiJXYXJtd2Fzc2Vyc3BlaWNoZXIiLGNvbG9yOiIjZjJkMTVmIn0KICAgIF07CiAgICAkKCJkYXNoYm9hcmRDbGltYXRlTGVnZW5kIikuaW5uZXJIVE1MPXNlcmllcy5tYXAocz0+IjxzcGFuIHN0eWxlPVwiLS1sZWdlbmQtY29sb3I6IitzLmNvbG9yKyJcIj4iK2VzY2FwZUh0bWwocy5uYW1lKSsoaGVhdE1vZGU/IiDCtyBrV2giOiIgwrcgwrBDIikrIjwvc3Bhbj4iKS5qb2luKCIiKTsKICAgIGNhbnZhcy5zZXRBdHRyaWJ1dGUoImFyaWEtbGFiZWwiLGhlYXRNb2RlPyJIZWl6d8Okcm1lIHVuZCB3aXR0ZXJ1bmdzYmVyZWluaWd0ZSBIZWl6d8Okcm1lIGRlciBsZXR6dGVuIHNlY2hzIE1vbmF0ZSI6CiAgICAgICJBdcOfZW4tLCBSYXVtLSB1bmQgV2FybXdhc3NlcnNwZWljaGVydGVtcGVyYXR1cmVuIGRlciBsZXR6dGVuIHNlY2hzIE1vbmF0ZSIpOwogICAgY29uc3QgdmFscz1kYXRhLmZsYXRNYXAocm93PT5zZXJpZXMubWFwKHM9PnJvd1tzLmtleV0pKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTsKICAgIGlmKCF2YWxzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsaGVhdE1vZGU/Ik5vY2gga2VpbmUgSGVpenfDpHJtZWRhdGVuIjoiTm9jaCBrZWluZSBUZW1wZXJhdHVyZGF0ZW4iKTtyZXR1cm47fQogICAgbGV0IGxvPWhlYXRNb2RlPzA6TWF0aC5mbG9vcihNYXRoLm1pbiguLi52YWxzKS0zKSxoaT1NYXRoLmNlaWwoTWF0aC5tYXgoLi4udmFscykqMS4xKyAoaGVhdE1vZGU/MTo0KSk7CiAgICBpZihoaTw9bG8paGk9bG8rMTsKICAgIGNvbnN0IHk9dj0+dG9wK3Bsb3RIKigxLSh2LWxvKS8oaGktbG8pKTsKICAgIGN0eC5saW5lV2lkdGg9MTtjdHguZm9udD0iMTFweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjtjdHgudGV4dEFsaWduPSJsZWZ0IjsKICAgIGZvcihsZXQgaz0wO2s8PTQ7aysrKXsKICAgICAgY29uc3Qgdj1sbysoaGktbG8pKigxLWsvNCkseXk9dG9wK3Bsb3RIKmsvNDsKICAgICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkO2N0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKGxlZnQseXkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseXkpO2N0eC5zdHJva2UoKTsKICAgICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZmlsbFRleHQobnVtKHYsMCksMyx5eSszKTsKICAgIH0KICAgIGN0eC50ZXh0QWxpZ249ImNlbnRlciI7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDsKICAgIGRhdGEuZm9yRWFjaCgocixpKT0+Y3R4LmZpbGxUZXh0KHIubGFiZWwrKHIucGFydGlhbD8iKiI6IiIpLHgoaSksaGVpZ2h0LTkpKTsKICAgIGlmKGhlYXRNb2RlKXsKICAgICAgY29uc3Qgdz1NYXRoLm1pbigzNixwbG90Vy9kYXRhLmxlbmd0aCouNDIpOwogICAgICBkYXRhLmZvckVhY2goKHIsaSk9PntpZighTnVtYmVyLmlzRmluaXRlKHIuaGVhdCkpcmV0dXJuO2N0eC5maWxsU3R5bGU9Q09MT1JTLmhlYXQ7CiAgICAgICAgY29uc3QgeXk9eShyLmhlYXQpO2N0eC5maWxsUmVjdCh4KGkpLXcvMix5eSx3LHkoMCkteXkpOwogICAgICB9KTsKICAgIH0KICAgIGNvbnN0IGxpbmVzPWhlYXRNb2RlP3Nlcmllcy5zbGljZSgxKTpzZXJpZXM7CiAgICBsaW5lcy5mb3JFYWNoKHM9PnsKICAgICAgY3R4LnN0cm9rZVN0eWxlPXMuY29sb3I7Y3R4LmZpbGxTdHlsZT1zLmNvbG9yO2N0eC5saW5lV2lkdGg9Mi44OwogICAgICBsZXQgcHJldj1mYWxzZTtjdHguYmVnaW5QYXRoKCk7CiAgICAgIGRhdGEuZm9yRWFjaCgocm93LGkpPT57CiAgICAgICAgY29uc3Qgdj1yb3dbcy5rZXldOwogICAgICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUodikpe3ByZXY9ZmFsc2U7cmV0dXJuO30KICAgICAgICBpZighcHJldiljdHgubW92ZVRvKHgoaSkseSh2KSk7ZWxzZSBjdHgubGluZVRvKHgoaSkseSh2KSk7CiAgICAgICAgcHJldj10cnVlOwogICAgICB9KTsKICAgICAgY3R4LnN0cm9rZSgpOwogICAgICBkYXRhLmZvckVhY2goKHIsaSk9PntpZighTnVtYmVyLmlzRmluaXRlKHJbcy5rZXldKSlyZXR1cm47Y3R4LmJlZ2luUGF0aCgpO2N0eC5hcmMoeChpKSx5KHJbcy5rZXldKSwzLjMsMCxNYXRoLlBJKjIpO2N0eC5maWxsKCk7fSk7CiAgICB9KTsKICAgIGN0eC50ZXh0QWxpZ249ImxlZnQiOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyRGFzaGJvYXJkKCl7CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0UmVjb3JkKCk7CiAgICAkKCJsYXRlc3RNb250aFRpdGxlIikudGV4dENvbnRlbnQ9bGF0ZXN0P21vbnRoTGFiZWwobGF0ZXN0Lm1vbnRoKToiTm9jaCBrZWluZSBNb25hdHN3ZXJ0ZSI7CiAgICAkKCJlZGl0TGF0ZXN0QnRuIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhbGF0ZXN0KTsKICAgIGlmKGxhdGVzdCkkKCJlZGl0TGF0ZXN0QnRuIikuZGF0YXNldC5tb250aD1sYXRlc3QubW9udGg7CiAgICBjb25zdCByZXN0PWxhdGVzdD9kZXJpdmVkKGxhdGVzdCk6bnVsbDsKICAgIGNvbnN0IG1ldHJpY3M9bGF0ZXN0P1sKICAgICAgWyJHZXNhbXQiLGAke251bShsYXRlc3QudG90YWwsMSl9IGtXaGAsbGF0ZXN0Lm1ldGVyUmVhZGluZ0RhdGU/YGF1cyBaw6RobGVyc3RhbmQgJHtkYXRlTGFiZWwobGF0ZXN0Lm1ldGVyUmVhZGluZ0RhdGUpfWA6ImRva3VtZW50aWVydCJdLAogICAgICBbIlfDpHJtZXB1bXBlIixgJHtudW0obGF0ZXN0LmhlYXRQdW1wLDEpfSBrV2hgLE51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZsYXRlc3QudG90YWw+MCYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC5oZWF0UHVtcCk/YCR7bnVtKGxhdGVzdC5oZWF0UHVtcC9sYXRlc3QudG90YWwqMTAwLDEpfSAlIEFudGVpbGA6IuKAkyJdLAogICAgICBbIkFsdGVudGVpbCIsYCR7bnVtKGxhdGVzdC5hbm5leCwxKX0ga1doYCxsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZT9gWsOkaGxlciAke251bShsYXRlc3QuYW5uZXhNZXRlclJlYWRpbmcsMCl9IGtXaGA6TnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LmFubmV4KT9gJHtudW0obGF0ZXN0LmFubmV4L2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoi4oCTIl0sCiAgICAgIFsiU2NobGVlL0tsdXMiLGAke251bShyZXN0LDEpfSBrV2hgLE51bWJlci5pc0Zpbml0ZShyZXN0KSYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wP2Ake251bShyZXN0L2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoiYXV0b21hdGlzY2giXSwKICAgICAgWyJLb3N0ZW4iLGV1cm8ocmVjb3JkQ29zdChsYXRlc3QpKSxsYXRlc3Qub3N0cm9tUHJpY2VDb21wbGV0ZT9gT3N0cm9tIGV4YWt0IMK3ICR7bnVtKGxhdGVzdC5wcmljZUN0LDIpfSBjdC9rV2hgOk51bWJlci5pc0Zpbml0ZShsYXRlc3QucHJpY2VDdCk/YCR7bnVtKGxhdGVzdC5wcmljZUN0LDIpfSBjdC9rV2hgOiJGYWxsYmFjay1QcmVpcyJdCiAgICBdOltbIkdlc2FtdCIsIuKAkyIsIk1vbmF0IGVpbnRyYWdlbiJdLFsiV8Okcm1lcHVtcGUiLCLigJMiLCIiXSxbIkFsdGVudGVpbCIsIuKAkyIsIiJdLFsiU2NobGVlL0tsdXMiLCLigJMiLCIiXSxbIktvc3RlbiIsIuKAkyIsIiJdXTsKICAgICQoImxhdGVzdE1ldHJpY3MiKS5pbm5lckhUTUw9bWV0cmljcy5tYXAoKFtsYWJlbCx2YWx1ZSxzbWFsbF0pPT5gPGFydGljbGU+PHNwYW4+JHtsYWJlbH08L3NwYW4+PHN0cm9uZz4ke3ZhbHVlfTwvc3Ryb25nPjxzbWFsbD4ke3NtYWxsfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgY29uc3QgY29tcGFyZT1sYXRlc3Q/cmVjb3JkRm9yTW9udGgoYCR7TnVtYmVyKGxhdGVzdC5tb250aC5zbGljZSgwLDQpKS0xfS0ke2xhdGVzdC5tb250aC5zbGljZSg1LDcpfWApOm51bGw7CiAgICBjb25zdCBkZWx0YT1sYXRlc3QmJmNvbXBhcmUmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoY29tcGFyZS50b3RhbCkmJmNvbXBhcmUudG90YWwhPT0wPyhsYXRlc3QudG90YWwtY29tcGFyZS50b3RhbCkvY29tcGFyZS50b3RhbCoxMDA6bnVsbDsKICAgIGNvbnN0IGNvbXA9JCgibGF0ZXN0Q29tcGFyaXNvbiIpOwogICAgY29tcC5jbGFzc05hbWU9ImNvbXBhcmlzb24tbGluZSBuZXV0cmFsIjsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShkZWx0YSkpewogICAgICBjb21wLnRleHRDb250ZW50PWBadW0gZ2xlaWNoZW4gTW9uYXQgZGVzIFZvcmphaHJlczogJHtwY3QoZGVsdGEpfSAoJHtudW0obGF0ZXN0LnRvdGFsLWNvbXBhcmUudG90YWwsMSl9IGtXaCkuYDsKICAgICAgY29tcC5jbGFzc05hbWU9YGNvbXBhcmlzb24tbGluZSAke2RlbHRhPjA/InBvc2l0aXZlIjpkZWx0YTwwPyJuZWdhdGl2ZSI6Im5ldXRyYWwifWA7CiAgICB9ZWxzZSBjb21wLnRleHRDb250ZW50PWxhdGVzdD8iRsO8ciBkaWVzZW4gTW9uYXQgaXN0IG5vY2gga2VpbiB2b2xsc3TDpG5kaWdlciBWb3JqYWhyZXN2ZXJnbGVpY2ggdm9yaGFuZGVuLiI6IlRyYWdlIGRlbiBlcnN0ZW4gTW9uYXRzd2VydCBlaW4uIjsKICAgIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpOwogICAgcmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7CiAgICByZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJSZWNvcmRzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3Qgc2VsZWN0PSQoInJlY29yZFllYXJGaWx0ZXIiKTsKICAgIGNvbnN0IGN1cnJlbnQ9c2VsZWN0LnZhbHVlfHwiYWxsIjsKICAgIHNlbGVjdC5pbm5lckhUTUw9JzxvcHRpb24gdmFsdWU9ImFsbCI+QWxsZSBKYWhyZTwvb3B0aW9uPicreXMubWFwKHk9PmA8b3B0aW9uIHZhbHVlPSIke3l9Ij4ke3l9PC9vcHRpb24+YCkuam9pbigiIik7CiAgICBzZWxlY3QudmFsdWU9eXMuaW5jbHVkZXMoTnVtYmVyKGN1cnJlbnQpKT9jdXJyZW50OiJhbGwiOwogICAgY29uc3QgZmlsdGVyZWQ9c29ydGVkKCkucmV2ZXJzZSgpLmZpbHRlcihyPT5zZWxlY3QudmFsdWU9PT0iYWxsInx8ci5tb250aC5zdGFydHNXaXRoKGAke3NlbGVjdC52YWx1ZX0tYCkpOwogICAgJCgicmVjb3JkQ291bnQiKS50ZXh0Q29udGVudD1gJHtmaWx0ZXJlZC5sZW5ndGh9ICR7ZmlsdGVyZWQubGVuZ3RoPT09MT8iTW9uYXQiOiJNb25hdGUifWA7CiAgICBpZighZmlsdGVyZWQubGVuZ3RoKXsgJCgicmVjb3JkTGlzdCIpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPjxzdHJvbmc+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZSBpbiBkaWVzZXIgQXVzd2FobC48L3N0cm9uZz48c3Bhbj5aw6RobGVyc3TDpG5kZSB1bmQgbXlWQUlMTEFOVC1DU1YgZXJ6ZXVnZW4gZGllIE1vbmF0c3dlcnRlIGF1dG9tYXRpc2NoLjwvc3Bhbj48L2Rpdj4nOyByZXR1cm47IH0KICAgICQoInJlY29yZExpc3QiKS5pbm5lckhUTUw9ZmlsdGVyZWQubWFwKHI9PnsKICAgICAgY29uc3QgcmVzdD1kZXJpdmVkKHIpLCBpbnZhbGlkPU51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwOwogICAgICBjb25zdCBzdGF0dXM9aW52YWxpZD8iVW5wbGF1c2liZWwiOmNvbXBsZXRlKHIpPyJ2b2xsc3TDpG5kaWciOiJ1bnZvbGxzdMOkbmRpZyI7CiAgICAgIGNvbnN0IHNvdXJjZT0oci5tZXRlclJlYWRpbmdEYXRlP2Ag4oCiIFrDpGhsZXIgYmlzICR7ZGF0ZUxhYmVsKHIubWV0ZXJSZWFkaW5nRGF0ZSl9YDpyLmhlYXRQdW1wU291cmNlPy5zdGFydHNXaXRoKCJteXZhaWxsYW50Iik/IiDigKIgV8Okcm1lcHVtcGUgYXVzIENTViI6IiIpKyhyLm9zdHJvbVByaWNlQ29tcGxldGU/IiDigKIgT3N0cm9tLVByZWlzIGV4YWt0IjoiIik7CiAgICAgIHJldHVybiBgPGFydGljbGUgY2xhc3M9InJlY29yZC1yb3cgJHtpbnZhbGlkPyJpbnZhbGlkIjoiIn0iPgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC1tb250aCI+PHN0cm9uZz4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChyLm1vbnRoKSl9PC9zdHJvbmc+PHNtYWxsPiR7c3RhdHVzfSR7c291cmNlfSR7ci5ub3RlP2Ag4oCiICR7ZXNjYXBlSHRtbChyLm5vdGUuc2xpY2UoMCw3MCkpfWA6IiJ9PC9zbWFsbD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPkdlc2FtdDwvc3Bhbj48c3Ryb25nPiR7bnVtKHIudG90YWwsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+V8Okcm1lcHVtcGU8L3NwYW4+PHN0cm9uZz4ke251bShyLmhlYXRQdW1wLDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPkFsdGVudGVpbDwvc3Bhbj48c3Ryb25nPiR7bnVtKHIuYW5uZXgsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+U2NobGVlL0tsdXM8L3NwYW4+PHN0cm9uZz4ke251bShyZXN0LDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCBlZGl0LXJlY29yZCIgdHlwZT0iYnV0dG9uIiBkYXRhLWVkaXQtbW9udGg9IiR7ci5tb250aH0iPkJlYXJiZWl0ZW48L2J1dHRvbj4KICAgICAgPC9hcnRpY2xlPmA7CiAgICB9KS5qb2luKCIiKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5SZWNvcmRNb2RhbChtb250aCl7CiAgICBjb25zdCByPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgIGlmKCFyKXt0b2FzdCgiTW9uYXQgbmljaHQgZ2VmdW5kZW4iKTtyZXR1cm47fQogICAgJCgicmVjb3JkTW9kYWxUaXRsZSIpLnRleHRDb250ZW50PW1vbnRoTGFiZWwoci5tb250aCk7CiAgICAkKCJlZGl0aW5nTW9udGhPcmlnaW5hbCIpLnZhbHVlPXIubW9udGg7CiAgICAkKCJyZWNvcmRNb250aCIpLnZhbHVlPXIubW9udGg7CiAgICAkKCJyZWNvcmRUb3RhbCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLnRvdGFsKT9yLnRvdGFsOiIiOwogICAgJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCk/ci5oZWF0UHVtcDoiIjsKICAgICQoInJlY29yZEFubmV4IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuYW5uZXgpP3IuYW5uZXg6IiI7CiAgICAkKCJyZWNvcmRQcmljZUN0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIucHJpY2VDdCk/ci5wcmljZUN0OiIiOwogICAgJCgicmVjb3JkQmFzZUZlZSIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmJhc2VGZWUpP3IuYmFzZUZlZToiIjsKICAgICQoInJlY29yZEhlYXRHZW5lcmF0ZWQiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0R2VuZXJhdGVkKT9yLmhlYXRHZW5lcmF0ZWQ6IiI7CiAgICAkKCJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0aW5nRWxlY3RyaWNpdHkpP3IuaGVhdGluZ0VsZWN0cmljaXR5OiIiOwogICAgJCgicmVjb3JkRGh3RWxlY3RyaWNpdHkiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5kaHdFbGVjdHJpY2l0eSk/ci5kaHdFbGVjdHJpY2l0eToiIjsKICAgICQoInJlY29yZEhlYXRpbmdIZWF0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdGluZ0hlYXQpP3IuaGVhdGluZ0hlYXQ6IiI7CiAgICAkKCJyZWNvcmREaHdIZWF0IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuZGh3SGVhdCk/ci5kaHdIZWF0OiIiOwogICAgJCgicmVjb3JkTm90ZSIpLnZhbHVlPXIubm90ZXx8IiI7CiAgICAkKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IiI7CiAgICAkKCJyZWNvcmRTb3VyY2VIaW50IikudGV4dENvbnRlbnQ9ci5tZXRlclJlYWRpbmdEYXRlCiAgICAgID8gYERpZXNlciBNb25hdCB3dXJkZSBhdXMgWsOkaGxlcnN0w6RuZGVuIGJlcmVjaG5ldC4gRWluZSBLb3JyZWt0dXIgaGllciDDpG5kZXJ0IG51ciBkZW4gTW9uYXRzd2VydDsgZGllIGdlc3BlaWNoZXJ0ZW4gWsOkaGxlcnN0w6RuZGUgYmlzICR7ZGF0ZUxhYmVsKHIubWV0ZXJSZWFkaW5nRGF0ZSl9IGJsZWliZW4gZXJoYWx0ZW4uYAogICAgICA6IHIuaGVhdFB1bXBTb3VyY2U/LnN0YXJ0c1dpdGgoIm15dmFpbGxhbnQiKQogICAgICAgID8gIkRpZSBXw6RybWVwdW1wZW53ZXJ0ZSBzdGFtbWVuIGF1cyBlaW5lciBteVZBSUxMQU5ULUNTVi4gTWFudWVsbGUgw4RuZGVydW5nZW4ga8O2bm5lbiBiZWkgZWluZW0gc3DDpHRlcmVuIGVybmV1dGVuIENTVi1JbXBvcnQgd2llZGVyIGVyc2V0enQgd2VyZGVuLiIKICAgICAgICA6ICJNYW51ZWxsZSBLb3JyZWt0dXIgZWluZXMgZ2VzcGVpY2hlcnRlbiBNb25hdHN3ZXJ0ZXMuIjsKICAgIHVwZGF0ZURlcml2ZWRQcmV2aWV3KCk7CiAgICAkKCJyZWNvcmRNb2RhbCIpLmNsYXNzTGlzdC5yZW1vdmUoImhpZGRlbiIpOwogICAgZG9jdW1lbnQuYm9keS5zdHlsZS5vdmVyZmxvdz0iaGlkZGVuIjsKICB9CiAgZnVuY3Rpb24gY2xvc2VSZWNvcmRNb2RhbCgpeyAkKCJyZWNvcmRNb2RhbCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOyBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSIiOyB9CiAgZnVuY3Rpb24gdXBkYXRlRGVyaXZlZFByZXZpZXcoKXsKICAgIGNvbnN0IHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoInJlY29yZFRvdGFsIikudmFsdWUpLGhlYXQ9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkQW5uZXgiKS52YWx1ZSk7CiAgICBjb25zdCBlbD0kKCJkZXJpdmVkUHJldmlldyIpOwogICAgaWYoW3RvdGFsLGhlYXQsYW5uZXhdLmV2ZXJ5KE51bWJlci5pc0Zpbml0ZSkpewogICAgICBjb25zdCByZXN0PXRvdGFsLWhlYXQtYW5uZXg7CiAgICAgIGVsLnRleHRDb250ZW50PWBTY2hsZWUvS2x1czogJHtudW0ocmVzdCwzKX0ga1doYDsKICAgICAgZWwuY2xhc3NMaXN0LnRvZ2dsZSgiZXJyb3IiLHJlc3Q8MCk7CiAgICB9ZWxzZXsKICAgICAgZWwudGV4dENvbnRlbnQ9IlNjaGxlZS9LbHVzOiDigJMgKHdpcmQgYXVzIEdlc2FtdCDiiJIgV8Okcm1lcHVtcGUg4oiSIEFsdGVudGVpbCBiZXJlY2huZXQpIjsKICAgICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgiZXJyb3IiKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2F2ZUVkaXRlZFJlY29yZChldmVudCl7CiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgY29uc3QgbW9udGg9JCgiZWRpdGluZ01vbnRoT3JpZ2luYWwiKS52YWx1ZTsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgIGlmKCFleGlzdGluZyl7JCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgTW9uYXQgd3VyZGUgbmljaHQgZ2VmdW5kZW4uIjtyZXR1cm47fQogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkVG90YWwiKS52YWx1ZSksaGVhdFB1bXA9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdFB1bXAiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkQW5uZXgiKS52YWx1ZSk7CiAgICBpZihbdG90YWwsaGVhdFB1bXAsYW5uZXhdLmV2ZXJ5KE51bWJlci5pc0Zpbml0ZSkmJnRvdGFsLWhlYXRQdW1wLWFubmV4PC0uMDEpewogICAgICAkKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IlVucGxhdXNpYmVsOiBXw6RybWVwdW1wZSArIEFsdGVudGVpbCBzaW5kIGdyw7bDn2VyIGFscyBkZXIgR2VzYW10dmVyYnJhdWNoLiI7cmV0dXJuOwogICAgfQogICAgY29uc3QgaGVhdENoYW5nZWQ9aGVhdFB1bXAhPT1leGlzdGluZy5oZWF0UHVtcDsKICAgIGNvbnN0IG1ldGVyQ2hhbmdlZD10b3RhbCE9PWV4aXN0aW5nLnRvdGFsfHxhbm5leCE9PWV4aXN0aW5nLmFubmV4OwogICAgY29uc3QgbmV4dFByaWNlQ3Q9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkUHJpY2VDdCIpLnZhbHVlKSxuZXh0QmFzZUZlZT1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRCYXNlRmVlIikudmFsdWUpOwogICAgY29uc3QgcHJpY2VDaGFuZ2VkPW5leHRQcmljZUN0IT09ZXhpc3RpbmcucHJpY2VDdHx8bmV4dEJhc2VGZWUhPT1leGlzdGluZy5iYXNlRmVlOwogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgY29uc3QgcmVjb3JkPXsuLi5leGlzdGluZywKICAgICAgdG90YWwsaGVhdFB1bXAsYW5uZXgsCiAgICAgIHByaWNlQ3Q6bmV4dFByaWNlQ3QsCiAgICAgIGJhc2VGZWU6bmV4dEJhc2VGZWUsCiAgICAgIGhlYXRHZW5lcmF0ZWQ6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdEdlbmVyYXRlZCIpLnZhbHVlKSwKICAgICAgaGVhdGluZ0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIpLnZhbHVlKSwKICAgICAgZGh3RWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkRGh3RWxlY3RyaWNpdHkiKS52YWx1ZSksCiAgICAgIGhlYXRpbmdIZWF0Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRpbmdIZWF0IikudmFsdWUpLAogICAgICBkaHdIZWF0Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZERod0hlYXQiKS52YWx1ZSksCiAgICAgIG5vdGU6JCgicmVjb3JkTm90ZSIpLnZhbHVlLnRyaW0oKSwKICAgICAgaGVhdFB1bXBTb3VyY2U6aGVhdENoYW5nZWQ/Im1hbnVhbC1jb3JyZWN0aW9uIjpleGlzdGluZy5oZWF0UHVtcFNvdXJjZSwKICAgICAgaGVhdFB1bXBVcGRhdGVkQXQ6aGVhdENoYW5nZWQ/c3RhbXA6ZXhpc3RpbmcuaGVhdFB1bXBVcGRhdGVkQXQsCiAgICAgIG1ldGVyU291cmNlOm1ldGVyQ2hhbmdlZCYmZXhpc3RpbmcubWV0ZXJTb3VyY2U/YCR7ZXhpc3RpbmcubWV0ZXJTb3VyY2V9K21hbnVhbC1tb250aC1jb3JyZWN0aW9uYDpleGlzdGluZy5tZXRlclNvdXJjZSwKICAgICAgcHJpY2VTb3VyY2U6cHJpY2VDaGFuZ2VkPyJtYW51YWwtY29ycmVjdGlvbiI6ZXhpc3RpbmcucHJpY2VTb3VyY2UsCiAgICAgIHByaWNlVXBkYXRlZEF0OnByaWNlQ2hhbmdlZD9zdGFtcDpleGlzdGluZy5wcmljZVVwZGF0ZWRBdCwKICAgICAgb3N0cm9tVmFyaWFibGVDb3N0RXVyOnByaWNlQ2hhbmdlZD9udWxsOmV4aXN0aW5nLm9zdHJvbVZhcmlhYmxlQ29zdEV1ciwKICAgICAgb3N0cm9tVG90YWxDb3N0RXVyOnByaWNlQ2hhbmdlZD9udWxsOmV4aXN0aW5nLm9zdHJvbVRvdGFsQ29zdEV1ciwKICAgICAgb3N0cm9tQ29uc3VtcHRpb25LV2g6cHJpY2VDaGFuZ2VkP251bGw6ZXhpc3Rpbmcub3N0cm9tQ29uc3VtcHRpb25LV2gsCiAgICAgIG9zdHJvbVByaWNlQ29tcGxldGU6cHJpY2VDaGFuZ2VkP2ZhbHNlOmV4aXN0aW5nLm9zdHJvbVByaWNlQ29tcGxldGUsCiAgICAgIHVwZGF0ZWRBdDpzdGFtcAogICAgfTsKICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PW1vbnRoKTtuZXh0LnB1c2gocmVjb3JkKTsKICAgIHRyeXtzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YE1vbmF0ICR7bW9udGh9IG1hbnVlbGwga29ycmlnaWVydGB9KTt9CiAgICBjYXRjaChlcnJvcil7JCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWVycm9yLm1lc3NhZ2U7cmV0dXJuO30KICAgIGNsb3NlUmVjb3JkTW9kYWwoKTtyZW5kZXJBbGwoKTt0b2FzdChgJHttb250aExhYmVsKG1vbnRoKX0gZ2XDpG5kZXJ0YCk7CiAgfQoKICBmdW5jdGlvbiBvcGVuTWV0ZXJNb2RhbCgpewogICAgY29uc3QgcHJldmlvdXM9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighcHJldmlvdXMpe2FsZXJ0KCJFcyBmZWhsdCBlaW4gQXVzZ2FuZ3N6w6RobGVyc3RhbmQuIik7cmV0dXJuO30KICAgICQoIm1ldGVyRGF0ZSIpLnZhbHVlPW5leHRNb250aEZpcnN0KHByZXZpb3VzLmRhdGUpOwogICAgJCgibWV0ZXJUb3RhbCIpLnZhbHVlPSIiOwogICAgJCgibWV0ZXJBbm5leCIpLnZhbHVlPSIiOwogICAgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IiI7CiAgICB1cGRhdGVNZXRlclByZXZpZXcoKTsKICAgICQoIm1ldGVyTW9kYWwiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsKICAgIGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9ImhpZGRlbiI7CiAgICBzZXRUaW1lb3V0KCgpPT4kKCJtZXRlclRvdGFsIikuZm9jdXMoKSw1MCk7CiAgfQogIGZ1bmN0aW9uIGNsb3NlTWV0ZXJNb2RhbCgpeyAkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7IGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9IiI7IH0KICBmdW5jdGlvbiB1cGRhdGVNZXRlclByZXZpZXcoKXsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXJldHVybjsKICAgIGNvbnN0IGRhdGU9JCgibWV0ZXJEYXRlIikudmFsdWV8fG5leHRNb250aEZpcnN0KHByZXZpb3VzLmRhdGUpOwogICAgY29uc3QgdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpOwogICAgJCgibWV0ZXJQcmV2aW91cyIpLmlubmVySFRNTD1gVm9yaGVyaWdlciBTdGFuZDogPHN0cm9uZz4ke2RhdGVMYWJlbChwcmV2aW91cy5kYXRlKX08L3N0cm9uZz4gwrcgR2VzYW10IDxzdHJvbmc+JHtudW0ocHJldmlvdXMudG90YWwsMCl9IGtXaDwvc3Ryb25nPiDCtyBBbHRlbnRlaWwgPHN0cm9uZz4ke251bShwcmV2aW91cy5hbm5leCwwKX0ga1doPC9zdHJvbmc+YDsKICAgICQoIm1ldGVyVGFyZ2V0TW9udGgiKS50ZXh0Q29udGVudD1gQmVyZWNobmV0IHdpcmQgZGVyIFZlcmJyYXVjaCBmw7xyICR7bW9udGhMYWJlbCh0YXJnZXRNb250aCl9LmA7CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcigkKCJtZXRlclRvdGFsIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyQW5uZXgiKS52YWx1ZSk7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUodG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoYW5uZXgpKXsKICAgICAgY29uc3QgdG90YWxVc2U9dG90YWwtcHJldmlvdXMudG90YWwsYW5uZXhVc2U9YW5uZXgtcHJldmlvdXMuYW5uZXg7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKSxoZWF0PWV4aXN0aW5nPy5oZWF0UHVtcDsKICAgICAgY29uc3QgcmVzdD1OdW1iZXIuaXNGaW5pdGUoaGVhdCk/dG90YWxVc2UtYW5uZXhVc2UtaGVhdDpudWxsOwogICAgICAkKCJtZXRlclByZXZpZXciKS5pbm5lckhUTUw9YEdlc2FtdDogPHN0cm9uZz4ke251bSh0b3RhbFVzZSwxKX0ga1doPC9zdHJvbmc+IMK3IEFsdGVudGVpbDogPHN0cm9uZz4ke251bShhbm5leFVzZSwxKX0ga1doPC9zdHJvbmc+JHtOdW1iZXIuaXNGaW5pdGUoaGVhdCk/YCDCtyBXw6RybWVwdW1wZTogPHN0cm9uZz4ke251bShoZWF0LDEpfSBrV2g8L3N0cm9uZz4gwrcgU2NobGVlL0tsdXM6IDxzdHJvbmc+JHtudW0ocmVzdCwxKX0ga1doPC9zdHJvbmc+YDpgIMK3IFfDpHJtZXB1bXBlOiA8c3Ryb25nPkNTViBmZWhsdDwvc3Ryb25nPmB9YDsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuY2xhc3NMaXN0LnRvZ2dsZSgiZXJyb3IiLHRvdGFsVXNlPDB8fGFubmV4VXNlPDB8fChOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8MCkpOwogICAgfWVsc2V7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLnRleHRDb250ZW50PSJNb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXVzIGRlciBEaWZmZXJlbnogenVtIHZvcmhlcmlnZW4gWsOkaGxlcnN0YW5kIGJlcmVjaG5ldC4iOwogICAgICAkKCJtZXRlclByZXZpZXciKS5jbGFzc0xpc3QucmVtb3ZlKCJlcnJvciIpOwogICAgfQogIH0KICBmdW5jdGlvbiBzYXZlTWV0ZXJSZWFkaW5nRnJvbUZvcm0oZXZlbnQpewogICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXJldHVybjsKICAgIGNvbnN0IGRhdGU9JCgibWV0ZXJEYXRlIikudmFsdWUsdG90YWw9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJUb3RhbCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJtZXRlckFubmV4IikudmFsdWUpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0tXGR7Mn0kLy50ZXN0KGRhdGUpKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkJpdHRlIGVpbiBnw7xsdGlnZXMgQWJsZXNlZGF0dW0gd8OkaGxlbi4iOyByZXR1cm47IH0KICAgIGlmKGRhdGU8PXByZXZpb3VzLmRhdGUpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1gRGFzIERhdHVtIG11c3MgbmFjaCBkZW0gbGV0enRlbiBTdGFuZCB2b20gJHtkYXRlTGFiZWwocHJldmlvdXMuZGF0ZSl9IGxpZWdlbi5gOyByZXR1cm47IH0KICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUodG90YWwpfHwhTnVtYmVyLmlzRmluaXRlKGFubmV4KSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJCaXR0ZSBiZWlkZSBaw6RobGVyc3TDpG5kZSBlaW50cmFnZW4uIjsgcmV0dXJuOyB9CiAgICBpZih0b3RhbDxwcmV2aW91cy50b3RhbCl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgR2VzYW10esOkaGxlcnN0YW5kIGlzdCBrbGVpbmVyIGFscyBkZXIgdm9yaGVyaWdlIFN0YW5kLiBFaW4gbmV1ZXIgWsOkaGxlciBtw7xzc3RlIHNlcGFyYXQgYmVyw7xja3NpY2h0aWd0IHdlcmRlbi4iOyByZXR1cm47IH0KICAgIGlmKGFubmV4PHByZXZpb3VzLmFubmV4KXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkRlciBBbHRlbnRlaWwtWsOkaGxlcnN0YW5kIGlzdCBrbGVpbmVyIGFscyBkZXIgdm9yaGVyaWdlIFN0YW5kLiI7IHJldHVybjsgfQogICAgY29uc3QgdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpLHRvdGFsVXNlPXRvdGFsLXByZXZpb3VzLnRvdGFsLGFubmV4VXNlPWFubmV4LXByZXZpb3VzLmFubmV4OwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgodGFyZ2V0TW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6dGFyZ2V0TW9udGh9KTsKICAgIGNvbnN0IHJlc3Q9TnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmhlYXRQdW1wKT90b3RhbFVzZS1hbm5leFVzZS1leGlzdGluZy5oZWF0UHVtcDpudWxsOwogICAgaWYoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PC0uMDEpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1gVW5wbGF1c2liZWw6IE5hY2ggQWJ6dWcgdm9uIFfDpHJtZXB1bXBlIHVuZCBBbHRlbnRlaWwgZXJnaWJ0IFNjaGxlZS9LbHVzICR7bnVtKHJlc3QsMSl9IGtXaC5gOyByZXR1cm47IH0KICAgIGNvbnN0IHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIGNvbnN0IG5leHRSZWNvcmQ9ey4uLmV4aXN0aW5nLHRvdGFsOnRvdGFsVXNlLGFubmV4OmFubmV4VXNlLG1ldGVyUmVhZGluZ0RhdGU6ZGF0ZSxwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6cHJldmlvdXMuZGF0ZSx0b3RhbE1ldGVyUmVhZGluZzp0b3RhbCxhbm5leE1ldGVyUmVhZGluZzphbm5leCxtZXRlclNvdXJjZToiY3VtdWxhdGl2ZS1yZWFkaW5ncyIsdXBkYXRlZEF0OnN0YW1wfTsKICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PXRhcmdldE1vbnRoKTtuZXh0LnB1c2gobmV4dFJlY29yZCk7CiAgICB0cnl7CiAgICAgIHNhdmVSZWNvcmRzKG5leHQse3JlYXNvbjpgWsOkaGxlcnN0w6RuZGUgJHtkYXRlTGFiZWwoZGF0ZSl9IGdlc3BlaWNoZXJ0YH0pOwogICAgICBzYXZlTWV0ZXJSZWFkaW5ncyhbLi4ubWV0ZXJSZWFkaW5ncyx7ZGF0ZSx0b3RhbCxhbm5leCxub3RlOmBWZXJicmF1Y2ggJHt0YXJnZXRNb250aH1gLHVwZGF0ZWRBdDpzdGFtcH1dKTsKICAgIH1jYXRjaChlcnJvcil7JCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9ZXJyb3IubWVzc2FnZTtyZXR1cm47fQogICAgY2xvc2VNZXRlck1vZGFsKCk7cmVuZGVyQWxsKCk7CiAgICB0b2FzdChOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcuaGVhdFB1bXApP2Ake21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfSB2b2xsc3TDpG5kaWcgYmVyZWNobmV0YDpgWsOkaGxlcnN0w6RuZGUgZ2VzcGVpY2hlcnQgwrcgV8Okcm1lcHVtcGVuLUNTViBmZWhsdCBub2NoYCk7CiAgfQogIGZ1bmN0aW9uIHVuZG9MYXRlc3RNZXRlclJlYWRpbmcoKXsKICAgIGlmKG1ldGVyUmVhZGluZ3MubGVuZ3RoPD0xKXJldHVybjsKICAgIGNvbnN0IGxhdGVzdD1tZXRlclJlYWRpbmdzLmF0KC0xKSxwcmV2aW91cz1tZXRlclJlYWRpbmdzLmF0KC0yKSx0YXJnZXRNb250aD1wcmV2aW91cy5kYXRlLnNsaWNlKDAsNyk7CiAgICBpZighY29uZmlybShgWsOkaGxlcnN0YW5kIHZvbSAke2RhdGVMYWJlbChsYXRlc3QuZGF0ZSl9IHp1csO8Y2tuZWhtZW4/IERpZSBkYXJhdXMgYmVyZWNobmV0ZW4gV2VydGUgZsO8ciAke21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfSB3ZXJkZW4gZW50ZmVybnQuYCkpcmV0dXJuOwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgodGFyZ2V0TW9udGgpOwogICAgaWYoZXhpc3RpbmcpewogICAgICBjb25zdCBjbGVhcmVkPXsuLi5leGlzdGluZyx0b3RhbDpudWxsLGFubmV4Om51bGwsbWV0ZXJSZWFkaW5nRGF0ZTpudWxsLHByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZTpudWxsLHRvdGFsTWV0ZXJSZWFkaW5nOm51bGwsYW5uZXhNZXRlclJlYWRpbmc6bnVsbCxtZXRlclNvdXJjZToiIix1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpfTsKICAgICAgY29uc3QgbmV4dD1yZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoIT09dGFyZ2V0TW9udGgpO25leHQucHVzaChjbGVhcmVkKTtzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YExldHp0ZW4gWsOkaGxlcnN0YW5kICR7bGF0ZXN0LmRhdGV9IHp1csO8Y2tnZW5vbW1lbmB9KTsKICAgIH0KICAgIHNhdmVNZXRlclJlYWRpbmdzKG1ldGVyUmVhZGluZ3Muc2xpY2UoMCwtMSkpO3JlbmRlckFsbCgpO3RvYXN0KCJMZXR6dGVuIFrDpGhsZXJzdGFuZCB6dXLDvGNrZ2Vub21tZW4iKTsKICB9CgogIGZ1bmN0aW9uIGFuYWx5c2lzWWVhclJvd3MoeWVhcil7IHJldHVybiByZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoLnN0YXJ0c1dpdGgoYCR7eWVhcn0tYCkpLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7IH0KICBmdW5jdGlvbiBvc3Ryb21TdGF0c0ZvclllYXIoeWVhcil7CiAgICBjb25zdCBjYWNoZT1uZXcgTWFwKG9zdHJvbVByaWNlU3RhdHMuZmlsdGVyKGl0ZW09Pml0ZW0ubW9udGguc3RhcnRzV2l0aChgJHt5ZWFyfS1gKSkubWFwKGl0ZW09PltpdGVtLm1vbnRoLGl0ZW1dKSk7CiAgICBmb3IoY29uc3QgciBvZiBhbmFseXNpc1llYXJSb3dzKHllYXIpKXsKICAgICAgaWYoIXIub3N0cm9tUHJpY2VDb21wbGV0ZXx8IU51bWJlci5pc0Zpbml0ZShyLnByaWNlQ3QpfHwhTnVtYmVyLmlzRmluaXRlKHIub3N0cm9tQ29uc3VtcHRpb25LV2gpfHxyLm9zdHJvbUNvbnN1bXB0aW9uS1doPD0wKWNvbnRpbnVlOwogICAgICBjb25zdCBmcm9tUmVjb3JkPXNhbml0aXplT3N0cm9tUHJpY2VTdGF0KHttb250aDpyLm1vbnRoLHdlaWdodGVkQXZlcmFnZUN0UGVyS1doOnIucHJpY2VDdCx0b3RhbEtXaDpyLm9zdHJvbUNvbnN1bXB0aW9uS1doLHZhcmlhYmxlQ29zdEV1cjpyLm9zdHJvbVZhcmlhYmxlQ29zdEV1cixmaXhlZENvc3RFdXI6ci5iYXNlRmVlLHRvdGFsQ29zdEV1cjpyLm9zdHJvbVRvdGFsQ29zdEV1cixjb21wbGV0ZTp0cnVlLHBhcnRpYWw6ZmFsc2UsdXBkYXRlZEF0OnIucHJpY2VVcGRhdGVkQXR8fHIudXBkYXRlZEF0fHwiIn0pOwogICAgICBjb25zdCBleGlzdGluZz1jYWNoZS5nZXQoci5tb250aCk7CiAgICAgIGlmKCFleGlzdGluZ3x8RGF0ZS5wYXJzZShmcm9tUmVjb3JkLnVwZGF0ZWRBdHx8IiIpPj1EYXRlLnBhcnNlKGV4aXN0aW5nLnVwZGF0ZWRBdHx8IiIpKWNhY2hlLnNldChyLm1vbnRoLGZyb21SZWNvcmQpOwogICAgfQogICAgcmV0dXJuIFsuLi5jYWNoZS52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gb3N0cm9tUGVyaW9kQXZlcmFnZShpdGVtcyl7CiAgICBjb25zdCB2YWxpZD0oQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pLmZpbHRlcihpdGVtPT5OdW1iZXIuaXNGaW5pdGUoaXRlbS50b3RhbEtXaCkmJml0ZW0udG90YWxLV2g+MCYmTnVtYmVyLmlzRmluaXRlKGl0ZW0udmFyaWFibGVDb3N0RXVyKSk7CiAgICBpZighdmFsaWQubGVuZ3RoKXJldHVybiB7YXZlcmFnZUN0Om51bGwsZWZmZWN0aXZlQ3Q6bnVsbCxrV2g6MCx2YXJpYWJsZUNvc3RFdXI6MCxmaXhlZENvc3RFdXI6MCx0b3RhbENvc3RFdXI6MCxtb250aHM6MCxwYXJ0aWFsOmZhbHNlfTsKICAgIGNvbnN0IGtXaD12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtK051bWJlcihpdGVtLnRvdGFsS1dofHwwKSwwKTsKICAgIGNvbnN0IHZhcmlhYmxlQ29zdEV1cj12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtK051bWJlcihpdGVtLnZhcmlhYmxlQ29zdEV1cnx8MCksMCk7CiAgICBjb25zdCBmaXhlZENvc3RFdXI9dmFsaWQucmVkdWNlKChzdW0saXRlbSk9PnN1bStOdW1iZXIoaXRlbS5maXhlZENvc3RFdXJ8fDApLDApOwogICAgY29uc3QgdG90YWxDb3N0RXVyPXZhbGlkLnJlZHVjZSgoc3VtLGl0ZW0pPT5zdW0rKE51bWJlci5pc0Zpbml0ZShpdGVtLnRvdGFsQ29zdEV1cik/TnVtYmVyKGl0ZW0udG90YWxDb3N0RXVyKTpOdW1iZXIoaXRlbS52YXJpYWJsZUNvc3RFdXJ8fDApK051bWJlcihpdGVtLmZpeGVkQ29zdEV1cnx8MCkpLDApOwogICAgcmV0dXJuIHthdmVyYWdlQ3Q6a1doPjA/dmFyaWFibGVDb3N0RXVyL2tXaCoxMDA6bnVsbCxlZmZlY3RpdmVDdDprV2g+MD90b3RhbENvc3RFdXIva1doKjEwMDpudWxsLGtXaCx2YXJpYWJsZUNvc3RFdXIsZml4ZWRDb3N0RXVyLHRvdGFsQ29zdEV1cixtb250aHM6dmFsaWQubGVuZ3RoLHBhcnRpYWw6dmFsaWQuc29tZShpdGVtPT5pdGVtLnBhcnRpYWwpfTsKICB9CiAgZnVuY3Rpb24gcXVhcnRlckZvck1vbnRoKG1vbnRoKXtyZXR1cm4gTWF0aC5mbG9vcigoTnVtYmVyKFN0cmluZyhtb250aCkuc2xpY2UoNSw3KSktMSkvMykrMTt9CiAgZnVuY3Rpb24gcmVuZGVyT3N0cm9tUHJpY2VTdGF0cyh5ZWFyKXsKICAgIGlmKCEkKCdvc3Ryb21QcmljZVN0YXRzTWV0cmljcycpKXJldHVybjsKICAgIGNvbnN0IGl0ZW1zPW9zdHJvbVN0YXRzRm9yWWVhcih5ZWFyKTsKICAgIGNvbnN0IGN1cnJlbnRZZWFyPW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKTsKICAgIGNvbnN0IGFubnVhbD1vc3Ryb21QZXJpb2RBdmVyYWdlKGl0ZW1zKTsKICAgIGNvbnN0IGNhcmRzPVtbU3RyaW5nKHllYXIpLGFubnVhbCx5ZWFyPT09Y3VycmVudFllYXI/ImJpcyBoZXV0ZSI6IkphaHJlc3dlcnQiXV07CiAgICBmb3IobGV0IHE9MTtxPD00O3ErKyljYXJkcy5wdXNoKFtgUSR7cX1gLG9zdHJvbVBlcmlvZEF2ZXJhZ2UoaXRlbXMuZmlsdGVyKGl0ZW09PnF1YXJ0ZXJGb3JNb250aChpdGVtLm1vbnRoKT09PXEpKSxgJHtpdGVtcy5maWx0ZXIoaXRlbT0+cXVhcnRlckZvck1vbnRoKGl0ZW0ubW9udGgpPT09cSkubGVuZ3RofSBNb25hdChlKWBdKTsKICAgICQoJ29zdHJvbVByaWNlU3RhdHNNZXRyaWNzJykuaW5uZXJIVE1MPWNhcmRzLm1hcCgoW2xhYmVsLHN0YXRzLHN1Yl0pPT5gPGFydGljbGU+PHNwYW4+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+PHN0cm9uZz4ke051bWJlci5pc0Zpbml0ZShzdGF0cy5hdmVyYWdlQ3QpP2Ake251bShzdGF0cy5hdmVyYWdlQ3QsMil9IGN0L2tXaGA6IuKAkyJ9PC9zdHJvbmc+PHNtYWxsPiR7c3RhdHMubW9udGhzP2Ake2VzY2FwZUh0bWwoc3ViKX0gwrcgJHtudW0oc3RhdHMua1doLDApfSBrV2gke051bWJlci5pc0Zpbml0ZShzdGF0cy5lZmZlY3RpdmVDdCk/YCDCtyBpbmtsLiBGaXhrb3N0ZW4gJHtudW0oc3RhdHMuZWZmZWN0aXZlQ3QsMil9IGN0L2tXaGA6IiJ9YDoia2VpbmUgT3N0cm9tLURhdGVuIn08L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCcnKTsKICAgIGNvbnN0IG1vbnRoTWFwPW5ldyBNYXAoaXRlbXMubWFwKGl0ZW09PltOdW1iZXIoaXRlbS5tb250aC5zbGljZSg1LDcpKSxpdGVtXSkpOwogICAgJCgnb3N0cm9tUHJpY2VTdGF0c1RhYmxlJykuaW5uZXJIVE1MPUFycmF5LmZyb20oe2xlbmd0aDoxMn0sKF8saSk9PmkrMSkubWFwKG09PnsKICAgICAgY29uc3QgaXRlbT1tb250aE1hcC5nZXQobSk7aWYoIWl0ZW0pcmV0dXJuIGA8dHI+PHRkPiR7TU9OVEhTW20tMV19PC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48dGQ+4oCTPC90ZD48L3RyPmA7CiAgICAgIGNvbnN0IGVmZmVjdGl2ZT1OdW1iZXIoaXRlbS50b3RhbEtXaCk+MCYmTnVtYmVyLmlzRmluaXRlKGl0ZW0udG90YWxDb3N0RXVyKT9OdW1iZXIoaXRlbS50b3RhbENvc3RFdXIpL051bWJlcihpdGVtLnRvdGFsS1doKSoxMDA6bnVsbDsKICAgICAgY29uc3QgcnVubmluZz1pdGVtLnBhcnRpYWx8fGl0ZW0ubW9udGg9PT1jdXJyZW50TW9udGhLZXkoKTsKICAgICAgcmV0dXJuIGA8dHI+PHRkPiR7TU9OVEhTW20tMV19JHtydW5uaW5nPycgPHNtYWxsIGNsYXNzPSJwcmljZS1ydW5uaW5nIj5sYXVmZW5kPC9zbWFsbD4nOicnfTwvdGQ+PHRkPiR7bnVtKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gsMil9IGN0PC90ZD48dGQ+JHtOdW1iZXIuaXNGaW5pdGUoZWZmZWN0aXZlKT9gJHtudW0oZWZmZWN0aXZlLDIpfSBjdGA6IuKAkyJ9PC90ZD48dGQ+JHtudW0oaXRlbS50b3RhbEtXaCwxKX0ga1doPC90ZD48dGQ+JHtpdGVtLmNvbXBsZXRlPydPc3Ryb20gZXhha3QnOid1bnZvbGxzdMOkbmRpZyd9PC90ZD48L3RyPmA7CiAgICB9KS5qb2luKCcnKTsKICAgIGNvbnN0IGxhc3Q9aXRlbXMubWFwKGl0ZW09PkRhdGUucGFyc2UoaXRlbS51cGRhdGVkQXR8fCcnKSkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkuc29ydCgoYSxiKT0+Yi1hKVswXTsKICAgICQoJ29zdHJvbVByaWNlU3RhdHNTdGF0dXMnKS50ZXh0Q29udGVudD1vc3Ryb21QcmljZVN0YXRzQnVzeT8nT3N0cm9tLVByZWlzZSB3ZXJkZW4gZ2VsYWRlbiDigKYnOml0ZW1zLmxlbmd0aD9gJHtpdGVtcy5sZW5ndGh9IE1vbmF0KGUpIHZlcmbDvGdiYXIke2xhc3Q/YCDCtyB6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUobGFzdCl9YDonJ30gwrcgUXVhcnRhbC9KYWhyIHZlcmJyYXVjaHNnZXdpY2h0ZXRgOnNldHRpbmdzLm9zdHJvbUFwcEtleT8nTm9jaCBrZWluZSBQcmVpc3N0YXRpc3RpayBmw7xyIGRpZXNlcyBKYWhyIGdlbGFkZW4uJzonTm9jaCBrZWluZSBQcmVpc3N0YXRpc3RpayBzeW5jaHJvbmlzaWVydC4gQXVmIGVpbmVtIHZlcmJ1bmRlbmVuIEdlcsOkdCBtaXQgT3N0cm9tLVNjaGzDvHNzZWwgYWt0dWFsaXNpZXJlbi4nOwogICAgJCgncmVmcmVzaE9zdHJvbVByaWNlU3RhdHNCdG4nKS5kaXNhYmxlZD1vc3Ryb21QcmljZVN0YXRzQnVzeXx8IXNldHRpbmdzLm9zdHJvbUFwcEtleTsKICAgIGRyYXdPc3Ryb21BdmVyYWdlUHJpY2VDaGFydCh5ZWFyLGl0ZW1zKTsKICB9CiAgZnVuY3Rpb24gZHJhd09zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0KHllYXIsaXRlbXM9b3N0cm9tU3RhdHNGb3JZZWFyKHllYXIpKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgnb3N0cm9tQXZlcmFnZVByaWNlQ2hhcnQnKSk7aWYoIWMpcmV0dXJuO2NvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOwogICAgY29uc3QgdmFscz1pdGVtcy5tYXAoaXRlbT0+TnVtYmVyKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTtpZighdmFscy5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LCdLZWluZSBPc3Ryb20tUHJlaXNkYXRlbicpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4udmFscykqMS4xNXx8MTsKICAgIGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKGl0ZW1zLm1hcChpdGVtPT5bTnVtYmVyKGl0ZW0ubW9udGguc2xpY2UoNSw3KSktMSxpdGVtXSkpO2N0eC5zdHJva2VTdHlsZT1DT0xPUlMuY29zdDtjdHgubGluZVdpZHRoPTIuODtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7CiAgICBmb3IobGV0IG09MDttPDEyO20rKyl7Y29uc3QgaXRlbT1tYXAuZ2V0KG0pO2lmKCFpdGVtfHwhTnVtYmVyLmlzRmluaXRlKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLWl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fWN0eC5zdHJva2UoKTsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLmNvc3Q7Zm9yKGxldCBtPTA7bTwxMjttKyspe2NvbnN0IGl0ZW09bWFwLmdldChtKTtpZighaXRlbXx8IU51bWJlci5pc0Zpbml0ZShpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSljb250aW51ZTtjb25zdCB4PWZyYW1lLmxlZnQrZnJhbWUucGxvdFcqbS8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1pdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doL21heCk7Y3R4LmJlZ2luUGF0aCgpO2N0eC5hcmMoeCx5LDMuMiwwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5mb250PScxMHB4IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LFNlZ29lIFVJLHNhbnMtc2VyaWYnO2N0eC5maWxsVGV4dChudW0oaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCwxKSx4LTEwLE1hdGgubWF4KDEwLHktOCkpO2N0eC5maWxsU3R5bGU9Q09MT1JTLmNvc3Q7fQogIH0KICBhc3luYyBmdW5jdGlvbiByZWZyZXNoT3N0cm9tUHJpY2VTdGF0cyh5ZWFyLHtzaWxlbnQ9ZmFsc2V9PXt9KXsKICAgIGlmKG9zdHJvbVByaWNlU3RhdHNCdXN5KXJldHVybiBmYWxzZTtpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtpZighc2lsZW50KXRvYXN0KCdPc3Ryb20genVlcnN0IHZlcmJpbmRlbicpO3JldHVybiBmYWxzZTt9CiAgICBjb25zdCB5PU51bWJlcih5ZWFyKTtpZighTnVtYmVyLmlzSW50ZWdlcih5KXx8eTwyMDIwfHx5Pm5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSl7aWYoIXNpbGVudCl0b2FzdCgnVW5nw7xsdGlnZXMgSmFocicpO3JldHVybiBmYWxzZTt9CiAgICBjb25zdCBub3c9bmV3IERhdGUoKSxsYXN0TW9udGg9eT09PW5vdy5nZXRGdWxsWWVhcigpP25vdy5nZXRNb250aCgpKzE6MTI7b3N0cm9tUHJpY2VTdGF0c0J1c3k9dHJ1ZTtyZW5kZXJPc3Ryb21QcmljZVN0YXRzKHkpOwogICAgbGV0IHVwZGF0ZWQ9MCx1bmF2YWlsYWJsZT0wO2NvbnN0IHJlY29yZE1hcD1uZXcgTWFwKHJlY29yZHMubWFwKHI9PltyLm1vbnRoLHsuLi5yfV0pKTsKICAgIHRyeXsKICAgICAgZm9yKGxldCBtPTE7bTw9bGFzdE1vbnRoO20rKyl7CiAgICAgICAgY29uc3QgbW9udGg9YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwnMCcpfWA7aWYoIXNpbGVudCkkKCdvc3Ryb21QcmljZVN0YXRzU3RhdHVzJykudGV4dENvbnRlbnQ9YCR7bW9udGhMYWJlbChtb250aCxmYWxzZSl9IHdpcmQgdm9uIE9zdHJvbSBnZWxhZGVuIOKApiAoJHttfS8ke2xhc3RNb250aH0pYDsKICAgICAgICB0cnl7CiAgICAgICAgICBjb25zdCBkYXRhPWF3YWl0IG9zdHJvbUZldGNoKGAvYXBpL21vbnRoP21vbnRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KG1vbnRoKX1gKTsKICAgICAgICAgIGlmKCFkYXRhPy5jb21wbGV0ZXx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLnRvdGFsS1doKSl8fE51bWJlcihkYXRhLnRvdGFsS1doKTw9MHx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS52YXJpYWJsZUNvc3RFdXIpKSl7dW5hdmFpbGFibGUrKztjb250aW51ZTt9CiAgICAgICAgICBjb25zdCBwYXJ0aWFsPW1vbnRoPT09Y3VycmVudE1vbnRoS2V5KCk7dXBzZXJ0T3N0cm9tUHJpY2VTdGF0KG1vbnRoLGRhdGEse3BhcnRpYWx9KTt1cGRhdGVkKys7CiAgICAgICAgICBpZighcGFydGlhbCYmcmVjb3JkTWFwLmhhcyhtb250aCkpe2NvbnN0IGl0ZW09cmVjb3JkTWFwLmdldChtb250aCksc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO2l0ZW0ucHJpY2VDdD1OdW1iZXIoZGF0YS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCk7aXRlbS5iYXNlRmVlPU51bWJlcihkYXRhLmZpeGVkQ29zdEV1cil8fDA7aXRlbS5vc3Ryb21WYXJpYWJsZUNvc3RFdXI9TnVtYmVyKGRhdGEudmFyaWFibGVDb3N0RXVyKTtpdGVtLm9zdHJvbVRvdGFsQ29zdEV1cj1OdW1iZXIoZGF0YS50b3RhbENvc3RFdXIpO2l0ZW0ub3N0cm9tQ29uc3VtcHRpb25LV2g9TnVtYmVyKGRhdGEudG90YWxLV2gpO2l0ZW0ub3N0cm9tUHJpY2VDb21wbGV0ZT10cnVlO2l0ZW0ucHJpY2VTb3VyY2U9J29zdHJvbS1ob3VybHktY29uc3VtcHRpb24td2VpZ2h0ZWQnO2l0ZW0ucHJpY2VVcGRhdGVkQXQ9c3RhbXA7aXRlbS51cGRhdGVkQXQ9c3RhbXA7cmVjb3JkTWFwLnNldChtb250aCxpdGVtKTt9CiAgICAgICAgfWNhdGNoe3VuYXZhaWxhYmxlKys7fQogICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmU9PnNldFRpbWVvdXQocmVzb2x2ZSwxNDApKTsKICAgICAgfQogICAgICBpZih1cGRhdGVkKXNhdmVSZWNvcmRzKFsuLi5yZWNvcmRNYXAudmFsdWVzKCldLHtyZWFzb246YE9zdHJvbS1QcmVpc3N0YXRpc3RpayAke3l9IGFrdHVhbGlzaWVydGB9KTsKICAgICAgcmVuZGVyQWxsKCk7aWYoIXNpbGVudCl0b2FzdChgJHt1cGRhdGVkfSBPc3Ryb20tTW9uYXQoZSkgZsO8ciAke3l9IGFrdHVhbGlzaWVydCR7dW5hdmFpbGFibGU/YCDCtyAke3VuYXZhaWxhYmxlfSBuaWNodCB2ZXJmw7xnYmFyYDonJ31gKTtyZXR1cm4gdXBkYXRlZD4wOwogICAgfWZpbmFsbHl7b3N0cm9tUHJpY2VTdGF0c0J1c3k9ZmFsc2U7cmVuZGVyT3N0cm9tUHJpY2VTdGF0cyh5KTt9CiAgfQogIGZ1bmN0aW9uIGFubnVhbFN1bXMocm93cyl7CiAgICByZXR1cm4gcm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKWEudG90YWwrPXIudG90YWw7IGlmKE51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSlhLmhlYXQrPXIuaGVhdFB1bXA7IGlmKE51bWJlci5pc0Zpbml0ZShyLmFubmV4KSlhLmFubmV4Kz1yLmFubmV4OyBjb25zdCByZXN0PWRlcml2ZWQocik7IGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdD49MClhLnJlc3QrPXJlc3Q7IGNvbnN0IGNvc3Q9cmVjb3JkQ29zdChyKTsgaWYoTnVtYmVyLmlzRmluaXRlKGNvc3QpKWEuY29zdCs9Y29zdDsgaWYoTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKWEuY291bnQrKzsgcmV0dXJuIGE7IH0se3RvdGFsOjAsaGVhdDowLGFubmV4OjAscmVzdDowLGNvc3Q6MCxjb3VudDowfSk7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckFuYWx5c2lzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3QgeWVhclNlbGVjdD0kKCJhbmFseXNpc1llYXIiKTsKICAgIGNvbnN0IHByaW9yPU51bWJlcih5ZWFyU2VsZWN0LnZhbHVlKTsKICAgIGNvbnN0IHNlbGVjdGVkPXlzLmluY2x1ZGVzKHByaW9yKT9wcmlvcjooeXNbMF18fG5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSk7CiAgICB5ZWFyU2VsZWN0LmlubmVySFRNTD0oeXMubGVuZ3RoP3lzOltuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCldKS5tYXAoeT0+YDxvcHRpb24gdmFsdWU9IiR7eX0iPiR7eX08L29wdGlvbj5gKS5qb2luKCIiKTsKICAgIHllYXJTZWxlY3QudmFsdWU9U3RyaW5nKHNlbGVjdGVkKTsKICAgIGNvbnN0IHJvd3M9YW5hbHlzaXNZZWFyUm93cyhzZWxlY3RlZCksIHN1bXM9YW5udWFsU3Vtcyhyb3dzKTsKICAgIGNvbnN0IHByZXZpb3VzWWVhcj15cy5maWx0ZXIoeT0+eTxzZWxlY3RlZCkuc29ydCgoYSxiKT0+Yi1hKVswXXx8bnVsbDsKICAgIGNvbnN0IHByZXZpb3VzUm93cz1wcmV2aW91c1llYXI/YW5hbHlzaXNZZWFyUm93cyhwcmV2aW91c1llYXIpOltdOwogICAgY29uc3QgcHJldmlvdXM9YW5udWFsU3VtcyhwcmV2aW91c1Jvd3MpOwogICAgY29uc3QgdG90YWxEZWx0YT1wcmV2aW91cy5jb3VudCYmcHJldmlvdXMudG90YWw/KChzdW1zLnRvdGFsLXByZXZpb3VzLnRvdGFsKS9wcmV2aW91cy50b3RhbCoxMDApOm51bGw7CiAgICBjb25zdCBjb3BSb3dzPXJvd3MubWFwKHJlY29yZENvcCkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7CiAgICBjb25zdCBhbm51YWxDb3A9cm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApJiZOdW1iZXIuaXNGaW5pdGUoci5oZWF0R2VuZXJhdGVkKSl7YS5lKz1yLmhlYXRQdW1wO2EuaCs9ci5oZWF0R2VuZXJhdGVkO30gcmV0dXJuIGE7fSx7ZTowLGg6MH0pOwogICAgY29uc3QgZXhhY3RQcmljZU1vbnRocz1yb3dzLmZpbHRlcihyPT5yLm9zdHJvbVByaWNlQ29tcGxldGUmJk51bWJlci5pc0Zpbml0ZShyLm9zdHJvbVRvdGFsQ29zdEV1cikpLmxlbmd0aDsKICAgIGNvbnN0IG1ldHJpY3M9WwogICAgICBbIkdlc2FtdCIsYCR7bnVtKHN1bXMudG90YWwsMCl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKHRvdGFsRGVsdGEpP2Ake3BjdCh0b3RhbERlbHRhKX0genUgJHtwcmV2aW91c1llYXJ9YDpgJHtzdW1zLmNvdW50fSBNb25hdGVgXSwKICAgICAgWyJXw6RybWVwdW1wZSIsYCR7bnVtKHN1bXMuaGVhdCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLmhlYXQvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJBbHRlbnRlaWwiLGAke251bShzdW1zLmFubmV4LDApfSBrV2hgLHN1bXMudG90YWw/YCR7bnVtKHN1bXMuYW5uZXgvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJTY2hsZWUvS2x1cyIsYCR7bnVtKHN1bXMucmVzdCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLnJlc3Qvc3Vtcy50b3RhbCoxMDAsMSl9ICVgOiLigJMiXSwKICAgICAgWyJLb3N0ZW4iLGV1cm8oc3Vtcy5jb3N0KSxleGFjdFByaWNlTW9udGhzP2Ake2V4YWN0UHJpY2VNb250aHN9IE1vbmF0KGUpIG1pdCBPc3Ryb20tU3R1bmRlbnByZWlzZW5gOmFubnVhbENvcC5lPjA/YFdQLUFyYmVpdHN6YWhsICR7bnVtKGFubnVhbENvcC5oL2FubnVhbENvcC5lLDIpfWA6IkZhbGxiYWNrLVByZWlzZSJdCiAgICBdOwogICAgJCgiYW5hbHlzaXNNZXRyaWNzIikuaW5uZXJIVE1MPW1ldHJpY3MubWFwKChbbCx2LHNdKT0+YDxhcnRpY2xlPjxzcGFuPiR7bH08L3NwYW4+PHN0cm9uZz4ke3Z9PC9zdHJvbmc+PHNtYWxsPiR7c308L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCIiKTsKICAgICQoImFuYWx5c2lzVGFibGUiKS5pbm5lckhUTUw9cm93cy5sZW5ndGg/cm93cy5tYXAocj0+YDx0cj48dGQ+JHtlc2NhcGVIdG1sKG1vbnRoTGFiZWwoci5tb250aCxmYWxzZSkpfTwvdGQ+PHRkPiR7bnVtKHIudG90YWwsMSl9PC90ZD48dGQ+JHtudW0oci5oZWF0UHVtcCwxKX08L3RkPjx0ZD4ke251bShyLmFubmV4LDEpfTwvdGQ+PHRkPiR7bnVtKGRlcml2ZWQociksMSl9PC90ZD48dGQ+JHtldXJvKHJlY29yZENvc3QocikpfSR7ci5vc3Ryb21QcmljZUNvbXBsZXRlPyIgKiI6IiJ9PC90ZD48L3RyPmApLmpvaW4oIiIpOic8dHI+PHRkIGNvbHNwYW49IjYiPktlaW5lIE1vbmF0c2RhdGVuIGbDvHIgZGllc2VzIEphaHIuPC90ZD48L3RyPic7CiAgICAkKCJjb3BQYW5lbCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIWNvcFJvd3MubGVuZ3RoKTsKICAgIHJlbmRlck9zdHJvbVByaWNlU3RhdHMoc2VsZWN0ZWQpOwogICAgcmVuZGVyQ2xpbWF0ZUFuYWx5c2lzKCk7CiAgICBkcmF3QWxsb2NhdGlvbkNoYXJ0KHJvd3MpOyBkcmF3VG90YWxDaGFydEFsbFllYXJzKHlzKTsgZHJhd0Nvc3RDaGFydChyb3dzKTsgaWYoY29wUm93cy5sZW5ndGgpZHJhd0NvcENoYXJ0KHJvd3MpOwogIH0KCiAgZnVuY3Rpb24gY2FudmFzU2V0dXAoY2FudmFzKXsKICAgIGlmKCFjYW52YXMpcmV0dXJuIG51bGw7CiAgICBjb25zdCByZWN0PWNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsgY29uc3QgZHByPU1hdGgubWluKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvfHwxLDIpOyBjb25zdCB3aWR0aD1NYXRoLm1heCgyODAsTWF0aC5yb3VuZChyZWN0LndpZHRofHw2MDApKTsgY29uc3QgaGVpZ2h0PU1hdGgubWF4KDE4MCxNYXRoLnJvdW5kKHJlY3QuaGVpZ2h0fHwyNjApKTsKICAgIGNhbnZhcy53aWR0aD1NYXRoLnJvdW5kKHdpZHRoKmRwcik7IGNhbnZhcy5oZWlnaHQ9TWF0aC5yb3VuZChoZWlnaHQqZHByKTsgY29uc3QgY3R4PWNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOyBjdHguc2V0VHJhbnNmb3JtKGRwciwwLDAsZHByLDAsMCk7IGN0eC5jbGVhclJlY3QoMCwwLHdpZHRoLGhlaWdodCk7IHJldHVybiB7Y3R4LHdpZHRoLGhlaWdodH07CiAgfQogIGZ1bmN0aW9uIGRyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LHRleHQ9IktlaW5lIERhdGVuIil7CiAgICBjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0OyBjdHguZm9udD0iMTNweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjsgY3R4LnRleHRBbGlnbj0iY2VudGVyIjsgY3R4LmZpbGxUZXh0KHRleHQsd2lkdGgvMixoZWlnaHQvMik7IGN0eC50ZXh0QWxpZ249ImxlZnQiOwogIH0KICBmdW5jdGlvbiBjaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LGxhYmVscyx7bGVmdD00OCxib3R0b209MzQsdG9wPTE1LHJpZ2h0PTEyfT17fSl7CiAgICBjb25zdCBwbG90Vz13aWR0aC1sZWZ0LXJpZ2h0LCBwbG90SD1oZWlnaHQtdG9wLWJvdHRvbTsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuZ3JpZDsgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDsgY3R4LmZvbnQ9IjEwcHggLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsU2Vnb2UgVUksc2Fucy1zZXJpZiI7IGN0eC5saW5lV2lkdGg9MTsKICAgIGZvcihsZXQgaT0wO2k8PTQ7aSsrKXsgY29uc3QgeT10b3ArcGxvdEgqaS80OyBjdHguYmVnaW5QYXRoKCk7Y3R4Lm1vdmVUbyhsZWZ0LHkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseSk7Y3R4LnN0cm9rZSgpOyBjb25zdCB2YWw9bWF4KigxLWkvNCk7Y3R4LmZpbGxUZXh0KG51bSh2YWwsMCksNCx5KzMpOyB9CiAgICBpZihsYWJlbHM/Lmxlbmd0aCl7IGxhYmVscy5mb3JFYWNoKChsYWJlbCxpKT0+eyBjb25zdCB4PWxlZnQrKGxhYmVscy5sZW5ndGg9PT0xP3Bsb3RXLzI6cGxvdFcqaS8obGFiZWxzLmxlbmd0aC0xKSk7IGN0eC5maWxsVGV4dChsYWJlbCx4LTEwLGhlaWdodC0xMCk7IH0pOyB9CiAgICByZXR1cm4ge2xlZnQscmlnaHQsdG9wLGJvdHRvbSxwbG90VyxwbG90SH07CiAgfQogIGZ1bmN0aW9uIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCByb3dzPXNvcnRlZCgpLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpLnNsaWNlKC0xMik7IGlmKCFyb3dzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4ucm93cy5tYXAocj0+ci50b3RhbCkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgscm93cy5tYXAocj0+TU9OVEhTW051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTFdKSx7fSk7CiAgICBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLnRvdGFsO2N0eC5saW5lV2lkdGg9Mi41O2N0eC5iZWdpblBhdGgoKTtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PWZyYW1lLmxlZnQrKHJvd3MubGVuZ3RoPT09MT9mcmFtZS5wbG90Vy8yOmZyYW1lLnBsb3RXKmkvKHJvd3MubGVuZ3RoLTEpKTtjb25zdCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1yLnRvdGFsL21heCk7aT9jdHgubGluZVRvKHgseSk6Y3R4Lm1vdmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLnRvdGFsO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9ZnJhbWUubGVmdCsocm93cy5sZW5ndGg9PT0xP2ZyYW1lLnBsb3RXLzI6ZnJhbWUucGxvdFcqaS8ocm93cy5sZW5ndGgtMSkpO2NvbnN0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXIudG90YWwvbWF4KTtjdHguYmVnaW5QYXRoKCk7Y3R4LmFyYyh4LHksMywwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0FsbG9jYXRpb25DaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiYWxsb2NhdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxpZD1yb3dzLmZpbHRlcihyPT5bci5oZWF0UHVtcCxyLmFubmV4LHIudG90YWxdLnNvbWUoTnVtYmVyLmlzRmluaXRlKSk7IGlmKCF2YWxpZC5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbGlkLm1hcChyPT5NYXRoLm1heCgwLE51bWJlcihyLnRvdGFsKXx8KChOdW1iZXIoci5oZWF0UHVtcCl8fDApKyhOdW1iZXIoci5hbm5leCl8fDApKyhNYXRoLm1heCgwLGRlcml2ZWQocikpfHwwKSkpKSkqMS4xfHwxOyBjb25zdCBsYWJlbHM9dmFsaWQubWFwKHI9Pk1PTlRIU1tOdW1iZXIoci5tb250aC5zbGljZSg1LDcpKS0xXSk7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsbGFiZWxzLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy92YWxpZC5sZW5ndGgsIGJhclc9TWF0aC5taW4oMzgsc2xvdCouNjIpOwogICAgdmFsaWQuZm9yRWFjaCgocixpKT0+eyBjb25zdCB4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzI7IGxldCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SDsgY29uc3QgcGFydHM9W1tNYXRoLm1heCgwLE51bWJlcihyLmhlYXRQdW1wKXx8MCksQ09MT1JTLmhlYXRdLFtNYXRoLm1heCgwLE51bWJlcihyLmFubmV4KXx8MCksQ09MT1JTLmFubmV4XSxbTWF0aC5tYXgoMCxkZXJpdmVkKHIpfHwwKSxDT0xPUlMucmVzdF1dOyBmb3IoY29uc3QgW3YsY29sb3JdIG9mIHBhcnRzKXtjb25zdCBoPWZyYW1lLnBsb3RIKnYvbWF4O3ktPWg7Y3R4LmZpbGxTdHlsZT1jb2xvcjtjdHguZmlsbFJlY3QoeCx5LGJhclcsaCk7fSB9KTsKICB9CiAgZnVuY3Rpb24geWVhckNvbG9yKHllYXIseWVhcnNBc2MpewogICAgY29uc3QgaW5kZXg9TWF0aC5tYXgoMCx5ZWFyc0FzYy5pbmRleE9mKHllYXIpKTsKICAgIHJldHVybiBZRUFSX0NPTE9SU1tpbmRleCVZRUFSX0NPTE9SUy5sZW5ndGhdOwogIH0KICBmdW5jdGlvbiBkcmF3VG90YWxDaGFydEFsbFllYXJzKHllYXJMaXN0KXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgidG90YWxDaGFydCIpKTsgaWYoIWMpcmV0dXJuOwogICAgY29uc3QgeWVhcnNBc2M9Wy4uLnllYXJMaXN0XS5zb3J0KChhLGIpPT5hLWIpOwogICAgY29uc3Qgc2VyaWVzPXllYXJzQXNjLm1hcCh5ZWFyPT4oe3llYXIscm93czphbmFseXNpc1llYXJSb3dzKHllYXIpfSkpLmZpbHRlcihzPT5zLnJvd3Muc29tZShyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpKTsKICAgIGNvbnN0IHZhbHM9c2VyaWVzLmZsYXRNYXAocz0+cy5yb3dzKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKTsKICAgIGlmKCF2YWxzLmxlbmd0aCl7ZHJhd0VtcHR5KGMuY3R4LGMud2lkdGgsYy5oZWlnaHQpOyQoInllYXJDb21wYXJpc29uTGVnZW5kIikuaW5uZXJIVE1MPSIiO3JldHVybjt9CiAgICBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMubWFwKHI9PnIudG90YWwpKSoxLjEyfHwxOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7CiAgICBjb25zdCBjdXJyZW50WWVhcj1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk7CiAgICAkKCJ5ZWFyQ29tcGFyaXNvbkxlZ2VuZCIpLmlubmVySFRNTD1zZXJpZXMubWFwKGl0ZW09Pntjb25zdCBjb2xvcj15ZWFyQ29sb3IoaXRlbS55ZWFyLHllYXJzQXNjKTtjb25zdCBwYXN0PWl0ZW0ueWVhciE9PWN1cnJlbnRZZWFyO3JldHVybiBgPHNwYW4gY2xhc3M9IiR7cGFzdD8icGFzdCI6ImN1cnJlbnQifSIgc3R5bGU9ImNvbG9yOiR7Y29sb3J9Ij48aT48L2k+JHtpdGVtLnllYXJ9JHtwYXN0PyIiOiIgwrcgYWt0dWVsbCJ9PC9zcGFuPmA7fSkuam9pbigiIik7CiAgICBmb3IoY29uc3QgaXRlbSBvZiBzZXJpZXMpewogICAgICBjb25zdCBjb2xvcj15ZWFyQ29sb3IoaXRlbS55ZWFyLHllYXJzQXNjKSxkYXNoZWQ9aXRlbS55ZWFyIT09Y3VycmVudFllYXI7CiAgICAgIGNvbnN0IG1hcD1uZXcgTWFwKGl0ZW0ucm93cy5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKS5tYXAocj0+W051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTEsci50b3RhbF0pKTsKICAgICAgY3R4LnN0cm9rZVN0eWxlPWNvbG9yO2N0eC5saW5lV2lkdGg9ZGFzaGVkPzIuMjozO2N0eC5zZXRMaW5lRGFzaChkYXNoZWQ/WzcsNV06W10pO2N0eC5iZWdpblBhdGgoKTtsZXQgc3RhcnRlZD1mYWxzZTsKICAgICAgZm9yKGxldCBtPTA7bTwxMjttKyspe2lmKCFtYXAuaGFzKG0pKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLW1hcC5nZXQobSkvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fQogICAgICBjdHguc3Ryb2tlKCk7Y3R4LnNldExpbmVEYXNoKFtdKTsKICAgICAgY3R4LmZpbGxTdHlsZT1jb2xvcjtmb3IobGV0IG09MDttPDEyO20rKyl7aWYoIW1hcC5oYXMobSkpY29udGludWU7Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKm0vMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtbWFwLmdldChtKS9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSxkYXNoZWQ/Mi4yOjMuMiwwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBkcmF3Q29zdENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3N0Q2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbHM9cm93cy5tYXAocj0+cmVjb3JkQ29zdChyKSk7IGlmKCF2YWxzLnNvbWUoTnVtYmVyLmlzRmluaXRlKSl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsIktlaW5lIEtvc3RlbmRhdGVuIik7cmV0dXJuO30gY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy8xMixiYXJXPU1hdGgubWluKDM4LHNsb3QqLjYyKTsgdmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgaD1mcmFtZS5wbG90SCp2L21heCx4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzIseT1mcmFtZS50b3ArZnJhbWUucGxvdEgtaDtjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O2N0eC5maWxsUmVjdCh4LHksYmFyVyxoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0NvcENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3BDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgdmFscz1yb3dzLm1hcChyZWNvcmRDb3ApOyBpZighdmFscy5zb21lKE51bWJlci5pc0Zpbml0ZSkpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fSBjb25zdCBtYXg9TWF0aC5tYXgoNSwuLi52YWxzLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKSoxLjA1OyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7IGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuaGVhdDtjdHgubGluZVdpZHRoPTIuNDtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7dmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKmkvMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtdi9tYXgpO2lmKCFzdGFydGVkKXtjdHgubW92ZVRvKHgseSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRlclBhbmVsKCl7CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighbGF0ZXN0KXJldHVybjsKICAgICQoIm1ldGVyTGF0ZXN0IikuaW5uZXJIVE1MPWA8YXJ0aWNsZT48c3Bhbj5TdGFuZCB2b208L3NwYW4+PHN0cm9uZz4ke2RhdGVMYWJlbChsYXRlc3QuZGF0ZSl9PC9zdHJvbmc+PHNtYWxsPmxldHp0ZSBBYmxlc3VuZzwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkdlc2FtdDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC50b3RhbCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkFsdGVudGVpbDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC5hbm5leCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPmA7CiAgICAkKCJtZXRlckhpc3RvcnkiKS5pbm5lckhUTUw9bWV0ZXJSZWFkaW5ncy5zbGljZSgpLnJldmVyc2UoKS5zbGljZSgwLDgpLm1hcCgocixpKT0+YDxkaXYgY2xhc3M9Im1ldGVyLWhpc3Rvcnktcm93Ij48c3Bhbj4ke2RhdGVMYWJlbChyLmRhdGUpfTwvc3Bhbj48c3Ryb25nPkdlc2FtdCAke251bShyLnRvdGFsLDApfTwvc3Ryb25nPjxzdHJvbmc+QWx0ZW50ZWlsICR7bnVtKHIuYW5uZXgsMCl9PC9zdHJvbmc+JHtpPT09bWV0ZXJSZWFkaW5ncy5sZW5ndGgtMT8nPHNtYWxsPlN0YXJ0d2VydDwvc21hbGw+JzonJ308L2Rpdj5gKS5qb2luKCIiKTsKICAgICQoInVuZG9MYXRlc3RNZXRlckJ0biIpLmRpc2FibGVkPW1ldGVyUmVhZGluZ3MubGVuZ3RoPD0xOwogIH0KICBmdW5jdGlvbiByZW5kZXJEYXRhKCl7CiAgICBjb25zdCBpc3N1ZXM9W107IGxldCBjb21wbGV0ZUNvdW50PTA7CiAgICBmb3IoY29uc3QgciBvZiByZWNvcmRzKXsKICAgICAgY29uc3QgbWlzc2luZz1bXTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSltaXNzaW5nLnB1c2goIkdlc2FtdCIpOyBpZighTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApKW1pc3NpbmcucHVzaCgiV8Okcm1lcHVtcGUiKTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLmFubmV4KSltaXNzaW5nLnB1c2goIkFsdGVudGVpbCIpOyBjb25zdCByZXN0PWRlcml2ZWQocik7CiAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwKWlzc3Vlcy5wdXNoKHtsZXZlbDoiZXJyb3IiLG1vbnRoOnIubW9udGgsdGl0bGU6IkF1ZnRlaWx1bmcgdW5wbGF1c2liZWwiLGRldGFpbDpgU2NobGVlL0tsdXMgZXJnaWJ0ICR7bnVtKHJlc3QsMSl9IGtXaC5gfSk7CiAgICAgIGVsc2UgaWYobWlzc2luZy5sZW5ndGgpaXNzdWVzLnB1c2goe2xldmVsOiJ3YXJuaW5nIixtb250aDpyLm1vbnRoLHRpdGxlOiJNb25hdCB1bnZvbGxzdMOkbmRpZyIsZGV0YWlsOmBGZWhsdDogJHttaXNzaW5nLmpvaW4oIiwgIil9YH0pOwogICAgICBlbHNlIGNvbXBsZXRlQ291bnQrKzsKICAgIH0KICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RSZWNvcmQoKTsKICAgIGNvbnN0IHE9WwogICAgICBbIk1vbmF0ZSIsU3RyaW5nKHJlY29yZHMubGVuZ3RoKSwiZ2VzcGVpY2hlcnQiXSwKICAgICAgWyJWb2xsc3TDpG5kaWciLFN0cmluZyhjb21wbGV0ZUNvdW50KSxyZWNvcmRzLmxlbmd0aD9gJHtudW0oY29tcGxldGVDb3VudC9yZWNvcmRzLmxlbmd0aCoxMDAsMCl9ICVgOiLigJMiXSwKICAgICAgWyJIaW53ZWlzZSIsU3RyaW5nKGlzc3Vlcy5sZW5ndGgpLGlzc3Vlcy5zb21lKGk9PmkubGV2ZWw9PT0iZXJyb3IiKT8ibWluZC4gMSBGZWhsZXIiOiJwcsO8ZmVuIl0sCiAgICAgIFsiTGV0enRlciBNb25hdCIsbGF0ZXN0P21vbnRoTGFiZWwobGF0ZXN0Lm1vbnRoLGZhbHNlKToi4oCTIiwiYXV0b21hdGlzY2ggYmVyZWNobmV0Il0KICAgIF07CiAgICAkKCJxdWFsaXR5TWV0cmljcyIpLmlubmVySFRNTD1xLm1hcCgoW2wsdixzXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2x9PC9zcGFuPjxzdHJvbmc+JHt2fTwvc3Ryb25nPjxzbWFsbD4ke3N9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbigiIik7CiAgICAkKCJxdWFsaXR5SXNzdWVzIikuaW5uZXJIVE1MPWlzc3Vlcy5sZW5ndGg/aXNzdWVzLnNsaWNlKCkucmV2ZXJzZSgpLnNsaWNlKDAsMTYpLm1hcChpPT5gPGFydGljbGUgY2xhc3M9Imlzc3VlICR7aS5sZXZlbH0iPjxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChpLm1vbnRoKSl9OiAke2VzY2FwZUh0bWwoaS50aXRsZSl9PC9zdHJvbmc+PHNtYWxsPiR7ZXNjYXBlSHRtbChpLmRldGFpbCl9PC9zbWFsbD48L2Rpdj48L2FydGljbGU+YCkuam9pbigiIik6JzxhcnRpY2xlIGNsYXNzPSJpc3N1ZSI+PGRpdj48c3Ryb25nPktlaW5lIEF1ZmbDpGxsaWdrZWl0ZW48L3N0cm9uZz48c21hbGw+QWxsZSBnZXNwZWljaGVydGVuIE1vbmF0ZSBzaW5kIHBsYXVzaWJlbCB1bmQgdm9sbHN0w6RuZGlnLjwvc21hbGw+PC9kaXY+PC9hcnRpY2xlPic7CiAgICByZW5kZXJNZXRlclBhbmVsKCk7CiAgICAkKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlPXNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiI7CiAgICAkKCJvc3Ryb21BdXRvUmVmcmVzaElucHV0IikuY2hlY2tlZD1zZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlOwogICAgJCgicHJlZmVycmVkV2luZG93SG91cnNJbnB1dCIpLnZhbHVlPVN0cmluZyhzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vyc3x8Myk7CiAgICAkKCJmYWxsYmFja1ByaWNlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMikudG9GaXhlZCgzKTsKICAgICQoImRlZmF1bHRCYXNlRmVlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApLnRvRml4ZWQoMik7CiAgICBjb25zdCBsYXN0QmFja3VwPWxvY2FsU3RvcmFnZS5nZXRJdGVtKExBU1RfQkFDS1VQX0tFWSk7ICQoImJhY2t1cFN0YXR1cyIpLnRleHRDb250ZW50PWxhc3RCYWNrdXA/YExldHp0ZXMgQmFja3VwOiAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2RhdGVTdHlsZToibWVkaXVtIix0aW1lU3R5bGU6InNob3J0In0pLmZvcm1hdChuZXcgRGF0ZShsYXN0QmFja3VwKSl9YDoiTm9jaCBrZWluIEJhY2t1cCBtaXQgRWxkZWhvZiA2LjIgZXJzdGVsbHQuIjsKICAgIGNvbnN0IGhpc3RvcnlTdGF0dXM9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShPU1RST01fSElTVE9SWV9LRVkpLG51bGwpOwogICAgaWYoJCgib3N0cm9tSGlzdG9yeVN0YXR1cyIpKSQoIm9zdHJvbUhpc3RvcnlTdGF0dXMiKS50ZXh0Q29udGVudD1vc3Ryb21IaXN0b3J5QnVzeT8iSGlzdG9yaXNjaGUgT3N0cm9tLVByZWlzZSB3ZXJkZW4gZ2VsYWRlbiDigKYiOmhpc3RvcnlTdGF0dXM/LnVwZGF0ZWRBdD9gUHJlaXNoaXN0b3JpZSB6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUoaGlzdG9yeVN0YXR1cy51cGRhdGVkQXQpfSDCtyAke2hpc3RvcnlTdGF0dXMudXBkYXRlZHx8MH0gTW9uYXQoZSkgZXhha3QgwrcgJHtoaXN0b3J5U3RhdHVzLnVuYXZhaWxhYmxlfHwwfSBuaWNodCB2ZXJmw7xnYmFyYDpgSGlzdG9yaXNjaGUgUHJlaXNlIG5vY2ggbmljaHQgZ2VwcsO8ZnQuYDsKICAgIHJlbmRlclN5bmNQYW5lbCgpOwogIH0KCiAgZnVuY3Rpb24gZG93bmxvYWRCbG9iKGNvbnRlbnQsZmlsZW5hbWUsdHlwZSl7IGNvbnN0IGJsb2I9bmV3IEJsb2IoW2NvbnRlbnRdLHt0eXBlfSk7IGNvbnN0IHVybD1VUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOyBjb25zdCBhPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImEiKTsgYS5ocmVmPXVybDthLmRvd25sb2FkPWZpbGVuYW1lO2RvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYSk7YS5jbGljaygpO2EucmVtb3ZlKCk7c2V0VGltZW91dCgoKT0+VVJMLnJldm9rZU9iamVjdFVSTCh1cmwpLDEwMDApOyB9CiAgZnVuY3Rpb24gZXhwb3J0QmFja3VwKCl7CiAgICBjb25zdCBub3c9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgY29uc3QgcmVsZXZhbnRTZXR0aW5ncz17ZmFsbGJhY2tQcmljZTpzZXR0aW5ncy5mYWxsYmFja1ByaWNlLGRlZmF1bHRCYXNlRmVlOnNldHRpbmdzLmRlZmF1bHRCYXNlRmVlLG9zdHJvbUFwcEtleTpzZXR0aW5ncy5vc3Ryb21BcHBLZXksb3N0cm9tQXV0b1JlZnJlc2g6c2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2gscHJlZmVycmVkV2luZG93SG91cnM6c2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnN9OwogICAgY29uc3QgcGF5bG9hZD17dmVyc2lvbjoiNi4zLjIiLGFwcDoiRWxkZWhvZiIscHVycG9zZToiUHJpdmF0ZXMgbG9rYWxlcyBCYWNrdXAg4oCTIG5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbiIsZXhwb3J0ZWRBdDpub3csc2V0dGluZ3M6cmVsZXZhbnRTZXR0aW5ncyxyZWNvcmRzLHZhaWxsYW50TW9udGhzLG1ldGVyUmVhZGluZ3Msb3N0cm9tUHJpY2VTdGF0cyxjbGltYXRlTW9udGhzLGNsaW1hdGVXZWF0aGVyfTsKICAgIGRvd25sb2FkQmxvYihKU09OLnN0cmluZ2lmeShwYXlsb2FkLG51bGwsMiksYEVsZGVob2ZfUFJJVkFURV9CYWNrdXBfJHtkYXRlU3RhbXAoKX0uanNvbmAsImFwcGxpY2F0aW9uL2pzb24iKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTEFTVF9CQUNLVVBfS0VZLG5vdyk7IHJlbmRlckRhdGEoKTsgdG9hc3QoIlByaXZhdGVzIEJhY2t1cCBlcnN0ZWxsdCIpOwogIH0KICBmdW5jdGlvbiBleHBvcnRDc3YoKXsKICAgIGNvbnN0IHJvd3M9W1siTW9uYXQiLCJXw6RybWVwdW1wZSBrV2giLCJFcnpldWd0ZSBXw6RybWUga1doIiwiQXJiZWl0c3phaGwiLCJBbHRlbnRlaWwga1doIiwiU2NobGVlL0tsdXMga1doIiwiR2VzYW10IGtXaCIsIkdlc2FtdC1aw6RobGVyc3RhbmQga1doIiwiQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2giLCJBYmxlc2VkYXR1bSIsIlByZWlzIGN0L2tXaCIsIkZpeGtvc3RlbiBFVVIiLCJLb3N0ZW4gRVVSIiwiUHJlaXNxdWVsbGUiLCJPc3Ryb20tVmVyYnJhdWNoIGtXaCIsIk5vdGl6Il1dOwogICAgZm9yKGNvbnN0IHIgb2Ygc29ydGVkKCkpcm93cy5wdXNoKFtyLm1vbnRoLHIuaGVhdFB1bXA/PyIiLHIuaGVhdEdlbmVyYXRlZD8/IiIscmVjb3JkQ29wKHIpPz8iIixyLmFubmV4Pz8iIixkZXJpdmVkKHIpPz8iIixyLnRvdGFsPz8iIixyLnRvdGFsTWV0ZXJSZWFkaW5nPz8iIixyLmFubmV4TWV0ZXJSZWFkaW5nPz8iIixyLm1ldGVyUmVhZGluZ0RhdGU/PyIiLHIucHJpY2VDdD8/IiIsci5iYXNlRmVlPz8iIixyZWNvcmRDb3N0KHIpPz8iIixyLnByaWNlU291cmNlfHwiIixyLm9zdHJvbUNvbnN1bXB0aW9uS1doPz8iIixyLm5vdGV8fCIiXSk7CiAgICBkb3dubG9hZEJsb2IoIlx1RkVGRiIrcm93cy5tYXAocm93PT5yb3cubWFwKGNzdkNlbGwpLmpvaW4oIjsiKSkuam9pbigiXG4iKSxgRWxkZWhvZl9WZXJicmF1Y2hfJHtkYXRlU3RhbXAoKX0uY3N2YCwidGV4dC9jc3Y7Y2hhcnNldD11dGYtOCIpOyB0b2FzdCgiQ1NWIGVyc3RlbGx0Iik7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhY2t1cChmaWxlKXsKICAgIHRyeXsKICAgICAgY29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKGF3YWl0IGZpbGUudGV4dCgpKTsgY29uc3QgaW5jb21pbmc9QXJyYXkuaXNBcnJheShwYXlsb2FkKT9wYXlsb2FkOihBcnJheS5pc0FycmF5KHBheWxvYWQucmVjb3Jkcyk/cGF5bG9hZC5yZWNvcmRzOnBheWxvYWQuZGF0YSk7IGlmKCFBcnJheS5pc0FycmF5KGluY29taW5nKSl0aHJvdyBuZXcgRXJyb3IoIktlaW5lIE1vbmF0c2RhdGVuIGdlZnVuZGVuLiIpOwogICAgICBjb25zdCBjbGVhbmVkPXNhbml0aXplUmVjb3JkcyhpbmNvbWluZyk7IGlmKCFjbGVhbmVkLmxlbmd0aCYmIWNvbmZpcm0oIkRhcyBCYWNrdXAgZW50aMOkbHQga2VpbmUgTW9uYXRzd2VydGUuIExlZXJlbiBCZXN0YW5kIHdpcmtsaWNoIGltcG9ydGllcmVuPyIpKXJldHVybjsKICAgICAgaWYoIWNvbmZpcm0oYCR7Y2xlYW5lZC5sZW5ndGh9IE1vbmF0c3dlcnRlIGF1cyBkZW0gQmFja3VwIMO8YmVybmVobWVuPyBEZXIgYWt0dWVsbGUgU3RhbmQgd2lyZCB2b3JoZXIgbG9rYWwgZ2VzaWNoZXJ0LmApKXJldHVybjsKICAgICAgY29uc3QgaW1wb3J0U3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgICBzYXZlUmVjb3JkcyhjbGVhbmVkLm1hcChyPT4oey4uLnIsdXBkYXRlZEF0OmltcG9ydFN0YW1wfSkpLHtyZWFzb246IkJhY2t1cCBpbXBvcnRpZXJ0IixhbGxvd0VtcHR5OnRydWV9KTsKICAgICAgaWYocGF5bG9hZC5zZXR0aW5ncyYmdHlwZW9mIHBheWxvYWQuc2V0dGluZ3M9PT0ib2JqZWN0Iil7CiAgICAgICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLnBheWxvYWQuc2V0dGluZ3N9OwogICAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5wcmljZSkpJiYhTnVtYmVyLmlzRmluaXRlKE51bWJlcihwYXlsb2FkLnNldHRpbmdzLmZhbGxiYWNrUHJpY2UpKSlzZXR0aW5ncy5mYWxsYmFja1ByaWNlPU51bWJlcihwYXlsb2FkLnNldHRpbmdzLnByaWNlKTsKICAgICAgICBzYXZlU2V0dGluZ3MoKTsKICAgICAgfQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQudmFpbGxhbnRNb250aHMpKXsgdmFpbGxhbnRNb250aHM9cGF5bG9hZC52YWlsbGFudE1vbnRocy5tYXAodj0+KHsuLi52LHVwZGF0ZWRBdDppbXBvcnRTdGFtcH0pKTsgc2F2ZVZhaWxsYW50TW9udGhzKCk7IH0KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLm1ldGVyUmVhZGluZ3MpKXtzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3MpO31lbHNle21ldGVyUmVhZGluZ3M9bG9hZE1ldGVyUmVhZGluZ3MoKTtlbnN1cmVNZXRlckJhc2VsaW5lKCk7fQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQub3N0cm9tUHJpY2VTdGF0cykpc2F2ZU9zdHJvbVByaWNlU3RhdHMocGF5bG9hZC5vc3Ryb21QcmljZVN0YXRzKTsKICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLmNsaW1hdGVNb250aHMpKXNhdmVDbGltYXRlTW9udGhzKHBheWxvYWQuY2xpbWF0ZU1vbnRocyk7CiAgICAgIGlmKHBheWxvYWQuY2xpbWF0ZVdlYXRoZXImJnR5cGVvZiBwYXlsb2FkLmNsaW1hdGVXZWF0aGVyPT09Im9iamVjdCImJiFBcnJheS5pc0FycmF5KHBheWxvYWQuY2xpbWF0ZVdlYXRoZXIpKXtjbGltYXRlV2VhdGhlcj1jbGltYXRlV2VhdGhlck9iamVjdChwYXlsb2FkLmNsaW1hdGVXZWF0aGVyKTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShDTElNQVRFX1dFQVRIRVJfS0VZLEpTT04uc3RyaW5naWZ5KGNsaW1hdGVXZWF0aGVyKSk7fQogICAgICByZW5kZXJBbGwoKTsgdG9hc3QoIkJhY2t1cCBpbXBvcnRpZXJ0Iik7CiAgICB9Y2F0Y2goZXJyb3IpeyBhbGVydChgQmFja3VwIGtvbm50ZSBuaWNodCBpbXBvcnRpZXJ0IHdlcmRlbjogJHtlcnJvci5tZXNzYWdlfWApOyB9CiAgICBmaW5hbGx5eyAkKCJpbXBvcnRCYWNrdXBJbnB1dCIpLnZhbHVlPSIiOyB9CiAgfQoKCiAgLyogRWxkZWhvZiA2LjAuMSDigJMgc2NobGFua2VyIGxva2FsZXIgbXlWQUlMTEFOVC1DU1YtSW1wb3J0ICovCiAgZnVuY3Rpb24gdmFpbGxhbnRDc3ZOdW1iZXIodmFsdWUpewogICAgY29uc3QgdGV4dD1TdHJpbmcodmFsdWU/PyIiKS50cmltKCk7CiAgICBpZighdGV4dClyZXR1cm4gbnVsbDsKICAgIGNvbnN0IG5vcm1hbGl6ZWQ9dGV4dC5pbmNsdWRlcygiLCIpJiZ0ZXh0LmluY2x1ZGVzKCIuIikKICAgICAgP3RleHQubGFzdEluZGV4T2YoIiwiKT50ZXh0Lmxhc3RJbmRleE9mKCIuIikKICAgICAgICA/dGV4dC5yZXBsYWNlKC9cLi9nLCIiKS5yZXBsYWNlKCIsIiwiLiIpCiAgICAgICAgOnRleHQucmVwbGFjZSgvLC9nLCIiKQogICAgICA6dGV4dC5yZXBsYWNlKCIsIiwiLiIpOwogICAgY29uc3QgbnVtYmVyPU51bWJlcihub3JtYWxpemVkKTsKICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobnVtYmVyKT9udW1iZXI6bnVsbDsKICB9CiAgZnVuY3Rpb24gdmFpbGxhbnRDc3ZEYXRlUGFydHModmFsdWUpewogICAgY29uc3QgbWF0Y2g9L14oXGR7NH0pLShcZHsyfSktKFxkezJ9KSg/OlsgVF0oXGR7Mn0pOihcZHsyfSk6KFxkezJ9KSk/JC8uZXhlYyhTdHJpbmcodmFsdWV8fCIiKS50cmltKCkpOwogICAgaWYoIW1hdGNoKXJldHVybiBudWxsOwogICAgY29uc3QgeWVhcj1OdW1iZXIobWF0Y2hbMV0pLG1vbnRoPU51bWJlcihtYXRjaFsyXSksZGF5PU51bWJlcihtYXRjaFszXSk7CiAgICBjb25zdCBkYXRlPW5ldyBEYXRlKERhdGUuVVRDKHllYXIsbW9udGgtMSxkYXkpKTsKICAgIGlmKGRhdGUuZ2V0VVRDRnVsbFllYXIoKSE9PXllYXJ8fGRhdGUuZ2V0VVRDTW9udGgoKSE9PW1vbnRoLTF8fGRhdGUuZ2V0VVRDRGF0ZSgpIT09ZGF5KXJldHVybiBudWxsOwogICAgcmV0dXJuIHt5ZWFyLG1vbnRoLGRheSxkYXRlS2V5OmAke21hdGNoWzFdfS0ke21hdGNoWzJdfS0ke21hdGNoWzNdfWAsbW9udGhLZXk6YCR7bWF0Y2hbMV19LSR7bWF0Y2hbMl19YCxkYXRlVGltZTpTdHJpbmcodmFsdWV8fCIiKS50cmltKCl9OwogIH0KICBmdW5jdGlvbiBkZXRlY3RWYWlsbGFudENzdlR5cGUoaGVhZGVycyl7CiAgICBjb25zdCBmaWVsZHM9bmV3IFNldChoZWFkZXJzKSxoYXM9bmFtZT0+ZmllbGRzLmhhcyhuYW1lKTsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikmJmhhcygiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikmJmhhcygiSGVhdEdlbmVyYXRlZDpEb21lc3RpY0hvdFdhdGVyIikpcmV0dXJuICJhcm90aGVybS1lbmVyZ3kiOwogICAgaWYoaGFzKCJEYXRlVGltZSIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikmJmhhcygiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikmJiFoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikpcmV0dXJuICJ1bml0b3dlci1lbmVyZ3kiOwogICAgaWYoaGFzKCJEYXRlVGltZSIpJiZoYXMoIk91dGRvb3JUZW1wZXJhdHVyZSIpKXJldHVybiAic3lzdGVtLXRlbXBlcmF0dXJlIjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDdXJyZW50Um9vbVRlbXBlcmF0dXJlIikpcmV0dXJuICJ6b25lLXRlbXBlcmF0dXJlIjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJEaHdUYW5rVGVtcGVyYXR1cmUiKSlyZXR1cm4gImRody10ZW1wZXJhdHVyZSI7CiAgICBpZihoYXMoIm1vbnRoIikmJmhhcygiZWxlY3RyaWNpdHlLV2giKSYmaGFzKCJoZWF0aW5nSGVhdEtXaCIpKXJldHVybiAibW9udGhseS1lbmVyZ3kiOwogICAgcmV0dXJuICJ1bmtub3duIjsKICB9CiAgZnVuY3Rpb24gcGFyc2VWYWlsbGFudENzdlRleHQodGV4dCxpbmRleD0wKXsKICAgIGNvbnN0IG5vcm1hbGl6ZWQ9U3RyaW5nKHRleHR8fCIiKS5yZXBsYWNlKC9eXHVGRUZGLywiIikucmVwbGFjZSgvXHJcbj8vZywiXG4iKTsKICAgIGNvbnN0IGV4cG9ydGVkQXQ9KG5vcm1hbGl6ZWQubWF0Y2goL2V4cG9ydGVkIGF0XHMrKFxkezR9LVxkezJ9LVxkezJ9KVxzK1xkezJ9OlxkezJ9L2kpfHxbXSlbMV18fG51bGw7CiAgICBjb25zdCBkYXRhTGluZXM9bm9ybWFsaXplZC5zcGxpdCgiXG4iKS5maWx0ZXIobGluZT0+e2NvbnN0IHQ9bGluZS50cmltKCk7cmV0dXJuIHQmJiF0LnN0YXJ0c1dpdGgoIiMiKTt9KTsKICAgIGlmKCFkYXRhTGluZXMubGVuZ3RoKXJldHVybiB7aW5kZXgsdHlwZToidW5rbm93biIscm93czpbXSxpbnZhbGlkUm93czowfTsKICAgIGNvbnN0IGRlbGltaXRlcj1kYXRhTGluZXNbMF0uaW5jbHVkZXMoIjsiKT8iOyI6IiwiOwogICAgY29uc3QgaGVhZGVycz1kYXRhTGluZXNbMF0uc3BsaXQoZGVsaW1pdGVyKS5tYXAodj0+di50cmltKCkpOwogICAgY29uc3QgdHlwZT1kZXRlY3RWYWlsbGFudENzdlR5cGUoaGVhZGVycykscm93cz1bXTtsZXQgaW52YWxpZFJvd3M9MDsKICAgIGlmKHR5cGU9PT0ibW9udGhseS1lbmVyZ3kiKXsKICAgICAgZm9yKGNvbnN0IGxpbmUgb2YgZGF0YUxpbmVzLnNsaWNlKDEpKXsKICAgICAgICBjb25zdCBwYXJ0cz1saW5lLnNwbGl0KGRlbGltaXRlcikscmF3PU9iamVjdC5mcm9tRW50cmllcyhoZWFkZXJzLm1hcCgoaCxpKT0+W2gscGFydHNbaV0/PyIiXSkpLG1vbnRoPVN0cmluZyhyYXcubW9udGh8fCIiKS50cmltKCk7CiAgICAgICAgaWYoIS9eXGR7NH0tKDBbMS05XXwxWzAtMl0pJC8udGVzdChtb250aCkpe2ludmFsaWRSb3dzKys7Y29udGludWU7fQogICAgICAgIGNvbnN0IHZhbHVlcz17fTsKICAgICAgICBmb3IoY29uc3QgaCBvZiBoZWFkZXJzKXsKICAgICAgICAgIGlmKGg9PT0ibW9udGgiKWNvbnRpbnVlOwogICAgICAgICAgdmFsdWVzW2hdPVsiY29tcGxldGUiLCJlc3RpbWF0ZWQiXS5pbmNsdWRlcyhoKT9TdHJpbmcocmF3W2hdKS50cmltKCkudG9Mb3dlckNhc2UoKT09PSJ0cnVlIjp2YWlsbGFudENzdk51bWJlcihyYXdbaF0pOwogICAgICAgIH0KICAgICAgICByb3dzLnB1c2goe21vbnRoS2V5Om1vbnRoLHZhbHVlc30pOwogICAgICB9CiAgICAgIHJldHVybiB7aW5kZXgsdHlwZSxoZWFkZXJzLHJvd3MsaW52YWxpZFJvd3MsZXhwb3J0ZWRBdH07CiAgICB9CiAgICBmb3IoY29uc3QgbGluZSBvZiBkYXRhTGluZXMuc2xpY2UoMSkpewogICAgICBpZighbGluZS50cmltKCkpY29udGludWU7CiAgICAgIGNvbnN0IHZhbHVlcz1saW5lLnNwbGl0KGRlbGltaXRlcik7CiAgICAgIGNvbnN0IHJhdz1PYmplY3QuZnJvbUVudHJpZXMoaGVhZGVycy5tYXAoKGhlYWRlcixjb2x1bW4pPT5baGVhZGVyLHZhbHVlc1tjb2x1bW5dPz8iIl0pKTsKICAgICAgY29uc3QgZGF0ZT12YWlsbGFudENzdkRhdGVQYXJ0cyhyYXcuRGF0ZVRpbWUpO2lmKCFkYXRlKXtpbnZhbGlkUm93cysrO2NvbnRpbnVlO30KICAgICAgY29uc3QgcGFyc2VkPXsuLi5kYXRlLHZhbHVlczp7fX07CiAgICAgIGZvcihjb25zdCBoZWFkZXIgb2YgaGVhZGVycyl7aWYoaGVhZGVyIT09IkRhdGVUaW1lIilwYXJzZWQudmFsdWVzW2hlYWRlcl09dmFpbGxhbnRDc3ZOdW1iZXIocmF3W2hlYWRlcl0pO30KICAgICAgcm93cy5wdXNoKHBhcnNlZCk7CiAgICB9CiAgICByZXR1cm4ge2luZGV4LHR5cGUsaGVhZGVycyxyb3dzLGludmFsaWRSb3dzLGV4cG9ydGVkQXR9OwogIH0KICBmdW5jdGlvbiBzYW1lVmFpbGxhbnRWYWx1ZShhLGIsdG9sZXJhbmNlPS4wNSl7CiAgICBpZihhPT1udWxsfHxiPT1udWxsKXJldHVybiBhPT1udWxsJiZiPT1udWxsOwogICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoYSkpJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGIpKT9NYXRoLmFicyhOdW1iZXIoYSktTnVtYmVyKGIpKTw9dG9sZXJhbmNlOlN0cmluZyhhKT09PVN0cmluZyhiKTsKICB9CiAgZnVuY3Rpb24gYnVpbGRWYWlsbGFudEltcG9ydFByZXZpZXcocGFyc2VkRmlsZXMpewogICAgY29uc3QgZW5lcmd5VHlwZXM9WyJhcm90aGVybS1lbmVyZ3kiLCJ1bml0b3dlci1lbmVyZ3kiXTsKICAgIGNvbnN0IGRhaWx5PXsiYXJvdGhlcm0tZW5lcmd5IjpuZXcgTWFwKCksInVuaXRvd2VyLWVuZXJneSI6bmV3IE1hcCgpfTsKICAgIGNvbnN0IGNvbmZsaWN0TW9udGhzPW5ldyBTZXQoKTtsZXQgZHVwbGljYXRlUm93cz0wOwogICAgZm9yKGNvbnN0IGZpbGUgb2YgcGFyc2VkRmlsZXMuZmlsdGVyKGY9PmVuZXJneVR5cGVzLmluY2x1ZGVzKGYudHlwZSkpKXsKICAgICAgY29uc3QgdGFyZ2V0PWRhaWx5W2ZpbGUudHlwZV07CiAgICAgIGZvcihjb25zdCByb3cgb2YgZmlsZS5yb3dzKXsKICAgICAgICBjb25zdCBleGlzdGluZz10YXJnZXQuZ2V0KHJvdy5kYXRlS2V5KTsKICAgICAgICBpZighZXhpc3Rpbmcpe3RhcmdldC5zZXQocm93LmRhdGVLZXkscm93KTtjb250aW51ZTt9CiAgICAgICAgY29uc3QgbWV0cmljcz1uZXcgU2V0KFsuLi5PYmplY3Qua2V5cyhleGlzdGluZy52YWx1ZXN8fHt9KSwuLi5PYmplY3Qua2V5cyhyb3cudmFsdWVzfHx7fSldKTsKICAgICAgICBjb25zdCBkaWZmZXJzPVsuLi5tZXRyaWNzXS5zb21lKG1ldHJpYz0+IXNhbWVWYWlsbGFudFZhbHVlKGV4aXN0aW5nLnZhbHVlcz8uW21ldHJpY10scm93LnZhbHVlcz8uW21ldHJpY10pKTsKICAgICAgICBpZihkaWZmZXJzKWNvbmZsaWN0TW9udGhzLmFkZChyb3cubW9udGhLZXkpO2Vsc2UgZHVwbGljYXRlUm93cysrOwogICAgICB9CiAgICB9CiAgICBjb25zdCBhbGxEYXRlcz1bLi4ubmV3IFNldChbLi4uZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLmtleXMoKSwuLi5kYWlseVsidW5pdG93ZXItZW5lcmd5Il0ua2V5cygpXSldOwogICAgY29uc3QgbW9udGhLZXlzPVsuLi5uZXcgU2V0KGFsbERhdGVzLm1hcChkPT5kLnNsaWNlKDAsNykpKV0uc29ydCgpOwogICAgY29uc3Qgc3VtPShtYXAsZGF0ZXMsbWV0cmljKT0+ZGF0ZXMucmVkdWNlKChzLGtleSk9Pntjb25zdCB2PW1hcC5nZXQoa2V5KT8udmFsdWVzPy5bbWV0cmljXTtyZXR1cm4gcysoTnVtYmVyLmlzRmluaXRlKHYpP3Y6MCk7fSwwKTsKICAgIGNvbnN0IGZ1bGw9KGRhdGVzLHksbSk9Pntjb25zdCBleHBlY3RlZD1uZXcgRGF0ZSh5LG0sMCkuZ2V0RGF0ZSgpLHU9Wy4uLm5ldyBTZXQoZGF0ZXMpXS5zb3J0KCk7cmV0dXJuIHUubGVuZ3RoPT09ZXhwZWN0ZWQmJnVbMF09PT1gJHt5fS0ke1N0cmluZyhtKS5wYWRTdGFydCgyLCIwIil9LTAxYCYmdS5hdCgtMSk9PT1gJHt5fS0ke1N0cmluZyhtKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKGV4cGVjdGVkKS5wYWRTdGFydCgyLCIwIil9YDt9OwogICAgY29uc3QgY3VycmVudD1jdXJyZW50TW9udGhLZXkoKTsKICAgIGNvbnN0IG1vbnRocz1tb250aEtleXMubWFwKG1vbnRoPT57CiAgICAgIGNvbnN0IHk9TnVtYmVyKG1vbnRoLnNsaWNlKDAsNCkpLG09TnVtYmVyKG1vbnRoLnNsaWNlKDUsNykpOwogICAgICBjb25zdCBhcm89Wy4uLmRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXS5rZXlzKCldLmZpbHRlcihrPT5rLnN0YXJ0c1dpdGgoYCR7bW9udGh9LWApKS5zb3J0KCk7CiAgICAgIGNvbnN0IHVuaT1bLi4uZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLmtleXMoKV0uZmlsdGVyKGs9Pmsuc3RhcnRzV2l0aChgJHttb250aH0tYCkpLnNvcnQoKTsKICAgICAgY29uc3QgdW5pb249Wy4uLm5ldyBTZXQoWy4uLmFybywuLi51bmldKV0uc29ydCgpOwogICAgICBjb25zdCBleHBvcnRlZFBhcnRpYWw9cGFyc2VkRmlsZXMuc29tZShmPT5bImFyb3RoZXJtLWVuZXJneSIsInVuaXRvd2VyLWVuZXJneSJdLmluY2x1ZGVzKGYudHlwZSkmJmYuZXhwb3J0ZWRBdD8uc2xpY2UoMCw3KT09PW1vbnRoKTsKICAgICAgIGNvbnN0IGNvbXBsZXRlPWZ1bGwoYXJvLHksbSkmJmZ1bGwodW5pLHksbSkmJiFleHBvcnRlZFBhcnRpYWwmJm1vbnRoIT09Y3VycmVudDsKICAgICAgY29uc3QgaGVhdGluZ0VsZWN0cmljaXR5PShzdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKStzdW0oZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLHVuaSwiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKSkvMTAwMDsKICAgICAgY29uc3QgZGh3RWxlY3RyaWNpdHk9c3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikvMTAwMDsKICAgICAgY29uc3QgaGVhdGluZ0hlYXQ9KHN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJIZWF0R2VuZXJhdGVkOkhlYXRpbmciKStzdW0oZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLHVuaSwiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikpLzEwMDA7CiAgICAgIGNvbnN0IGRod0hlYXQ9c3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkhlYXRHZW5lcmF0ZWQ6RG9tZXN0aWNIb3RXYXRlciIpLzEwMDA7CiAgICAgIGNvbnN0IGVsZWN0cmljaXR5S1doPWhlYXRpbmdFbGVjdHJpY2l0eStkaHdFbGVjdHJpY2l0eSxoZWF0R2VuZXJhdGVkS1doPWhlYXRpbmdIZWF0K2Rod0hlYXQ7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgICAgY29uc3QgbmVnYXRpdmVSZXN0PUJvb2xlYW4oZXhpc3RpbmcmJk51bWJlci5pc0Zpbml0ZShleGlzdGluZy50b3RhbCkmJk51bWJlci5pc0Zpbml0ZShleGlzdGluZy5hbm5leCkmJmV4aXN0aW5nLnRvdGFsLWVsZWN0cmljaXR5S1doLWV4aXN0aW5nLmFubmV4PC0uMDEpOwogICAgICBjb25zdCBoYXNDb25mbGljdD1jb25mbGljdE1vbnRocy5oYXMobW9udGgpLGhhc0JvdGg9YXJvLmxlbmd0aD4wJiZ1bmkubGVuZ3RoPjAsaXNDdXJyZW50PW1vbnRoPT09Y3VycmVudCxpc0Z1dHVyZT1tb250aD5jdXJyZW50OwogICAgICBjb25zdCBibG9ja2VkPSFoYXNCb3RofHxoYXNDb25mbGljdHx8bmVnYXRpdmVSZXN0fHxpc0Z1dHVyZXx8KCFjb21wbGV0ZSYmIWlzQ3VycmVudCk7CiAgICAgIHJldHVybiB7bW9udGgsZWxlY3RyaWNpdHlLV2gsaGVhdEdlbmVyYXRlZEtXaCxoZWF0aW5nRWxlY3RyaWNpdHlLV2g6aGVhdGluZ0VsZWN0cmljaXR5LGRod0VsZWN0cmljaXR5S1doOmRod0VsZWN0cmljaXR5LGhlYXRpbmdIZWF0S1doOmhlYXRpbmdIZWF0LGRod0hlYXRLV2g6ZGh3SGVhdCxjb21wbGV0ZSxjb3ZlcmFnZVN0YXJ0OnVuaW9uWzBdfHxudWxsLGNvdmVyYWdlRW5kOnVuaW9uLmF0KC0xKXx8bnVsbCxibG9ja2VkLGhhc0JvdGgsaGFzQ29uZmxpY3QsbmVnYXRpdmVSZXN0LGlzQ3VycmVudH07CiAgICB9KTsKICAgIHJldHVybiB7bW9udGhzLGR1cGxpY2F0ZVJvd3MscmVjb2duaXplZDpwYXJzZWRGaWxlcy5maWx0ZXIoZj0+Zi50eXBlIT09InVua25vd24iKS5sZW5ndGgsdW5rbm93bjpwYXJzZWRGaWxlcy5maWx0ZXIoZj0+Zi50eXBlPT09InVua25vd24iKS5sZW5ndGgsaW52YWxpZFJvd3M6cGFyc2VkRmlsZXMucmVkdWNlKChzLGYpPT5zK2YuaW52YWxpZFJvd3MsMCl9OwogIH0KICBmdW5jdGlvbiBtZXJnZVZhaWxsYW50SW1wb3J0KG1vbnRocyl7CiAgICBjb25zdCByZWNvcmRNYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICBjb25zdCB2YWlsbGFudE1hcD1uZXcgTWFwKCh2YWlsbGFudE1vbnRoc3x8W10pLm1hcCh2PT5bdi5tb250aCx7Li4udn1dKSk7CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7bGV0IGltcG9ydGVkPTAsY3JlYXRlZD0wLHBhcnRpYWw9MDsKICAgIGZvcihjb25zdCBtb250aCBvZiBtb250aHMuZmlsdGVyKG09PiFtLmJsb2NrZWQpKXsKICAgICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkTWFwLmdldChtb250aC5tb250aCl8fHNhbml0aXplUmVjb3JkKHttb250aDptb250aC5tb250aH0pOwogICAgICBjb25zdCB3YXNOZXc9IXJlY29yZE1hcC5oYXMobW9udGgubW9udGgpOwogICAgICBleGlzdGluZy5oZWF0UHVtcD1tb250aC5lbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuaGVhdEdlbmVyYXRlZD1tb250aC5oZWF0R2VuZXJhdGVkS1doOwogICAgICBleGlzdGluZy5oZWF0aW5nRWxlY3RyaWNpdHk9bW9udGguaGVhdGluZ0VsZWN0cmljaXR5S1doOwogICAgICBleGlzdGluZy5kaHdFbGVjdHJpY2l0eT1tb250aC5kaHdFbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuaGVhdGluZ0hlYXQ9bW9udGguaGVhdGluZ0hlYXRLV2g7CiAgICAgIGV4aXN0aW5nLmRod0hlYXQ9bW9udGguZGh3SGVhdEtXaDsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXBTb3VyY2U9bW9udGguY29tcGxldGU/Im15dmFpbGxhbnQtY3N2LWltcG9ydCI6Im15dmFpbGxhbnQtY3N2LWltcG9ydC1wYXJ0aWFsIjsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXBVcGRhdGVkQXQ9c3RhbXA7CiAgICAgIGV4aXN0aW5nLnVwZGF0ZWRBdD1zdGFtcDsKICAgICAgaWYoIW1vbnRoLmNvbXBsZXRlKXsKICAgICAgICBwYXJ0aWFsKys7CiAgICAgICAgY29uc3Qgbm90ZT1gbXlWQUlMTEFOVCBDU1YtVGVpbG1vbmF0ICR7bW9udGguY292ZXJhZ2VTdGFydH0gYmlzICR7bW9udGguY292ZXJhZ2VFbmR9YDsKICAgICAgICBpZighU3RyaW5nKGV4aXN0aW5nLm5vdGV8fCIiKS5pbmNsdWRlcyhub3RlKSlleGlzdGluZy5ub3RlPWV4aXN0aW5nLm5vdGU/YCR7ZXhpc3Rpbmcubm90ZX0g4oCiICR7bm90ZX1gOm5vdGU7CiAgICAgICAgZXhpc3RpbmcuY2xvc2VkPWZhbHNlO2V4aXN0aW5nLmNsb3NlZEF0PW51bGw7CiAgICAgIH0KICAgICAgcmVjb3JkTWFwLnNldChtb250aC5tb250aCxleGlzdGluZyk7CiAgICAgIHZhaWxsYW50TWFwLnNldChtb250aC5tb250aCx7bW9udGg6bW9udGgubW9udGgsZWxlY3RyaWNpdHlLV2g6bW9udGguZWxlY3RyaWNpdHlLV2gsaGVhdEdlbmVyYXRlZEtXaDptb250aC5oZWF0R2VuZXJhdGVkS1doLGhlYXRpbmdFbGVjdHJpY2l0eUtXaDptb250aC5oZWF0aW5nRWxlY3RyaWNpdHlLV2gsZGh3RWxlY3RyaWNpdHlLV2g6bW9udGguZGh3RWxlY3RyaWNpdHlLV2gsaGVhdGluZ0hlYXRLV2g6bW9udGguaGVhdGluZ0hlYXRLV2gsZGh3SGVhdEtXaDptb250aC5kaHdIZWF0S1doLHNvdXJjZTpleGlzdGluZy5oZWF0UHVtcFNvdXJjZSxlc3RpbWF0ZWQ6IW1vbnRoLmNvbXBsZXRlLHVwZGF0ZWRBdDpzdGFtcH0pOwogICAgICBpbXBvcnRlZCsrO2lmKHdhc05ldyljcmVhdGVkKys7CiAgICB9CiAgICBzYXZlUmVjb3JkcyhbLi4ucmVjb3JkTWFwLnZhbHVlcygpXSx7cmVhc29uOiJteVZBSUxMQU5UIENTViBpbXBvcnRpZXJ0In0pOwogICAgdmFpbGxhbnRNb250aHM9Wy4uLnZhaWxsYW50TWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpO3NhdmVWYWlsbGFudE1vbnRocygpOwogICAgcmV0dXJuIHtpbXBvcnRlZCxjcmVhdGVkLHBhcnRpYWx9OwogIH0KICBhc3luYyBmdW5jdGlvbiBpbXBvcnRWYWlsbGFudENzdkZpbGVzKGZpbGVMaXN0KXsKICAgIGNvbnN0IGZpbGVzPVsuLi4oZmlsZUxpc3R8fFtdKV07aWYoIWZpbGVzLmxlbmd0aClyZXR1cm47CiAgICBzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIiwiRGF0ZWllbiB3ZXJkZW4gbG9rYWwgZ2VwcsO8ZnQg4oCmIik7CiAgICB0cnl7CiAgICAgIGNvbnN0IHBhcnNlZD1bXTtmb3IobGV0IGk9MDtpPGZpbGVzLmxlbmd0aDtpKyspcGFyc2VkLnB1c2gocGFyc2VWYWlsbGFudENzdlRleHQoYXdhaXQgZmlsZXNbaV0udGV4dCgpLGkpKTsKICAgICAgY29uc3QgaGFzQXJvPXBhcnNlZC5zb21lKHg9PngudHlwZT09PSJhcm90aGVybS1lbmVyZ3kiKSxoYXNVbmk9cGFyc2VkLnNvbWUoeD0+eC50eXBlPT09InVuaXRvd2VyLWVuZXJneSIpOwogICAgICBpZihoYXNBcm8hPT1oYXNVbmkpdGhyb3cgRXJyb3IoIlTDpGdsaWNoZSBFbmVyZ2lld2VydGUgbnVyIG1pdCBhcm9USEVSTSB1bmQgdW5pVE9XRVIgZ2VtZWluc2FtIGltcG9ydGllcmVuLiIpOwogICAgICBjb25zdCBkYWlseT1oYXNBcm8mJmhhc1VuaT9idWlsZFZhaWxsYW50SW1wb3J0UHJldmlldyhwYXJzZWQpOnttb250aHM6W119OwogICAgICBjb25zdCBtYXA9bmV3IE1hcChtb250aGx5VmFpbGxhbnRJbXBvcnRzKHBhcnNlZCkubWFwKHg9Plt4Lm1vbnRoLHhdKSk7CiAgICAgIGZvcihjb25zdCByb3cgb2YgZGFpbHkubW9udGhzLmZpbHRlcih4PT4heC5ibG9ja2VkKSltYXAuc2V0KHJvdy5tb250aCxyb3cpOwogICAgICBjb25zdCBtb250aHM9Wy4uLm1hcC52YWx1ZXMoKV0sdGVtcD1jbGltYXRlUHJldmlldyhwYXJzZWQpOwogICAgICBpZighbW9udGhzLmxlbmd0aCYmIXRlbXAubGVuZ3RoKXRocm93IEVycm9yKCJLZWluZSBpbXBvcnRpZXJiYXJlbiBFbmVyZ2lld2VydGUgb2RlciBUZW1wZXJhdHVyZGF0ZWllbiBlcmthbm50LiIpOwogICAgICBjb25zdCBza2lwcGVkPWRhaWx5Lm1vbnRocy5maWx0ZXIoeD0+eC5ibG9ja2VkKS5sZW5ndGg7CiAgICAgIGlmKCFjb25maXJtKG1vbnRocy5sZW5ndGgrIiBFbmVyZ2llbW9uYXRlIHVuZCAiK3RlbXAubGVuZ3RoKyIgVGVtcGVyYXR1cm1vbmF0ZSDDvGJlcm5laG1lbj8gIisoc2tpcHBlZD9za2lwcGVkKyIgRW5lcmdpZS1Nb25hdGUgd2VyZGVuIHdlZ2VuIHVudm9sbHN0w6RuZGlnZXIgb2RlciB3aWRlcnNwcsO8Y2hsaWNoZXIgRGF0ZW4gw7xiZXJzcHJ1bmdlbi4gIjoiIikrIlrDpGhsZXJzdMOkbmRlLCBPc3Ryb20tUHJlaXNlIHVuZCBOb3RpemVuIGJsZWliZW4gdW52ZXLDpG5kZXJ0LiIpKXJldHVybjsKICAgICAgaWYobW9udGhzLmxlbmd0aCltZXJnZVZhaWxsYW50SW1wb3J0KG1vbnRocyk7CiAgICAgIGlmKHRlbXAubGVuZ3RoKWNsaW1hdGVJbXBvcnQodGVtcCk7CiAgICAgIHJlbmRlckFsbCgpOwogICAgICBzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIixtb250aHMubGVuZ3RoKyIgRW5lcmdpZS1Nb25hdGUgdW5kICIrdGVtcC5sZW5ndGgrIiBUZW1wZXJhdHVyLU1vbmF0ZSBpbXBvcnRpZXJ0Iiwib2siKTsKICAgICAgdG9hc3QoIlZhaWxsYW50LURhdGVuIGltcG9ydGllcnQiKTsKICAgIH1jYXRjaChlcnJvcil7c2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsZXJyb3IubWVzc2FnZSwiZXJyb3IiKTt9CiAgICBmaW5hbGx5eyQoInZhaWxsYW50Q3N2RmlsZXNJbnB1dCIpLnZhbHVlPSIiO30KICB9CgogIGFzeW5jIGZ1bmN0aW9uIG9zdHJvbUZldGNoKHBhdGgpewogICAgaWYoIXNldHRpbmdzLm9zdHJvbUFwcEtleSl0aHJvdyBuZXcgRXJyb3IoIkFwcC1TY2hsw7xzc2VsIGZlaGx0LiIpOwogICAgY29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2gocGF0aCx7aGVhZGVyczp7IngtZWxkZWhvZi1rZXkiOnNldHRpbmdzLm9zdHJvbUFwcEtleSwiYWNjZXB0IjoiYXBwbGljYXRpb24vanNvbiJ9LGNhY2hlOiJuby1zdG9yZSJ9KTsgY29uc3QgdGV4dD1hd2FpdCByZXNwb25zZS50ZXh0KCk7IGxldCBwYXlsb2FkPXt9OyB0cnl7cGF5bG9hZD10ZXh0P0pTT04ucGFyc2UodGV4dCk6e307fWNhdGNoe30KICAgIGlmKCFyZXNwb25zZS5vayl0aHJvdyBuZXcgRXJyb3IocGF5bG9hZC5lcnJvcnx8cGF5bG9hZC5tZXNzYWdlfHx0ZXh0fHxgRmVobGVyICR7cmVzcG9uc2Uuc3RhdHVzfWApOyByZXR1cm4gcGF5bG9hZDsKICB9CiAgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE9zdHJvbShzaG93VG9hc3Q9ZmFsc2UpewogICAgaWYob3N0cm9tQnVzeXx8IXNldHRpbmdzLm9zdHJvbUFwcEtleSl7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7cmV0dXJuIGZhbHNlO30KICAgIG9zdHJvbUJ1c3k9dHJ1ZTtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTsKICAgIHRyeXsgY29uc3QgcGF5bG9hZD1hd2FpdCBvc3Ryb21GZXRjaChgL2FwaS9saXZlJHtzaG93VG9hc3Q/Ij9yZWZyZXNoPTEiOiIifWApOyBzYXZlT3N0cm9tQ2FjaGUocGF5bG9hZCk7IGlmKHNob3dUb2FzdCl0b2FzdCgiT3N0cm9tIGFrdHVhbGlzaWVydCIpOyByZXR1cm4gdHJ1ZTsgfQogICAgY2F0Y2goZXJyb3IpeyBzZXRPc3Ryb21TdGF0dXMoYEZlaGxlcjogJHtlcnJvci5tZXNzYWdlfWAsImVycm9yIik7IGlmKHNob3dUb2FzdCl0b2FzdChgT3N0cm9tOiAke2Vycm9yLm1lc3NhZ2V9YCk7IHJldHVybiBmYWxzZTsgfQogICAgZmluYWxseXtvc3Ryb21CdXN5PWZhbHNlO3JlbmRlck9zdHJvbURhc2hib2FyZCgpO30KICB9CiAgZnVuY3Rpb24gc2NoZWR1bGVPc3Ryb20oKXsgY2xlYXJJbnRlcnZhbChvc3Ryb21UaW1lcik7b3N0cm9tVGltZXI9bnVsbDsgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5JiZzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlKW9zdHJvbVRpbWVyPXNldEludGVydmFsKCgpPT5yZWZyZXNoT3N0cm9tKGZhbHNlKSwxMCo2MCoxMDAwKTsgfQogIGZ1bmN0aW9uIHNldE9zdHJvbVN0YXR1cyh0ZXh0LGtpbmQ9IiIpeyBjb25zdCBlbD0kKCJvc3Ryb21TdGF0dXMiKTtlbC50ZXh0Q29udGVudD10ZXh0O2VsLnN0eWxlLmNvbG9yPWtpbmQ9PT0iZXJyb3IiPyIjZmZhYWE5IjoiIjsgfQogIGZ1bmN0aW9uIGZvcm1hdERhdGVUaW1lKHZhbHVlKXsgY29uc3QgZD1uZXcgRGF0ZSh2YWx1ZSk7IGlmKE51bWJlci5pc05hTihkLnZhbHVlT2YoKSkpcmV0dXJuICLigJMiOyByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7d2Vla2RheToic2hvcnQiLGRheToiMi1kaWdpdCIsbW9udGg6IjItZGlnaXQiLGhvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQoZCk7IH0KICBmdW5jdGlvbiBpbnRlcnZhbFJvd3MoKXsgcmV0dXJuIChBcnJheS5pc0FycmF5KG9zdHJvbUxpdmU/LnByaWNlRm9yZWNhc3QpP29zdHJvbUxpdmUucHJpY2VGb3JlY2FzdDpbXSkubWFwKHA9Pih7dGltZTpuZXcgRGF0ZShwLmRhdGV8fHAuc3RhcnR8fHAudGltZXN0YW1wKS5nZXRUaW1lKCkscHJpY2U6TnVtYmVyKHAudG90YWxDdFBlcktXaD8/cC5wcmljZUN0UGVyS1doPz9wLnByaWNlKX0pKS5maWx0ZXIocD0+TnVtYmVyLmlzRmluaXRlKHAudGltZSkmJk51bWJlci5pc0Zpbml0ZShwLnByaWNlKSkuc29ydCgoYSxiKT0+YS50aW1lLWIudGltZSk7IH0KICBmdW5jdGlvbiBpbmZlclN0ZXAocm93cyl7IGNvbnN0IGRpZmZzPVtdO2ZvcihsZXQgaT0xO2k8cm93cy5sZW5ndGg7aSsrKXtjb25zdCBkPXJvd3NbaV0udGltZS1yb3dzW2ktMV0udGltZTtpZihkPj01KjYwZTMmJmQ8PTIqMzYwMGUzKWRpZmZzLnB1c2goZCk7fSBpZighZGlmZnMubGVuZ3RoKXJldHVybiAzNjAwZTM7ZGlmZnMuc29ydCgoYSxiKT0+YS1iKTtyZXR1cm4gZGlmZnNbTWF0aC5mbG9vcihkaWZmcy5sZW5ndGgvMildOyB9CiAgZnVuY3Rpb24gY29tcHV0ZVByaWNlV2luZG93KHJvd3MsaG91cnMsbW9kZSl7CiAgICBpZighcm93cy5sZW5ndGgpcmV0dXJuIG51bGw7IGNvbnN0IHN0ZXA9aW5mZXJTdGVwKHJvd3MpOyBjb25zdCBjb3VudD1NYXRoLm1heCgxLE1hdGgucm91bmQoaG91cnMqMzYwMGUzL3N0ZXApKTsgY29uc3Qgbm93PURhdGUubm93KCk7IGNvbnN0IHBvb2w9cm93cy5maWx0ZXIocj0+ci50aW1lPj1ub3ctc3RlcCkuc2xpY2UoMCxNYXRoLm1heChjb3VudCxNYXRoLnJvdW5kKDQ4KjM2MDBlMy9zdGVwKSkpOwogICAgbGV0IGJlc3Q9bnVsbDsKICAgIGZvcihsZXQgaT0wO2krY291bnQ8PXBvb2wubGVuZ3RoO2krKyl7Y29uc3Qgc2xpY2U9cG9vbC5zbGljZShpLGkrY291bnQpO2xldCBjb250aWd1b3VzPXRydWU7Zm9yKGxldCBqPTE7ajxzbGljZS5sZW5ndGg7aisrKWlmKHNsaWNlW2pdLnRpbWUtc2xpY2Vbai0xXS50aW1lPnN0ZXAqMS42KXtjb250aWd1b3VzPWZhbHNlO2JyZWFrO31pZighY29udGlndW91cyljb250aW51ZTtjb25zdCBhdmc9c2xpY2UucmVkdWNlKChzLHIpPT5zK3IucHJpY2UsMCkvc2xpY2UubGVuZ3RoO2NvbnN0IGNhbmRpZGF0ZT17c3RhcnQ6c2xpY2VbMF0udGltZSxlbmQ6c2xpY2UuYXQoLTEpLnRpbWUrc3RlcCxhdmd9O2lmKCFiZXN0fHwobW9kZT09PSJtaW4iP2F2ZzxiZXN0LmF2Zzphdmc+YmVzdC5hdmcpKWJlc3Q9Y2FuZGlkYXRlO30KICAgIHJldHVybiBiZXN0OwogIH0KICBmdW5jdGlvbiByZW5kZXJPc3Ryb21EYXNoYm9hcmQoKXsKICAgIGNvbnN0IGNhblJlZnJlc2g9Qm9vbGVhbihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpOwogICAgY29uc3QgaGFzU3luY2VkRGF0YT1Cb29sZWFuKG9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0KTsKICAgIGNvbnN0IHZpc2libGU9Y2FuUmVmcmVzaHx8aGFzU3luY2VkRGF0YTsKICAgICQoIm9zdHJvbVNldHVwSGludCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsdmlzaWJsZSk7CiAgICAkKCJvc3Ryb21EYXNoYm9hcmQiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCF2aXNpYmxlKTsKICAgICQoIm9zdHJvbU1pbmlDaGFydCIpLnBhcmVudEVsZW1lbnQuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhdmlzaWJsZSk7CiAgICAkKCJyZWZyZXNoT3N0cm9tQnRuIikuZGlzYWJsZWQ9IWNhblJlZnJlc2h8fG9zdHJvbUJ1c3k7CiAgICBpZighdmlzaWJsZSl7IHNldE9zdHJvbVN0YXR1cygiTmljaHQgdmVyYnVuZGVuIik7IHJldHVybjsgfQogICAgaWYob3N0cm9tQnVzeSlzZXRPc3Ryb21TdGF0dXMoIkFrdHVhbGlzaWVydW5nIGzDpHVmdCDigKYiKTsKICAgIGVsc2UgaWYoaGFzU3luY2VkRGF0YSYmIWNhblJlZnJlc2gpc2V0T3N0cm9tU3RhdHVzKGBWb20gYW5kZXJlbiBHZXLDpHQgc3luY2hyb25pc2llcnQgwrcgJHtmb3JtYXREYXRlVGltZShvc3Ryb21MaXZlLmdlbmVyYXRlZEF0KX1gKTsKICAgIGVsc2UgaWYoaGFzU3luY2VkRGF0YSlzZXRPc3Ryb21TdGF0dXMoYEFrdHVhbGlzaWVydCAke2Zvcm1hdERhdGVUaW1lKG9zdHJvbUxpdmUuZ2VuZXJhdGVkQXQpfWApOwogICAgZWxzZSBzZXRPc3Ryb21TdGF0dXMoIk5vY2gga2VpbmUgTGl2ZS1EYXRlbiIpOwogICAgY29uc3Qgcm93cz1pbnRlcnZhbFJvd3MoKTsgaWYoIXJvd3MubGVuZ3RoKXsgWyJvc3Ryb21DdXJyZW50UHJpY2UiLCJvc3Ryb21CZXN0UHJpY2UiLCJvc3Ryb21Xb3JzdFByaWNlIl0uZm9yRWFjaChpZD0+JChpZCkudGV4dENvbnRlbnQ9IuKAkyIpOyBbIm9zdHJvbUN1cnJlbnRNZXRhIiwib3N0cm9tQmVzdE1ldGEiLCJvc3Ryb21Xb3JzdE1ldGEiXS5mb3JFYWNoKGlkPT4kKGlkKS50ZXh0Q29udGVudD0iTm9jaCBrZWluZSBQcmVpc3ZvcnNjaGF1Iik7IGRyYXdPc3Ryb21NaW5pKFtdKTsgcmV0dXJuOyB9CiAgICBjb25zdCBub3c9RGF0ZS5ub3coKSxzdGVwPWluZmVyU3RlcChyb3dzKTsgY29uc3QgY3VycmVudD1yb3dzLmZpbmQoKHIsaSk9PnIudGltZTw9bm93JiYocm93c1tpKzFdPy50aW1lPz9yLnRpbWUrc3RlcCk+bm93KXx8cm93cy5maW5kKHI9PnIudGltZT5ub3cpfHxyb3dzLmF0KC0xKTsgY29uc3QgaG91cnM9TnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKXx8MzsgY29uc3QgYmVzdD1jb21wdXRlUHJpY2VXaW5kb3cocm93cyxob3VycywibWluIiksIHdvcnN0PWNvbXB1dGVQcmljZVdpbmRvdyhyb3dzLGhvdXJzLCJtYXgiKTsKICAgICQoIm9zdHJvbUJlc3RMYWJlbCIpLnRleHRDb250ZW50PWBCZXN0ZXMgJHtob3Vyc31oLUZlbnN0ZXJgOyAkKCJvc3Ryb21Xb3JzdExhYmVsIikudGV4dENvbnRlbnQ9YFNjaGxlY2h0ZXN0ZXMgJHtob3Vyc31oLUZlbnN0ZXJgOwogICAgJCgib3N0cm9tQ3VycmVudFByaWNlIikudGV4dENvbnRlbnQ9YCR7bnVtKGN1cnJlbnQ/LnByaWNlLDIpfSBjdC9rV2hgOyAkKCJvc3Ryb21DdXJyZW50TWV0YSIpLnRleHRDb250ZW50PWN1cnJlbnQ/Zm9ybWF0RGF0ZVRpbWUoY3VycmVudC50aW1lKToi4oCTIjsKICAgICQoIm9zdHJvbUJlc3RQcmljZSIpLnRleHRDb250ZW50PWJlc3Q/YCR7bnVtKGJlc3QuYXZnLDIpfSBjdC9rV2hgOiLigJMiOyAkKCJvc3Ryb21CZXN0TWV0YSIpLnRleHRDb250ZW50PWJlc3Q/YCR7Zm9ybWF0RGF0ZVRpbWUoYmVzdC5zdGFydCl9IOKAkyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUoYmVzdC5lbmQpKX1gOiLigJMiOwogICAgJCgib3N0cm9tV29yc3RQcmljZSIpLnRleHRDb250ZW50PXdvcnN0P2Ake251bSh3b3JzdC5hdmcsMil9IGN0L2tXaGA6IuKAkyI7ICQoIm9zdHJvbVdvcnN0TWV0YSIpLnRleHRDb250ZW50PXdvcnN0P2Ake2Zvcm1hdERhdGVUaW1lKHdvcnN0LnN0YXJ0KX0g4oCTICR7bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCIsbWludXRlOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZSh3b3JzdC5lbmQpKX1gOiLigJMiOwogICAgZHJhd09zdHJvbU1pbmkocm93cy5maWx0ZXIocj0+ci50aW1lPj1ub3ctc3RlcCkuc2xpY2UoMCw0OCkpOwogIH0KICBmdW5jdGlvbiBkcmF3T3N0cm9tTWluaShyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgib3N0cm9tTWluaUNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBpZighcm93cy5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LCJLZWluZSBPc3Ryb20tUHJlaXNkYXRlbiIpO3JldHVybjt9IGNvbnN0IG1pbj1NYXRoLm1pbiguLi5yb3dzLm1hcChyPT5yLnByaWNlKSksbWF4PU1hdGgubWF4KC4uLnJvd3MubWFwKHI9PnIucHJpY2UpKSxzcGFuPU1hdGgubWF4KDEsbWF4LW1pbik7IGNvbnN0IHBhZD17bDo0MyxyOjgsdDoxMixiOjMwfSx3PXdpZHRoLXBhZC5sLXBhZC5yLGg9aGVpZ2h0LXBhZC50LXBhZC5iOwogICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkO2N0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7Y3R4LmZvbnQ9IjEwcHggc2Fucy1zZXJpZiI7Zm9yKGxldCBpPTA7aTw9MztpKyspe2NvbnN0IHk9cGFkLnQraCppLzM7Y3R4LmJlZ2luUGF0aCgpO2N0eC5tb3ZlVG8ocGFkLmwseSk7Y3R4LmxpbmVUbyh3aWR0aC1wYWQucix5KTtjdHguc3Ryb2tlKCk7Y3R4LmZpbGxUZXh0KG51bShtYXgtc3BhbippLzMsMCksNCx5KzMpO30gY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy50b3RhbDtjdHgubGluZVdpZHRoPTI7Y3R4LmJlZ2luUGF0aCgpO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9cGFkLmwrKHJvd3MubGVuZ3RoPT09MT93LzI6dyppLyhyb3dzLmxlbmd0aC0xKSkseT1wYWQudCtoKigxLShyLnByaWNlLW1pbikvc3Bhbik7aT9jdHgubGluZVRvKHgseSk6Y3R4Lm1vdmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICAgIGNvbnN0IHN0ZXA9TWF0aC5tYXgoMSxNYXRoLmZsb29yKHJvd3MubGVuZ3RoLzUpKTsgcm93cy5mb3JFYWNoKChyLGkpPT57aWYoaSVzdGVwJiZpIT09cm93cy5sZW5ndGgtMSlyZXR1cm47Y29uc3QgeD1wYWQubCsocm93cy5sZW5ndGg9PT0xP3cvMjp3KmkvKHJvd3MubGVuZ3RoLTEpKTtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5maWxsVGV4dChuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZShyLnRpbWUpKSx4LTgsaGVpZ2h0LTkpO30pOwogIH0KICBhc3luYyBmdW5jdGlvbiBzYXZlQW5kQ2hlY2tPc3Ryb20oKXsKICAgIGNvbnN0IGtleT0kKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlLnRyaW0oKTsgc2V0dGluZ3Mub3N0cm9tQXBwS2V5PWtleTsgc2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2g9JCgib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIpLmNoZWNrZWQ7IHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzPU51bWJlcigkKCJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0IikudmFsdWUpfHwzOyBzYXZlU2V0dGluZ3MoKTsKICAgIGlmKCFrZXkpe3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIkJpdHRlIEFwcC1TY2hsw7xzc2VsIGVpbnRyYWdlbi4iLCJlcnJvciIpO3JlbmRlck9zdHJvbURhc2hib2FyZCgpO3JldHVybjt9CiAgICBzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJWZXJiaW5kdW5nIHdpcmQgZ2VwcsO8ZnQg4oCmIik7CiAgICB0cnl7IGNvbnN0IGhlYWx0aD1hd2FpdCBvc3Ryb21GZXRjaCgiL2FwaS9oZWFsdGg/ZGVlcD10b2tlbiIpOyBpZighaGVhbHRoLmNvbmZpZ3VyZWQpdGhyb3cgbmV3IEVycm9yKCJDbG91ZGZsYXJlLVNlY3JldHMgc2luZCBuaWNodCB2b2xsc3TDpG5kaWcgZWluZ2VyaWNodGV0LiIpOyBzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJPc3Ryb20tVmVyYmluZHVuZyBlcmZvbGdyZWljaC4iLCJvayIpOyBhd2FpdCByZWZyZXNoT3N0cm9tKHRydWUpOyBzY2hlZHVsZU9zdHJvbSgpOyByZW5kZXJBbGwoKTsgfQogICAgY2F0Y2goZXJyb3Ipe3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsZXJyb3IubWVzc2FnZSwiZXJyb3IiKTt9CiAgfQogIGZ1bmN0aW9uIGRpc2Nvbm5lY3RPc3Ryb20oKXsgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5JiYhY29uZmlybSgiT3N0cm9tLVZlcmJpbmR1bmcgd2lya2xpY2ggZW50ZmVybmVuPyIpKXJldHVybjsgc2V0dGluZ3Mub3N0cm9tQXBwS2V5PSIiO3NhdmVTZXR0aW5ncygpO3NhdmVPc3Ryb21DYWNoZShudWxsKTtsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShPU1RST01fQ09OVFJPTF9LRVkpO3NjaGVkdWxlT3N0cm9tKCk7cmVuZGVyQWxsKCk7c2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiVmVyYmluZHVuZyBlbnRmZXJudC4iKTt0b2FzdCgiT3N0cm9tIGdldHJlbm50Iik7IH0KCgogIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hPc3Ryb21IaXN0b3J5KHtzaWxlbnQ9ZmFsc2Usb25seU1pc3Npbmc9ZmFsc2UsbWF4TW9udGhzPUluZmluaXR5fT17fSl7CiAgICBpZihvc3Ryb21IaXN0b3J5QnVzeSlyZXR1cm47CiAgICBpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtpZighc2lsZW50KXRvYXN0KCJPc3Ryb20genVlcnN0IHZlcmJpbmRlbiIpO3JldHVybjt9CiAgICBjb25zdCBlbGlnaWJsZT1zb3J0ZWQoKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpJiZyLm1vbnRoPGN1cnJlbnRNb250aEtleSgpKS5maWx0ZXIocj0+IW9ubHlNaXNzaW5nfHwhci5vc3Ryb21QcmljZUNvbXBsZXRlKTsKICAgIGlmKCFlbGlnaWJsZS5sZW5ndGgpe2lmKCFzaWxlbnQpdG9hc3QoIlByZWlzaGlzdG9yaWUgaXN0IGJlcmVpdHMgdm9sbHN0w6RuZGlnIik7cmV0dXJuO30KICAgIG9zdHJvbUhpc3RvcnlCdXN5PXRydWU7cmVuZGVyRGF0YSgpOwogICAgbGV0IHVwZGF0ZWQ9MCx1bmF2YWlsYWJsZT0wLHByb2Nlc3NlZD0wOwogICAgY29uc3QgbWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgdHJ5ewogICAgICBmb3IoY29uc3QgciBvZiBlbGlnaWJsZS5zbGljZSgtTWF0aC5tYXgoMSxOdW1iZXIobWF4TW9udGhzKXx8ZWxpZ2libGUubGVuZ3RoKSkpewogICAgICAgIHByb2Nlc3NlZCsrOwogICAgICAgIGlmKCFzaWxlbnQpc2V0U3RhdHVzKCJvc3Ryb21IaXN0b3J5U3RhdHVzIixgJHttb250aExhYmVsKHIubW9udGgsZmFsc2UpfSB3aXJkIHZvbiBPc3Ryb20gZ2VsYWRlbiDigKYgKCR7cHJvY2Vzc2VkfS8ke01hdGgubWluKGVsaWdpYmxlLmxlbmd0aCxtYXhNb250aHMpfSlgKTsKICAgICAgICB0cnl7CiAgICAgICAgICBjb25zdCBkYXRhPWF3YWl0IG9zdHJvbUZldGNoKGAvYXBpL21vbnRoP21vbnRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHIubW9udGgpfWApOwogICAgICAgICAgaWYoIWRhdGE/LmNvbXBsZXRlfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSl8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEudG90YWxDb3N0RXVyKSkpe3VuYXZhaWxhYmxlKys7Y29udGludWU7fQogICAgICAgICAgY29uc3QgaXRlbT1tYXAuZ2V0KHIubW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6ci5tb250aH0pOwogICAgICAgICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgICAgICAgaXRlbS5wcmljZUN0PU51bWJlcihkYXRhLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKTsKICAgICAgICAgIGl0ZW0uYmFzZUZlZT1OdW1iZXIoZGF0YS5maXhlZENvc3RFdXIpfHwwOwogICAgICAgICAgaXRlbS5vc3Ryb21WYXJpYWJsZUNvc3RFdXI9TnVtYmVyKGRhdGEudmFyaWFibGVDb3N0RXVyKTsKICAgICAgICAgIGl0ZW0ub3N0cm9tVG90YWxDb3N0RXVyPU51bWJlcihkYXRhLnRvdGFsQ29zdEV1cik7CiAgICAgICAgICBpdGVtLm9zdHJvbUNvbnN1bXB0aW9uS1doPU51bWJlcihkYXRhLnRvdGFsS1doKTsKICAgICAgICAgIGl0ZW0ub3N0cm9tUHJpY2VDb21wbGV0ZT10cnVlOwogICAgICAgICAgaXRlbS5wcmljZVNvdXJjZT0ib3N0cm9tLWhvdXJseS1jb25zdW1wdGlvbi13ZWlnaHRlZCI7CiAgICAgICAgICBpdGVtLnByaWNlVXBkYXRlZEF0PXN0YW1wOwogICAgICAgICAgaXRlbS51cGRhdGVkQXQ9c3RhbXA7CiAgICAgICAgICBtYXAuc2V0KHIubW9udGgsaXRlbSk7dXBzZXJ0T3N0cm9tUHJpY2VTdGF0KHIubW9udGgsZGF0YSx7cGFydGlhbDpmYWxzZX0pO3VwZGF0ZWQrKzsKICAgICAgICB9Y2F0Y2goZXJyb3Ipe3VuYXZhaWxhYmxlKys7fQogICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmU9PnNldFRpbWVvdXQocmVzb2x2ZSwxNDApKTsKICAgICAgfQogICAgICBpZih1cGRhdGVkKXNhdmVSZWNvcmRzKFsuLi5tYXAudmFsdWVzKCldLHtyZWFzb246Ik9zdHJvbS1TdHVuZGVucHJlaXNlIGFrdHVhbGlzaWVydCJ9KTsKICAgICAgY29uc3Qgc3RhdHVzPXt1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHVwZGF0ZWQsdW5hdmFpbGFibGV9O2xvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9ISVNUT1JZX0tFWSxKU09OLnN0cmluZ2lmeShzdGF0dXMpKTsKICAgICAgcmVuZGVyQWxsKCk7CiAgICAgIGlmKCFzaWxlbnQpdG9hc3QoYCR7dXBkYXRlZH0gTW9uYXQoZSkgbWl0IE9zdHJvbS1TdHVuZGVucHJlaXNlbiBha3R1YWxpc2llcnQke3VuYXZhaWxhYmxlP2AgwrcgJHt1bmF2YWlsYWJsZX0gbmljaHQgdmVyZsO8Z2JhcmA6IiJ9YCk7CiAgICB9ZmluYWxseXtvc3Ryb21IaXN0b3J5QnVzeT1mYWxzZTtyZW5kZXJEYXRhKCk7fQogIH0KCiAgZnVuY3Rpb24gc3luY1JhbmRvbUJ5dGVzKGxlbmd0aD0zMil7Y29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ5dGVzKTtyZXR1cm4gYnl0ZXM7fQogIGZ1bmN0aW9uIHN5bmNCeXRlc1RvQmFzZTY0VXJsKGJ5dGVzKXtsZXQgYmluYXJ5PSIiO2ZvcihsZXQgaT0wO2k8Ynl0ZXMubGVuZ3RoO2krPTgxOTIpYmluYXJ5Kz1TdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksaSs4MTkyKSk7cmV0dXJuIGJ0b2EoYmluYXJ5KS5yZXBsYWNlQWxsKCIrIiwiLSIpLnJlcGxhY2VBbGwoIi8iLCJfIikucmVwbGFjZSgvPSskL2csIiIpO30KICBmdW5jdGlvbiBzeW5jQmFzZTY0VXJsVG9CeXRlcyh2YWx1ZSl7Y29uc3QgcmF3PVN0cmluZyh2YWx1ZXx8IiIpLnJlcGxhY2VBbGwoIi0iLCIrIikucmVwbGFjZUFsbCgiXyIsIi8iKTtjb25zdCBwYWRkZWQ9cmF3KyI9Ii5yZXBlYXQoKDQtcmF3Lmxlbmd0aCU0KSU0KTtjb25zdCBiaW5hcnk9YXRvYihwYWRkZWQpO2NvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KGJpbmFyeS5sZW5ndGgpO2ZvcihsZXQgaT0wO2k8YmluYXJ5Lmxlbmd0aDtpKyspYnl0ZXNbaV09YmluYXJ5LmNoYXJDb2RlQXQoaSk7cmV0dXJuIGJ5dGVzO30KICBmdW5jdGlvbiBzeW5jUmVjb3ZlcnlOb3JtYWxpemUodmFsdWUpe3JldHVybiBTdHJpbmcodmFsdWV8fCIiKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teMC05YS1mXS9nLCIiKTt9CiAgZnVuY3Rpb24gc3luY1JlY292ZXJ5Rm9ybWF0KHZhbHVlKXtjb25zdCByYXc9c3luY1JlY292ZXJ5Tm9ybWFsaXplKHZhbHVlKS50b1VwcGVyQ2FzZSgpO3JldHVybiByYXcubWF0Y2goLy57MSw0fS9nKT8uam9pbigiLSIpfHwiIjt9CiAgZnVuY3Rpb24gc3luY0dlbmVyYXRlUmVjb3ZlcnlLZXkoKXtyZXR1cm4gWy4uLnN5bmNSYW5kb21CeXRlcygzMildLm1hcChiPT5iLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCIwIikpLmpvaW4oIiIpO30KICBmdW5jdGlvbiBzeW5jR2VuZXJhdGVJZChwcmVmaXgsYnl0ZXM9MTYpe3JldHVybiBgJHtwcmVmaXh9LSR7c3luY0J5dGVzVG9CYXNlNjRVcmwoc3luY1JhbmRvbUJ5dGVzKGJ5dGVzKSl9YDt9CiAgZnVuY3Rpb24gbG9hZFN5bmNTdGF0ZSgpewogICAgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU1lOQ19TVEFURV9LRVkpLHt9KTsKICAgIHJldHVybiB7Y29uZmlndXJlZDpCb29sZWFuKHJhdz8uY29uZmlndXJlZCksdmF1bHRJZDpTdHJpbmcocmF3Py52YXVsdElkfHwiIiksZGV2aWNlSWQ6U3RyaW5nKHJhdz8uZGV2aWNlSWR8fCIiKSxkZXZpY2VOYW1lOlN0cmluZyhyYXc/LmRldmljZU5hbWV8fCIiKSxkZXZpY2VUb2tlbjpTdHJpbmcocmF3Py5kZXZpY2VUb2tlbnx8IiIpLHJlY292ZXJ5S2V5OigoKT0+e2NvbnN0IGN1cnJlbnQ9c3luY1JlY292ZXJ5Tm9ybWFsaXplKHJhdz8ucmVjb3ZlcnlLZXl8fCIiKTtjb25zdCBsZWdhY3k9c3luY1JlY292ZXJ5Tm9ybWFsaXplKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNZTkNfU0VDUkVUX0xFR0FDWV9LRVkpfHwiIik7cmV0dXJuIGN1cnJlbnQubGVuZ3RoPT09NjQ/Y3VycmVudDpsZWdhY3kubGVuZ3RoPT09NjQ/bGVnYWN5OmN1cnJlbnQ7fSkoKSxyb2xlOnJhdz8ucm9sZT09PSJhZG1pbiI/ImFkbWluIjoibWVtYmVyIixzY29wZToiZnVsbCIsc2VydmVyUmV2aXNpb246TWF0aC5tYXgoMCxOdW1iZXIocmF3Py5zZXJ2ZXJSZXZpc2lvbj8/cmF3Py5yZXZpc2lvbil8fDApLGxhc3RTeW5jQXQ6U3RyaW5nKHJhdz8ubGFzdFN5bmNBdHx8IiIpLGxhc3RFcnJvcjpTdHJpbmcocmF3Py5sYXN0RXJyb3J8fCIiKX07CiAgfQogIGZ1bmN0aW9uIHNhdmVTeW5jU3RhdGUoKXtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTWU5DX1NUQVRFX0tFWSxKU09OLnN0cmluZ2lmeShzeW5jU3RhdGUpKTt9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0Rlcml2ZUtleShyZWNvdmVyeUtleSx2YXVsdElkKXsKICAgIGNvbnN0IHJhdz1zeW5jUmVjb3ZlcnlOb3JtYWxpemUocmVjb3ZlcnlLZXkpO2lmKHJhdy5sZW5ndGghPT02NCl0aHJvdyBuZXcgRXJyb3IoIldpZWRlcmhlcnN0ZWxsdW5nc3NjaGzDvHNzZWwgaXN0IHVudm9sbHN0w6RuZGlnLiIpOwogICAgY29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkocmF3Lm1hdGNoKC8uezJ9L2cpLm1hcCh2PT5wYXJzZUludCh2LDE2KSkpO2NvbnN0IGJhc2U9YXdhaXQgY3J5cHRvLnN1YnRsZS5pbXBvcnRLZXkoInJhdyIsYnl0ZXMsIkhLREYiLGZhbHNlLFsiZGVyaXZlS2V5Il0pOwogICAgcmV0dXJuIGNyeXB0by5zdWJ0bGUuZGVyaXZlS2V5KHtuYW1lOiJIS0RGIixoYXNoOiJTSEEtMjU2IixzYWx0Om5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh2YXVsdElkKSxpbmZvOm5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSgiZWxkZWhvZi1wcml2YXRlLXN5bmMtdjEiKX0sYmFzZSx7bmFtZToiQUVTLUdDTSIsbGVuZ3RoOjI1Nn0sZmFsc2UsWyJlbmNyeXB0IiwiZGVjcnlwdCJdKTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0VuY3J5cHQocGF5bG9hZCl7Y29uc3Qga2V5PWF3YWl0IHN5bmNEZXJpdmVLZXkoc3luY1N0YXRlLnJlY292ZXJ5S2V5LHN5bmNTdGF0ZS52YXVsdElkKTtjb25zdCBpdj1zeW5jUmFuZG9tQnl0ZXMoMTIpO2NvbnN0IGFhZD1uZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoYCR7U1lOQ19FTlZFTE9QRV9TQ0hFTUF9OiR7c3luY1N0YXRlLnZhdWx0SWR9YCk7Y29uc3QgcGxhaW49bmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtjb25zdCBlbmNyeXB0ZWQ9YXdhaXQgY3J5cHRvLnN1YnRsZS5lbmNyeXB0KHtuYW1lOiJBRVMtR0NNIixpdixhZGRpdGlvbmFsRGF0YTphYWQsdGFnTGVuZ3RoOjEyOH0sa2V5LHBsYWluKTtyZXR1cm4ge3NjaGVtYTpTWU5DX0VOVkVMT1BFX1NDSEVNQSxhbGdvcml0aG06IkFFUy1HQ00tMjU2L0hLREYtU0hBLTI1NiIsaXY6c3luY0J5dGVzVG9CYXNlNjRVcmwoaXYpLGNpcGhlcnRleHQ6c3luY0J5dGVzVG9CYXNlNjRVcmwobmV3IFVpbnQ4QXJyYXkoZW5jcnlwdGVkKSksc2NvcGU6ImZ1bGwiLGNyZWF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkscGF5bG9hZEJ1aWxkOkFQUF9CVUlMRH07fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNEZWNyeXB0KGVudmVsb3BlKXtpZihlbnZlbG9wZT8uc2NoZW1hIT09U1lOQ19FTlZFTE9QRV9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJVbmJla2FubnRlcyBTeW5jLVBha2V0LiIpO2NvbnN0IGtleT1hd2FpdCBzeW5jRGVyaXZlS2V5KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSxzeW5jU3RhdGUudmF1bHRJZCk7Y29uc3QgYWFkPW5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShgJHtTWU5DX0VOVkVMT1BFX1NDSEVNQX06JHtzeW5jU3RhdGUudmF1bHRJZH1gKTtsZXQgcGxhaW47dHJ5e3BsYWluPWF3YWl0IGNyeXB0by5zdWJ0bGUuZGVjcnlwdCh7bmFtZToiQUVTLUdDTSIsaXY6c3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuaXYpLGFkZGl0aW9uYWxEYXRhOmFhZCx0YWdMZW5ndGg6MTI4fSxrZXksc3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuY2lwaGVydGV4dCkpO31jYXRjaHt0aHJvdyBuZXcgRXJyb3IoIlN5bmMtUGFrZXQga29ubnRlIG5pY2h0IGVudHNjaGzDvHNzZWx0IHdlcmRlbi4iKTt9Y29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShwbGFpbikpO2lmKHBheWxvYWQ/LnNjaGVtYSE9PVNZTkNfUEFZTE9BRF9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJTeW5jLVBha2V0IHN0YW1tdCBhdXMgZWluZXIgbmljaHQga29tcGF0aWJsZW4gRWxkZWhvZi1WZXJzaW9uLiIpO3JldHVybiBwYXlsb2FkO30KICBhc3luYyBmdW5jdGlvbiBzeW5jQXBpKHBhdGgsYm9keSl7Y29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2goYC9hcGkvc3luYy8ke3BhdGh9YCx7bWV0aG9kOiJQT1NUIixoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiIsImFjY2VwdCI6ImFwcGxpY2F0aW9uL2pzb24ifSxib2R5OkpTT04uc3RyaW5naWZ5KGJvZHkpLGNhY2hlOiJuby1zdG9yZSJ9KTtsZXQgcGF5bG9hZD17fTt0cnl7cGF5bG9hZD1hd2FpdCByZXNwb25zZS5qc29uKCk7fWNhdGNoe31pZighcmVzcG9uc2Uub2spe2NvbnN0IGVycm9yPW5ldyBFcnJvcihwYXlsb2FkLmVycm9yfHxgU3luYy1GZWhsZXIgJHtyZXNwb25zZS5zdGF0dXN9YCk7ZXJyb3Iuc3RhdHVzPXJlc3BvbnNlLnN0YXR1cztlcnJvci5wYXlsb2FkPXBheWxvYWQ7dGhyb3cgZXJyb3I7fXJldHVybiBwYXlsb2FkO30KICBmdW5jdGlvbiBzeW5jQXV0aChleHRyYT17fSl7cmV0dXJuIHt2YXVsdElkOnN5bmNTdGF0ZS52YXVsdElkLGRldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxkZXZpY2VUb2tlbjpzeW5jU3RhdGUuZGV2aWNlVG9rZW4sLi4uZXh0cmF9O30KICBmdW5jdGlvbiBzeW5jSXRlbVRpbWUoaXRlbSl7Zm9yKGNvbnN0IGtleSBvZiBbInVwZGF0ZWRBdCIsInByaWNlVXBkYXRlZEF0IiwiaGVhdFB1bXBVcGRhdGVkQXQiLCJjbG9zZWRBdCJdKXtjb25zdCB0PURhdGUucGFyc2UoaXRlbT8uW2tleV18fCIiKTtpZihOdW1iZXIuaXNGaW5pdGUodCkpcmV0dXJuIHQ7fXJldHVybiAwO30KICBmdW5jdGlvbiBzeW5jTWVyZ2VCeUtleShsb2NhbCxyZW1vdGUsa2V5RmllbGQpe2NvbnN0IG1hcD1uZXcgTWFwKCk7Zm9yKGNvbnN0IGl0ZW0gb2YgQXJyYXkuaXNBcnJheShsb2NhbCk/bG9jYWw6W10pbWFwLnNldChTdHJpbmcoaXRlbT8uW2tleUZpZWxkXXx8IiIpLGl0ZW0pO2Zvcihjb25zdCByZW1vdGVJdGVtIG9mIEFycmF5LmlzQXJyYXkocmVtb3RlKT9yZW1vdGU6W10pe2NvbnN0IGtleT1TdHJpbmcocmVtb3RlSXRlbT8uW2tleUZpZWxkXXx8IiIpO2lmKCFrZXkpY29udGludWU7Y29uc3QgbG9jYWxJdGVtPW1hcC5nZXQoa2V5KTtpZighbG9jYWxJdGVtfHxzeW5jSXRlbVRpbWUocmVtb3RlSXRlbSk+PXN5bmNJdGVtVGltZShsb2NhbEl0ZW0pKW1hcC5zZXQoa2V5LHJlbW90ZUl0ZW0pO31yZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV07fQogIGZ1bmN0aW9uIHN5bmNDdXJyZW50UGF5bG9hZCgpe3JldHVybiB7c2NoZW1hOlNZTkNfUEFZTE9BRF9TQ0hFTUEscGF5bG9hZFZlcnNpb246IjYuMy4yIixhcHA6IkVsZGVob2YiLHNjb3BlOiJmdWxsIixyZWNvcmRzOnNhbml0aXplUmVjb3JkcyhyZWNvcmRzKSx2YWlsbGFudE1vbnRoczpBcnJheS5pc0FycmF5KHZhaWxsYW50TW9udGhzKT92YWlsbGFudE1vbnRoczpbXSxjbGltYXRlTW9udGhzOmNsaW1hdGVTYW5pdGl6ZShjbGltYXRlTW9udGhzKSxtZXRlclJlYWRpbmdzOnNhbml0aXplTWV0ZXJSZWFkaW5ncyhtZXRlclJlYWRpbmdzKSxtZXRlclJlYWRpbmdzVXBkYXRlZEF0OmxvY2FsU3RvcmFnZS5nZXRJdGVtKE1FVEVSX01FVEFfS0VZKXx8IiIsb3N0cm9tTGl2ZTpvc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKG9zdHJvbVByaWNlU3RhdHMpLGV4cG9ydGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHNvdXJjZURldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxzb3VyY2VEZXZpY2VOYW1lOnN5bmNTdGF0ZS5kZXZpY2VOYW1lfTt9CiAgZnVuY3Rpb24gc3luY01lcmdlUGF5bG9hZChsb2NhbCxyZW1vdGUpewogICAgY29uc3QgbG9jYWxNZXRlclRpbWU9RGF0ZS5wYXJzZShsb2NhbD8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIpfHwwLHJlbW90ZU1ldGVyVGltZT1EYXRlLnBhcnNlKHJlbW90ZT8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIpfHwwOwogICAgbGV0IG1lcmdlZE1ldGVycztpZihyZW1vdGVNZXRlclRpbWU+bG9jYWxNZXRlclRpbWUpbWVyZ2VkTWV0ZXJzPXJlbW90ZS5tZXRlclJlYWRpbmdzfHxbXTtlbHNlIGlmKGxvY2FsTWV0ZXJUaW1lPnJlbW90ZU1ldGVyVGltZSltZXJnZWRNZXRlcnM9bG9jYWwubWV0ZXJSZWFkaW5nc3x8W107ZWxzZSBtZXJnZWRNZXRlcnM9KHJlbW90ZT8ubWV0ZXJSZWFkaW5ncz8ubGVuZ3RofHwwKT49KGxvY2FsPy5tZXRlclJlYWRpbmdzPy5sZW5ndGh8fDApP3JlbW90ZS5tZXRlclJlYWRpbmdzfHxbXTpsb2NhbC5tZXRlclJlYWRpbmdzfHxbXTsKICAgIGNvbnN0IGxvY2FsTGl2ZT1EYXRlLnBhcnNlKGxvY2FsPy5vc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpfHwwLHJlbW90ZUxpdmU9RGF0ZS5wYXJzZShyZW1vdGU/Lm9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0fHwiIil8fDA7CiAgICByZXR1cm4ge3NjaGVtYTpTWU5DX1BBWUxPQURfU0NIRU1BLHBheWxvYWRWZXJzaW9uOiI2LjMuMiIsYXBwOiJFbGRlaG9mIixzY29wZToiZnVsbCIscmVjb3JkczpzYW5pdGl6ZVJlY29yZHMoc3luY01lcmdlQnlLZXkobG9jYWw/LnJlY29yZHMscmVtb3RlPy5yZWNvcmRzLCJtb250aCIpKSx2YWlsbGFudE1vbnRoczpzeW5jTWVyZ2VCeUtleShsb2NhbD8udmFpbGxhbnRNb250aHMscmVtb3RlPy52YWlsbGFudE1vbnRocywibW9udGgiKSxjbGltYXRlTW9udGhzOmNsaW1hdGVTYW5pdGl6ZShzeW5jTWVyZ2VCeUtleShsb2NhbD8uY2xpbWF0ZU1vbnRocyxyZW1vdGU/LmNsaW1hdGVNb250aHMsIm1vbnRoIikpLG1ldGVyUmVhZGluZ3M6c2FuaXRpemVNZXRlclJlYWRpbmdzKG1lcmdlZE1ldGVycyksbWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdDpyZW1vdGVNZXRlclRpbWU+bG9jYWxNZXRlclRpbWU/cmVtb3RlLm1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6bG9jYWwubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdCxvc3Ryb21MaXZlOnJlbW90ZUxpdmU+PWxvY2FsTGl2ZT9yZW1vdGU/Lm9zdHJvbUxpdmV8fG51bGw6bG9jYWw/Lm9zdHJvbUxpdmV8fG51bGwsb3N0cm9tUHJpY2VTdGF0czpzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdHMoc3luY01lcmdlQnlLZXkobG9jYWw/Lm9zdHJvbVByaWNlU3RhdHMscmVtb3RlPy5vc3Ryb21QcmljZVN0YXRzLCJtb250aCIpKSxleHBvcnRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxzb3VyY2VEZXZpY2VJZDpzeW5jU3RhdGUuZGV2aWNlSWQsc291cmNlRGV2aWNlTmFtZTpzeW5jU3RhdGUuZGV2aWNlTmFtZX07CiAgfQogIGZ1bmN0aW9uIHN5bmNDb21wYXJhYmxlKHBheWxvYWQpe3JldHVybiBKU09OLnN0cmluZ2lmeSh7cmVjb3JkczpzYW5pdGl6ZVJlY29yZHMocGF5bG9hZD8ucmVjb3Jkc3x8W10pLHZhaWxsYW50TW9udGhzOnBheWxvYWQ/LnZhaWxsYW50TW9udGhzfHxbXSxjbGltYXRlTW9udGhzOmNsaW1hdGVTYW5pdGl6ZShwYXlsb2FkPy5jbGltYXRlTW9udGhzfHxbXSksbWV0ZXJSZWFkaW5nczpzYW5pdGl6ZU1ldGVyUmVhZGluZ3MocGF5bG9hZD8ubWV0ZXJSZWFkaW5nc3x8W10pLG1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6cGF5bG9hZD8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIsb3N0cm9tTGl2ZTpwYXlsb2FkPy5vc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHBheWxvYWQ/Lm9zdHJvbVByaWNlU3RhdHN8fFtdKX0pO30KICBmdW5jdGlvbiBzeW5jQXBwbHlQYXlsb2FkKHBheWxvYWQpe3N5bmNBcHBseWluZz10cnVlO3RyeXtzYXZlUmVjb3JkcyhwYXlsb2FkLnJlY29yZHN8fFtdLHtyZWFzb246IkdlcsOkdGUtU3luYyIsYWxsb3dFbXB0eTp0cnVlfSk7dmFpbGxhbnRNb250aHM9QXJyYXkuaXNBcnJheShwYXlsb2FkLnZhaWxsYW50TW9udGhzKT9wYXlsb2FkLnZhaWxsYW50TW9udGhzOltdO3NhdmVWYWlsbGFudE1vbnRocygpO3NhdmVDbGltYXRlTW9udGhzKHBheWxvYWQuY2xpbWF0ZU1vbnRoc3x8W10pO3NhdmVNZXRlclJlYWRpbmdzKHBheWxvYWQubWV0ZXJSZWFkaW5nc3x8W10se3RvdWNoOmZhbHNlfSk7aWYocGF5bG9hZC5tZXRlclJlYWRpbmdzVXBkYXRlZEF0KWxvY2FsU3RvcmFnZS5zZXRJdGVtKE1FVEVSX01FVEFfS0VZLHBheWxvYWQubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdCk7c2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQub3N0cm9tTGl2ZXx8bnVsbCk7c2F2ZU9zdHJvbVByaWNlU3RhdHMocGF5bG9hZC5vc3Ryb21QcmljZVN0YXRzfHxbXSk7fWZpbmFsbHl7c3luY0FwcGx5aW5nPWZhbHNlO31yZW5kZXJBbGwoKTt9CiAgZnVuY3Rpb24gc2NoZWR1bGVDbG91ZFN5bmMoZGVsYXk9OTAwKXtjbGVhclRpbWVvdXQoc3luY0RlYm91bmNlVGltZXIpO2lmKCFzeW5jU3RhdGUuY29uZmlndXJlZHx8c3luY0FwcGx5aW5nKXJldHVybjtzeW5jRGVib3VuY2VUaW1lcj1zZXRUaW1lb3V0KCgpPT57aWYoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlIT09ImhpZGRlbiImJm5hdmlnYXRvci5vbkxpbmUhPT1mYWxzZSlzeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pO30sZGVsYXkpO30KICBmdW5jdGlvbiBzY2hlZHVsZVN5bmNQb2xsKCl7Y2xlYXJJbnRlcnZhbChzeW5jUG9sbFRpbWVyKTtzeW5jUG9sbFRpbWVyPW51bGw7aWYoIXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjtzeW5jUG9sbFRpbWVyPXNldEludGVydmFsKCgpPT57aWYoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlPT09InZpc2libGUiJiZuYXZpZ2F0b3Iub25MaW5lIT09ZmFsc2Upc3luY05vdyh7c2lsZW50OnRydWV9KTt9LDYwKjEwMDApO30KICBhc3luYyBmdW5jdGlvbiBjcmVhdGVTeW5jVmF1bHQoKXtpZihzeW5jQnVzeSlyZXR1cm47Y29uc3QgZGV2aWNlTmFtZT1TdHJpbmcoJCgic3luY0NyZWF0ZURldmljZU5hbWUiKS52YWx1ZXx8IiIpLnRyaW0oKTtpZihkZXZpY2VOYW1lLmxlbmd0aDwyKXt0b2FzdCgiR2Vyw6R0ZW5hbWVuIGVpbmdlYmVuIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtzeW5jU3RhdGU9e2NvbmZpZ3VyZWQ6dHJ1ZSx2YXVsdElkOnN5bmNHZW5lcmF0ZUlkKCJ2YXVsdCIsMTgpLGRldmljZUlkOnN5bmNHZW5lcmF0ZUlkKCJkZXZpY2UiLDE2KSxkZXZpY2VOYW1lLGRldmljZVRva2VuOnN5bmNHZW5lcmF0ZUlkKCJ0b2tlbiIsMzIpLHJlY292ZXJ5S2V5OnN5bmNHZW5lcmF0ZVJlY292ZXJ5S2V5KCkscm9sZToiYWRtaW4iLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtjb25zdCBzbmFwc2hvdD1zeW5jQ3VycmVudFBheWxvYWQoKTtjb25zdCBlbnZlbG9wZT1hd2FpdCBzeW5jRW5jcnlwdChzbmFwc2hvdCk7Y29uc3QgcmVzdWx0PWF3YWl0IHN5bmNBcGkoInZhdWx0L2NyZWF0ZSIse3ZhdWx0SWQ6c3luY1N0YXRlLnZhdWx0SWQsZGV2aWNlSWQ6c3luY1N0YXRlLmRldmljZUlkLGRldmljZU5hbWUsZGV2aWNlVG9rZW46c3luY1N0YXRlLmRldmljZVRva2VuLHNjb3BlOiJmdWxsIixlbnZlbG9wZX0pO3N5bmNTdGF0ZS5zZXJ2ZXJSZXZpc2lvbj1yZXN1bHQucmV2aXNpb247c3luY1N0YXRlLmxhc3RTeW5jQXQ9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO3NhdmVTeW5jU3RhdGUoKTtzY2hlZHVsZVN5bmNQb2xsKCk7cmVuZGVyQWxsKCk7dG9hc3QoIkdlcsOkdGUtU3luYyBlaW5nZXJpY2h0ZXQiKTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZT1sb2FkU3luY1N0YXRlKCk7c3luY1N0YXRlLmxhc3RFcnJvcj1lcnJvci5tZXNzYWdlO3NhdmVTeW5jU3RhdGUoKTthbGVydChgR2Vyw6R0ZS1TeW5jIGtvbm50ZSBuaWNodCBlaW5nZXJpY2h0ZXQgd2VyZGVuOiAke2Vycm9yLm1lc3NhZ2V9YCk7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBhc3luYyBmdW5jdGlvbiBjcmVhdGVTeW5jUGFpcmluZygpe2lmKHN5bmNCdXN5fHwhc3luY1N0YXRlLmNvbmZpZ3VyZWQpcmV0dXJuO2lmKHN5bmNTdGF0ZS5yb2xlIT09ImFkbWluIil7dG9hc3QoIk51ciBkYXMgZXJzdGUgVmVyd2FsdHVuZ3NnZXLDpHQga2FubiBuZXVlIEdlcsOkdGUga29wcGVsbiIpO3JldHVybjt9c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7Y29uc3QgcmVzdWx0PWF3YWl0IHN5bmNBcGkoInBhaXIvY3JlYXRlIixzeW5jQXV0aCh7c2NvcGU6ImZ1bGwifSkpOyQoInN5bmNQYWlyVmF1bHQiKS50ZXh0Q29udGVudD1zeW5jU3RhdGUudmF1bHRJZDskKCJzeW5jUGFpckNvZGUiKS50ZXh0Q29udGVudD1yZXN1bHQuY29kZTskKCJzeW5jUGFpclJlY292ZXJ5IikudGV4dENvbnRlbnQ9c3luY1JlY292ZXJ5Rm9ybWF0KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSk7JCgic3luY1BhaXJFeHBpcnkiKS50ZXh0Q29udGVudD1gQ29kZSBnw7xsdGlnIGJpcyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUocmVzdWx0LmV4cGlyZXNBdCkpfWA7JCgic3luY1BhaXJSZXN1bHQiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTt9Y2F0Y2goZXJyb3Ipe3RvYXN0KGVycm9yLm1lc3NhZ2UpO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gam9pblN5bmNWYXVsdCgpe2lmKHN5bmNCdXN5KXJldHVybjtjb25zdCB2YXVsdElkPVN0cmluZygkKCJzeW5jSm9pblZhdWx0SWQiKS52YWx1ZXx8IiIpLnRyaW0oKSxjb2RlPVN0cmluZygkKCJzeW5jSm9pbkNvZGUiKS52YWx1ZXx8IiIpLnRyaW0oKSxyZWNvdmVyeUtleT1zeW5jUmVjb3ZlcnlOb3JtYWxpemUoJCgic3luY0pvaW5SZWNvdmVyeSIpLnZhbHVlKSxkZXZpY2VOYW1lPVN0cmluZygkKCJzeW5jSm9pbkRldmljZU5hbWUiKS52YWx1ZXx8IiIpLnRyaW0oKTtpZighdmF1bHRJZHx8IWNvZGV8fHJlY292ZXJ5S2V5Lmxlbmd0aCE9PTY0fHxkZXZpY2VOYW1lLmxlbmd0aDwyKXt0b2FzdCgiS29wcGx1bmdzZGF0ZW4gdm9sbHN0w6RuZGlnIGVpbmdlYmVuIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3RyeXtjb25zdCBkZXZpY2VJZD1zeW5jR2VuZXJhdGVJZCgiZGV2aWNlIiwxNiksZGV2aWNlVG9rZW49c3luY0dlbmVyYXRlSWQoInRva2VuIiwzMik7Y29uc3QgY2xhaW09YXdhaXQgc3luY0FwaSgicGFpci9jbGFpbSIse3ZhdWx0SWQsY29kZSxkZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VufSk7c3luY1N0YXRlPXtjb25maWd1cmVkOnRydWUsdmF1bHRJZCxkZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VuLHJlY292ZXJ5S2V5LHJvbGU6Y2xhaW0ucm9sZXx8Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOjAsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6IiJ9O3NhdmVTeW5jU3RhdGUoKTtjb25zdCByZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSk7Y29uc3QgcmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUpO2NvbnN0IG1lcmdlZD1zeW5jTWVyZ2VQYXlsb2FkKHN5bmNDdXJyZW50UGF5bG9hZCgpLHJlbW90ZVBheWxvYWQpO3N5bmNBcHBseVBheWxvYWQobWVyZ2VkKTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cmVtb3RlLnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7aWYoc3luY0NvbXBhcmFibGUobWVyZ2VkKSE9PXN5bmNDb21wYXJhYmxlKHJlbW90ZVBheWxvYWQpKXtjb25zdCBlbnZlbG9wZT1hd2FpdCBzeW5jRW5jcnlwdChtZXJnZWQpO2NvbnN0IHB1c2hlZD1hd2FpdCBzeW5jQXBpKCJzbmFwc2hvdC9wdXNoIixzeW5jQXV0aCh7YmFzZVJldmlzaW9uOnJlbW90ZS5yZXZpc2lvbixlbnZlbG9wZX0pKTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cHVzaGVkLnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7fXNjaGVkdWxlU3luY1BvbGwoKTtyZW5kZXJBbGwoKTt0b2FzdCgiR2Vyw6R0IGdla29wcGVsdCB1bmQgYWt0dWFsaXNpZXJ0Iik7fWNhdGNoKGVycm9yKXtzeW5jU3RhdGU9e2NvbmZpZ3VyZWQ6ZmFsc2UsdmF1bHRJZDoiIixkZXZpY2VJZDoiIixkZXZpY2VOYW1lOiIiLGRldmljZVRva2VuOiIiLHJlY292ZXJ5S2V5OiIiLHJvbGU6Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOjAsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6ZXJyb3IubWVzc2FnZX07c2F2ZVN5bmNTdGF0ZSgpO2FsZXJ0KGBLb3BwbHVuZyBmZWhsZ2VzY2hsYWdlbjogJHtlcnJvci5tZXNzYWdlfWApO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gc3luY05vdyh7c2lsZW50PWZhbHNlLHJldHJ5PXRydWV9PXt9KXtpZihzeW5jQnVzeXx8IXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybiBmYWxzZTtzeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtjb25zdCByZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSk7Y29uc3QgcmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUpO2NvbnN0IGxvY2FsUGF5bG9hZD1zeW5jQ3VycmVudFBheWxvYWQoKTtjb25zdCBtZXJnZWQ9c3luY01lcmdlUGF5bG9hZChsb2NhbFBheWxvYWQscmVtb3RlUGF5bG9hZCk7c3luY0FwcGx5UGF5bG9hZChtZXJnZWQpO2xldCByZXZpc2lvbj1yZW1vdGUucmV2aXNpb247aWYoc3luY0NvbXBhcmFibGUobWVyZ2VkKSE9PXN5bmNDb21wYXJhYmxlKHJlbW90ZVBheWxvYWQpKXt0cnl7Y29uc3QgZW52ZWxvcGU9YXdhaXQgc3luY0VuY3J5cHQobWVyZ2VkKTtjb25zdCBwdXNoZWQ9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVzaCIsc3luY0F1dGgoe2Jhc2VSZXZpc2lvbjpyZW1vdGUucmV2aXNpb24sZW52ZWxvcGV9KSk7cmV2aXNpb249cHVzaGVkLnJldmlzaW9uO31jYXRjaChlcnJvcil7aWYoZXJyb3Iuc3RhdHVzPT09NDA5JiZyZXRyeSl7c3luY0J1c3k9ZmFsc2U7cmV0dXJuIGF3YWl0IHN5bmNOb3coe3NpbGVudCxyZXRyeTpmYWxzZX0pO310aHJvdyBlcnJvcjt9fXN5bmNTdGF0ZS5zZXJ2ZXJSZXZpc2lvbj1yZXZpc2lvbjtzeW5jU3RhdGUubGFzdFN5bmNBdD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7c3luY1N0YXRlLmxhc3RFcnJvcj0iIjtzYXZlU3luY1N0YXRlKCk7aWYoIXNpbGVudCl0b2FzdCgiQWxsZSBHZXLDpHRlIGF1ZiBha3R1ZWxsZW0gU3RhbmQiKTtyZXR1cm4gdHJ1ZTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZS5sYXN0RXJyb3I9ZXJyb3IubWVzc2FnZTtzYXZlU3luY1N0YXRlKCk7aWYoIXNpbGVudCl0b2FzdChgU3luYzogJHtlcnJvci5tZXNzYWdlfWApO3JldHVybiBmYWxzZTt9ZmluYWxseXtzeW5jQnVzeT1mYWxzZTtyZW5kZXJTeW5jUGFuZWwoKTt9fQogIGZ1bmN0aW9uIGRpc2Nvbm5lY3RTeW5jKCl7aWYoIWNvbmZpcm0oIkRpZXNlcyBHZXLDpHQgbG9rYWwgdm9tIEVsZGVob2YtU3luYyB0cmVubmVuPyBEaWUgRGF0ZW4gYXVmIGRlbSBHZXLDpHQgYmxlaWJlbiBlcmhhbHRlbi4iKSlyZXR1cm47c3luY1N0YXRlPXtjb25maWd1cmVkOmZhbHNlLHZhdWx0SWQ6IiIsZGV2aWNlSWQ6IiIsZGV2aWNlTmFtZToiIixkZXZpY2VUb2tlbjoiIixyZWNvdmVyeUtleToiIixyb2xlOiJtZW1iZXIiLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtzYXZlU3luY1N0YXRlKCk7c2NoZWR1bGVTeW5jUG9sbCgpO3JlbmRlclN5bmNQYW5lbCgpO3RvYXN0KCJHZXLDpHQgdm9tIFN5bmMgZ2V0cmVubnQiKTt9CiAgZnVuY3Rpb24gcmVuZGVyU3luY1BhbmVsKCl7aWYoISQoInN5bmNQYW5lbCIpKXJldHVybjskKCJzeW5jU2V0dXBCb3giKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHN5bmNTdGF0ZS5jb25maWd1cmVkKTskKCJzeW5jQWN0aXZlQm94IikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc3luY1N0YXRlLmNvbmZpZ3VyZWQpO2NvbnN0IGJhZGdlPSQoInN5bmNCYWRnZSIpO2JhZGdlLmNsYXNzTmFtZT1gc3luYy1iYWRnZSAke3N5bmNCdXN5PyJidXN5IjpzeW5jU3RhdGUubGFzdEVycm9yPyJlcnJvciI6c3luY1N0YXRlLmNvbmZpZ3VyZWQ/Im9rIjoiIn1gO2JhZGdlLnRleHRDb250ZW50PXN5bmNCdXN5PyJzeW5jaHJvbmlzaWVydCDigKYiOnN5bmNTdGF0ZS5sYXN0RXJyb3I/IkZlaGxlciI6c3luY1N0YXRlLmNvbmZpZ3VyZWQ/InZlcmJ1bmRlbiI6Im5pY2h0IGVpbmdlcmljaHRldCI7aWYoIXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjskKCJzeW5jRGV2aWNlVGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5kZXZpY2VOYW1lfHwiZGllc2VzIEdlcsOkdCI7JCgic3luY1JvbGVUZXh0IikudGV4dENvbnRlbnQ9c3luY1N0YXRlLnJvbGU9PT0iYWRtaW4iPyJWZXJ3YWx0dW5nc2dlcsOkdCI6Imdla29wcGVsdGVzIEdlcsOkdCI7JCgic3luY1JldmlzaW9uVGV4dCIpLnRleHRDb250ZW50PVN0cmluZyhzeW5jU3RhdGUuc2VydmVyUmV2aXNpb258fDApOyQoInN5bmNMYXN0VGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5sYXN0U3luY0F0P2B6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUoc3luY1N0YXRlLmxhc3RTeW5jQXQpfWA6Im5vY2ggbmllIjskKCJzeW5jU3RhdHVzIikudGV4dENvbnRlbnQ9c3luY1N0YXRlLmxhc3RFcnJvcj9gTGV0enRlciBGZWhsZXI6ICR7c3luY1N0YXRlLmxhc3RFcnJvcn1gOiLDhG5kZXJ1bmdlbiB3ZXJkZW4gYXV0b21hdGlzY2ggYWJnZWdsaWNoZW4uIjskKCJzeW5jU3RhdHVzIikuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke3N5bmNTdGF0ZS5sYXN0RXJyb3I/ImVycm9yIjoib2sifWA7JCgic3luY1BhaXJCdG4iKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHN5bmNTdGF0ZS5yb2xlIT09ImFkbWluIik7fQoKICBmdW5jdGlvbiBzYXZlQ29zdFNldHRpbmdzKCl7IHNldHRpbmdzLmZhbGxiYWNrUHJpY2U9TWF0aC5tYXgoMCxOdW1iZXIoJCgiZmFsbGJhY2tQcmljZUlucHV0IikudmFsdWUpfHwwKTtzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZT1NYXRoLm1heCgwLE51bWJlcigkKCJkZWZhdWx0QmFzZUZlZUlucHV0IikudmFsdWUpfHwwKTtzYXZlU2V0dGluZ3MoKTtzY2hlZHVsZUNsb3VkU3luYygpO3JlbmRlckFsbCgpO3RvYXN0KCJLb3N0ZW4tRWluc3RlbGx1bmdlbiBnZXNwZWljaGVydCIpOyB9CgogIGZ1bmN0aW9uIHJlbmRlckFsbCgpeyB1cGRhdGVSZWNvdmVyeUJhbm5lcigpO3JlbmRlckRhc2hib2FyZCgpO3JlbmRlclJlY29yZHMoKTtyZW5kZXJBbmFseXNpcygpO3JlbmRlckRhdGEoKTsgfQogIGZ1bmN0aW9uIHJlc2l6ZUNoYXJ0cygpeyBjbGVhclRpbWVvdXQocmVzaXplVGltZXIpO3Jlc2l6ZVRpbWVyPXNldFRpbWVvdXQoKCk9PnsgaWYoY3VycmVudFZpZXc9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7IGlmKGN1cnJlbnRWaWV3PT09ImFuYWx5c2lzVmlldyIpcmVuZGVyQW5hbHlzaXMoKTsgfSwxMDApOyB9CgogIGZ1bmN0aW9uIGJpbmQoKXsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixldmVudD0+ewogICAgICBjb25zdCBuYXY9ZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLW5hdl0iKTsgaWYobmF2KXtzd2l0Y2hWaWV3KG5hdi5kYXRhc2V0Lm5hdik7cmV0dXJuO30KICAgICAgY29uc3QgZWRpdD1ldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtZWRpdC1tb250aF0iKTsgaWYoZWRpdCl7b3BlblJlY29yZE1vZGFsKGVkaXQuZGF0YXNldC5lZGl0TW9udGgpO3JldHVybjt9CiAgICAgIGlmKGV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWxdIikpe2Nsb3NlUmVjb3JkTW9kYWwoKTtyZXR1cm47fQogICAgICBpZihldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtY2xvc2UtbWV0ZXItbW9kYWxdIikpe2Nsb3NlTWV0ZXJNb2RhbCgpO3JldHVybjt9CiAgICB9KTsKICAgICQoImRhc2hib2FyZEFkZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZFJlY29yZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZE1ldGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLG9wZW5NZXRlck1vZGFsKTsKICAgICQoImVkaXRMYXRlc3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pm9wZW5SZWNvcmRNb2RhbCgkKCJlZGl0TGF0ZXN0QnRuIikuZGF0YXNldC5tb250aCkpOwogICAgJCgicmVjb3JkRm9ybSIpLmFkZEV2ZW50TGlzdGVuZXIoInN1Ym1pdCIsc2F2ZUVkaXRlZFJlY29yZCk7IFsicmVjb3JkVG90YWwiLCJyZWNvcmRIZWF0UHVtcCIsInJlY29yZEFubmV4Il0uZm9yRWFjaChpZD0+JChpZCkuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLHVwZGF0ZURlcml2ZWRQcmV2aWV3KSk7CiAgICAkKCJtZXRlckZvcm0iKS5hZGRFdmVudExpc3RlbmVyKCJzdWJtaXQiLHNhdmVNZXRlclJlYWRpbmdGcm9tRm9ybSk7IFsibWV0ZXJEYXRlIiwibWV0ZXJUb3RhbCIsIm1ldGVyQW5uZXgiXS5mb3JFYWNoKGlkPT4kKGlkKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsdXBkYXRlTWV0ZXJQcmV2aWV3KSk7CiAgICAkKCJ1bmRvTGF0ZXN0TWV0ZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsdW5kb0xhdGVzdE1ldGVyUmVhZGluZyk7CiAgICAkKCJyZWNvcmRZZWFyRmlsdGVyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJSZWNvcmRzKTsgJCgiYW5hbHlzaXNZZWFyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJBbmFseXNpcyk7CiAgICAkKCJyZXN0b3JlU2hhZG93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHJlc3RvcmVTaGFkb3cpOyAkKCJleHBvcnRCYWNrdXBCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXhwb3J0QmFja3VwKTsgJCgiZXhwb3J0Q3N2QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV4cG9ydENzdik7ICQoImltcG9ydEJhY2t1cElucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+e2NvbnN0IGY9JCgiaW1wb3J0QmFja3VwSW5wdXQiKS5maWxlcz8uWzBdO2lmKGYpaW1wb3J0QmFja3VwKGYpO30pOwogICAgJCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+aW1wb3J0VmFpbGxhbnRDc3ZGaWxlcygkKCJ2YWlsbGFudENzdkZpbGVzSW5wdXQiKS5maWxlcykpOwogICAgJCgic2F2ZU9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQW5kQ2hlY2tPc3Ryb20pOyAkKCJkaXNjb25uZWN0T3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGRpc2Nvbm5lY3RPc3Ryb20pOyAkKCJyZWZyZXNoT3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5yZWZyZXNoT3N0cm9tKHRydWUpKTsgJCgicmVmcmVzaE9zdHJvbUhpc3RvcnlCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PnJlZnJlc2hPc3Ryb21IaXN0b3J5KCkpOyAkKCJyZWZyZXNoT3N0cm9tUHJpY2VTdGF0c0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+cmVmcmVzaE9zdHJvbVByaWNlU3RhdHMoTnVtYmVyKCQoImFuYWx5c2lzWWVhciIpLnZhbHVlKXx8bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpKSk7ICQoImdvT3N0cm9tU2V0dGluZ3NCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pntzd2l0Y2hWaWV3KCJkYXRhVmlldyIpO3NldFRpbWVvdXQoKCk9PiQoIm9zdHJvbVNldHRpbmdzUGFuZWwiKS5zY3JvbGxJbnRvVmlldyh7YmVoYXZpb3I6InNtb290aCIsYmxvY2s6InN0YXJ0In0pLDEwMCk7fSk7CiAgICAkKCJzeW5jQ3JlYXRlQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGNyZWF0ZVN5bmNWYXVsdCk7ICQoInN5bmNKb2luQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGpvaW5TeW5jVmF1bHQpOyAkKCJzeW5jTm93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5zeW5jTm93KHtzaWxlbnQ6ZmFsc2V9KSk7ICQoInN5bmNQYWlyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGNyZWF0ZVN5bmNQYWlyaW5nKTsgJCgic3luY0Rpc2Nvbm5lY3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZGlzY29ubmVjdFN5bmMpOwogICAgJCgic2F2ZUNvc3RTZXR0aW5nc0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQ29zdFNldHRpbmdzKTsKICAgICQoImxvYWRDbGltYXRlV2VhdGhlckJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixsb2FkQ2xpbWF0ZVdlYXRoZXIpOwogICAgJCgiZGFzaGJvYXJkQ2xpbWF0ZVdlYXRoZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsbG9hZENsaW1hdGVXZWF0aGVyKTsKICAgICQoImRhc2hib2FyZENsaW1hdGVEZXRhaWxzQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT57c3dpdGNoVmlldygiYW5hbHlzaXNWaWV3Iik7c2V0VGltZW91dCgoKT0+JCgiY2xpbWF0ZUFuYWx5c2lzUGFuZWwiKS5zY3JvbGxJbnRvVmlldyh7YmVoYXZpb3I6InNtb290aCIsYmxvY2s6InN0YXJ0In0pLDcwKTt9KTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRhc2hib2FyZC1jbGltYXRlLW1vZGVdIikuZm9yRWFjaChidG49PmJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PntkYXNoYm9hcmRDbGltYXRlTW9kZT1idG4uZGF0YXNldC5kYXNoYm9hcmRDbGltYXRlTW9kZTtyZW5kZXJEYXNoYm9hcmRDbGltYXRlKCk7fSkpOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInJlc2l6ZSIscmVzaXplQ2hhcnRzKTsgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigidmlzaWJpbGl0eWNoYW5nZSIsKCk9PntpZihkb2N1bWVudC5oaWRkZW4pcmV0dXJuO2lmKHNldHRpbmdzLm9zdHJvbUFwcEtleSl7Y29uc3QgYWdlPURhdGUubm93KCktRGF0ZS5wYXJzZShvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpO2lmKCFOdW1iZXIuaXNGaW5pdGUoYWdlKXx8YWdlPjEwKjYwZTMpcmVmcmVzaE9zdHJvbShmYWxzZSk7fWlmKHN5bmNTdGF0ZS5jb25maWd1cmVkKXN5bmNOb3coe3NpbGVudDp0cnVlfSk7fSk7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIixldmVudD0+e2lmKGV2ZW50LmtleSE9PSJFc2NhcGUiKXJldHVybjtpZighJCgicmVjb3JkTW9kYWwiKS5jbGFzc0xpc3QuY29udGFpbnMoImhpZGRlbiIpKWNsb3NlUmVjb3JkTW9kYWwoKTtlbHNlIGlmKCEkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LmNvbnRhaW5zKCJoaWRkZW4iKSljbG9zZU1ldGVyTW9kYWwoKTt9KTsKICB9CgogIGZ1bmN0aW9uIGluaXQoKXsKICAgIGFwcGx5SGlzdG9yaWNhbFNlZWQoKTtlbnN1cmVNZXRlckJhc2VsaW5lKCk7CiAgICBiaW5kKCk7cmVuZGVyQWxsKCk7c2NoZWR1bGVPc3Ryb20oKTtzY2hlZHVsZVN5bmNQb2xsKCk7CiAgICBpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpeyBjb25zdCBhZ2U9RGF0ZS5ub3coKS1EYXRlLnBhcnNlKG9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0fHwiIik7IGlmKCFvc3Ryb21MaXZlfHwhTnVtYmVyLmlzRmluaXRlKGFnZSl8fGFnZT4xMCo2MGUzKXJlZnJlc2hPc3Ryb20oZmFsc2UpOyBzZXRUaW1lb3V0KCgpPT5yZWZyZXNoT3N0cm9tSGlzdG9yeSh7c2lsZW50OnRydWUsb25seU1pc3Npbmc6dHJ1ZSxtYXhNb250aHM6Mn0pLDQyMDApOyB9CiAgICBpZihzeW5jU3RhdGUuY29uZmlndXJlZClzZXRUaW1lb3V0KCgpPT5zeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pLDY1MCk7CiAgICBpZigic2VydmljZVdvcmtlciIgaW4gbmF2aWdhdG9yKXdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJsb2FkIiwoKT0+bmF2aWdhdG9yLnNlcnZpY2VXb3JrZXIucmVnaXN0ZXIoInN3LmpzP3Y9Ni4zLjIiKS5jYXRjaCgoKT0+e30pKTsKICAgIGNvbnNvbGUuaW5mbyhgRWxkZWhvZiAke0FQUF9CVUlMRH1gKTsKICB9CiAgaW5pdCgpOwp9KSgpOwo=","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/sw.js":{"body":"Y29uc3QgQ0FDSEU9ImVsZGVob2YtdjYtMy0yLWNsaW1hdGUtd2VhdGhlci0yMDI2MTAzMSI7CmNvbnN0IENPUkU9WyIuLyIsIi4vP3Y9Ni4zLjIiLCIuL2luZGV4Lmh0bWwiLCIuL3N0eWxlcy5jc3M/dj02LjMuMiIsIi4vYXBwLmpzP3Y9Ni4zLjIiLCIuL21hbmlmZXN0LndlYm1hbmlmZXN0IiwiLi9pY29uLTE5Mi5wbmciLCIuL2ljb24tNTEyLnBuZyJdOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImluc3RhbGwiLGV2ZW50PT57ZXZlbnQud2FpdFVudGlsKGNhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMuYWRkQWxsKENPUkUpKS50aGVuKCgpPT5zZWxmLnNraXBXYWl0aW5nKCkpKX0pOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImFjdGl2YXRlIixldmVudD0+e2V2ZW50LndhaXRVbnRpbChjYWNoZXMua2V5cygpLnRoZW4oa2V5cz0+UHJvbWlzZS5hbGwoa2V5cy5maWx0ZXIoaz0+ayE9PUNBQ0hFKS5tYXAoaz0+Y2FjaGVzLmRlbGV0ZShrKSkpKS50aGVuKCgpPT5zZWxmLmNsaWVudHMuY2xhaW0oKSkpfSk7CnNlbGYuYWRkRXZlbnRMaXN0ZW5lcigiZmV0Y2giLGV2ZW50PT57CiAgY29uc3QgdXJsPW5ldyBVUkwoZXZlbnQucmVxdWVzdC51cmwpOwogIGlmKGV2ZW50LnJlcXVlc3QubWV0aG9kIT09IkdFVCJ8fHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCIvYXBpLyIpKXJldHVybjsKICBldmVudC5yZXNwb25kV2l0aChmZXRjaChldmVudC5yZXF1ZXN0KS50aGVuKHJlc3BvbnNlPT57Y29uc3QgY29weT1yZXNwb25zZS5jbG9uZSgpO2NhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMucHV0KGV2ZW50LnJlcXVlc3QsY29weSkpO3JldHVybiByZXNwb25zZTt9KS5jYXRjaCgoKT0+Y2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4oY2FjaGVkPT5jYWNoZWR8fGNhY2hlcy5tYXRjaCgiLi9pbmRleC5odG1sIikpKSk7Cn0pOwo=","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/manifest.webmanifest":{"body":"ewogICJuYW1lIjogIkVsZGVob2YgNi4yLjEg4oCTIFZlcmJyYXVjaHNidWNoIiwKICAic2hvcnRfbmFtZSI6ICJFbGRlaG9mIiwKICAiZGVzY3JpcHRpb24iOiAiU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4g4oCTIG1pdCBrb21wYWt0ZXIgT3N0cm9tLVByZWlzw7xiZXJzaWNodC4iLAogICJzdGFydF91cmwiOiAiLi8/dj02LjIuMSIsCiAgInNjb3BlIjogIi4vIiwKICAiZGlzcGxheSI6ICJzdGFuZGFsb25lIiwKICAib3JpZW50YXRpb24iOiAicG9ydHJhaXQtcHJpbWFyeSIsCiAgImJhY2tncm91bmRfY29sb3IiOiAiIzA2MTAxYyIsCiAgInRoZW1lX2NvbG9yIjogIiMwNzExMWYiLAogICJpY29ucyI6IFsKICAgIHsic3JjIjoiaWNvbi0xOTIucG5nIiwic2l6ZXMiOiIxOTJ4MTkyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifSwKICAgIHsic3JjIjoiaWNvbi01MTIucG5nIiwic2l6ZXMiOiI1MTJ4NTEyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifQogIF0KfQo=","type":"application/manifest+json; charset=utf-8","cache":"no-cache"},"/icon-192.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFk0lEQVR42u3du24TQRiG4fVoBShpkKJ0hi6iTEqKKAURJbdASZcqN5AbSJWOkkuAEoUiSkFLSW/RWC6RKFxQWFrlZO96ZnbmP7xfGeWwh8ffzOx6ncnOwVFDbGU5XxT7W4HDbS/t/h6AiI4AiBICEKGBiNISAhCGAEQYwojSEgIQARCpV0IAIgAi9UoIQARApF4JAYgAiNQrIQARABEAEaWjGIAIgEi9EgIQSeOobotPLqe2T8nN+UzR1k7kPxdmXkwVTLmeHZMLaJ2b27OZYTHHV9MykiwDekzHNpqtPOWSZBPQXTpu0QyRlIVRFkNSAEEnQlIiIyOAoFOLkQVAnR7opDCKM6QbEHQkVFG6oTqA0COkitIBBfQYSHcky190Ld1Aqz2EzqhVNLyHlDUQespU0fAeSr8zH9Dj3JAOQOixaiigB0OiAaHHtqFQQA+pm81nIXEeHYq9FEitEtLaQAxeHgaygB4MKVjGE6sZBRD146eEaCAiDBD146qEaCCSdCkoMyDqx1sJ0UBEDCCT9fPp+g0lRAMl6TFmiEl0he7B0NoJeN7xy/Cwtfri59PfNvbx5HKa5fnozA1kYAK0uWwMVFHec8QQtrUPhjMApcrAEIBSTWAoJyDtV4DiNNz9qT9fD9VNg7Kse1rnL6DEIjG2NGMIK6pHaf0ASJYe5kDoScrF3xeeRQb00GoAqnaOu/pxa6iFzkh/yMnSLKAnY/04rKKAHhZ6KZ9TFtAzRv346aGAHnoIQKXP3MD68WCohQ5LMxqoqJ5t68d2FQX0sIUAKnduUurHpKGAHudbm/hh9QE9hevHWA+10GFp5reBSurJWz9mXgMBPeyLR0CFj/h49VPXUPq/e2rRUx3Zxe6/br/UzYcCeurWT6dH6VjWQqdmad3Xo3FpFtBTffaj+tUS0COqftTtdUBPlfrp1aPFUECPwO5RdAQCegrXz1Z65BtqoaNoFihwaRbQI7x+hL+uAnpkTn20HB9xQ9iQlpb8rudEPdzKIGN1D5Noy+d7Q2kZ1kMDiZ5xA4gYrx9rQ9jV2+/Dv/ns5/ux62fv9FuZbaCBSuuJ+P5t06unwDYASOvsZ4ge5kCEAIj6AZCouNIDoMz1400PgLKSsn7JB0Cjz34ARKif7cLN1HsZcmVvcf0BPTRQpJ4nJ84GLigDqJCeB/XTLbvcGgIQAVBUIu6Er6ufktsAIBEg0s/ck3oKbwOrsPqlElc/G7rHBguGsBHj8H4FgLLVD3oARABE/QCIqQ+AHNUPegBE9wCo3uyHAIj6AVDx+kEPgOgeABEAEQARAiACIAIgAiBCsgM6vppyQFVkdaZ+fPwlBdDN+azk/qv+R+vG9oshjLgEZK+ElO5R4Iivkvg4TuKP6309THYOjnL9rpPLadM0t2ezwvuQ8X+vxD3inqKnPJ2MM+jGxoOFGc/B893XjKfbDWHL+YKZIEmaAy3niyyMVot5rgZJTt7x694kmioiqaswDJHUZXzicMYo5mr8atZdB6KKSBKglCqihPzUT9N7JZoqIkmA4qqIEnJSP83we2FxVYQhOXqqNVBcFRV+hxDpzRj100TcjR/OiIHM9uAVCSiijTBkVU+T+H6gXkYMZFanPnkADWHEQGZy6pMTUC8jDJkcvFaZPHv5aozf2+7vPfhKrfcrokdHA/UWEj1kT8+IDbSukOihArPmYnrKAboraWUIRgb0NOUf61nOF90eMpxp11Ohgbq8+3JID6mmUxkQjAzoqQ/oriEYRdCpq0cEIBgppSMLEIyGuxFCRyKgx4ycY3q8UJVDRy6gdYw8YFp3aUOaGwWAeiV5iFg3mgC58iRfjHpARFT4jEQCIAIgAiACIEIARABEAEQARAiACIAIgAiACAEQARABEAEQIQAiACIAIgAibvMfGKe/xgpKwHYAAAAASUVORK5CYII=","type":"image/png","cache":"public, max-age=31536000, immutable"},"/icon-512.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAPpUlEQVR42u3dvW5UVxcG4OORFUWkiYToSIkooaRAFEEucwsp6VxxA9wAlTvKXEJSIlIgCtqU9CiN5TJSChcpiCw09gwz4/Oz93qfp8ynLzFnznnftc62zdGdB48HgIouzy9chC1WLgGAAgAo5fjeXRdBAQCgAABLAAoA0AEKAAAFAGAJUAAAOkABAKAAACwBCgAABQBgCVAAACgAAEuAAgDQAQoAAAUAYAlQAAAoAABLgAIAQAEAWAIUAAAKAMASoAAAUAAAlgAFAKADFAAACgAgfglQAAA2AABLgAIAQAEAoAAAqot6C6QAAGwAACQtAQoAwAYAQNISoAAAbAAAJC0BCgDABgBA0hKgAABsAAAoAACG6m+BFACADQCApCVAAQDYAABIWgIUAIANAAAFAMDXSr4FUgAANgAAFAAAa+q9BVIAADYAAJKWAAUAYAMAQAEAcKNKb4EUAEBqmbkEIZ69vu8isKP3Lz+7CAmO7jx47CrIelAMe7k8v1AAiHv0gQJQAAh9lIECUADIfZSBDlAACH00gQJQACyd+x9OneCxk6dnI99+JZtAAdBi9At6mm2FYk3QewcogAq5L/HprhJqNIECYJnoF/oUKIPea0ABMF/0C31KNkHXNdB1BygAuQ9NlEGnNaAAmCT65T5qQAEogLj0F/2EN0FfNdBvByiAhqJf7qMJeqwBBYDoh9AaUACIfpiqBhrvAAXA3ukv+qFMDXTaAQpA9IMaUABMn/6iH25fAw12gAIQ/aIfcmugxw5QAJOnv+iHhA5QANJf+sOsNdBOBygA0S/6IbQGeiyAlRtL+kP7tj9TLfzNqcf37toA0tNf9MNSq8Die0B3S4ACMPiDDlAASH/ovwMWrAEFkJj+oh+sAj12gENg6Q+92vL0tXAsrACkP6ADGuUV0IHpL/qhHe28C+rrFZACkP5QvAbm7ABnANIfWMCmZ3POd0F9/TiYApD+oANCKQDpDzpAASD9QQcoAOkv/UEHKADpL/1BB+yho3NgBSD9QQfYAKS/9IeYDkABuG8g9Fm2BCiAjfeB9AcdoACkP5CVALfXyznwymcPxC4B4TngFZDxHzzdCsD47/6AyA6IXQJCC0D6gw7QAYkF4NU/IBkGZwDGf/C8T6GLbwSKKwAvf4DBi6DAApD+gA7I3QAAiCsA4z9gCUgsAOkP6IDcDQCAuAIw/gPzLwHtfyfoyucNYAMIGv8BZlgCFIDxH5AMCsD4D8gQBbDUJ2f8BywBERsAgCUgrgCM/4AlwAYAsMwS0PiPAgQVgPEfkBX1C8A3/wBSxQZg/AckRkwBGP8B2WIDMP4DciOmAIz/gISxARj/AemRXQAA1C8A738AOWMDSNngABmiAIz/gLSxARj/gWaSpOVfB+QQmGgv3j10EYhVpAC8/+Hg9NcBxGZO2Q3A+x92n/11AJl5cuyjJTn61/7hm+efXB9yOANA+u/6v4ICaM71l3He/3BwvusAbnQ9VQocA9gAkP46ABsASH8dQJLuD4F9AygTRbljYXbJn/cvO37hXHADcADAiIO8VYDC2eIVENJfBxBKASD9dQAKoEMOAJgtr3UA9VKo2k8COwAQ/VP/yx0LJ/tw+vnpmb8QBsLS3ypAPQoA6a8DUAAg/XUACgCkvw6gvKM7Dx53+qX7HXA0EsGOhdNcPwfe/vPAl+cXNgCoOYBbBeiUAkD6z/H1/P37I58aCgBqTtz2ABQA5Obspq/N+E+b/J3AiP7xv0jHwtgAICv9b/xqjf8ogJH5NXDS39eMRLIB/M8PAUj/Br9y439JZdLGKyCkP4RSAEj/qbz653sfIi3zXUCIfrABgPSfcvzXaigAyJ39dQAKAIrn45a3/zoABQC5yagDojT7u6AHh8AIxDnH/7U/st8YgQ0A6e/PDgoACRgw/usAFADSX/a5DigApF7k+K8DWJZDYER/Q5fFsTA2AKR/0PivHVEASH9cJRQAci1y/NcBKACkP64Yc3AIjCBra/xfu3SOhbEBIP1dQ/rT8i8CUgBIrkbHfx2AAkD643qiAJBWkeO/DmA6DoERUp1dXsfC2ACQ/kHjv5ZFASD9cbVRAMijyPFfB6AAkP648q1r/IcABofACKAex/+1j8CxMDYApL/PAhQAEidg/PeJoACQNfhcUABImcjx36fDYRwCI1wKfkyOhbEBIP2Dxn+fV1Pa/x5QBYA08alhAwA5UmX899mhAJAg+ATZxiEwgqPm+L/2UToWxgaA9PeZggJAUgSM/z7ZRXTxLUAKABnh88UGANKh9PjvU+Y6h8AIhdCP27EwNgCkf9D473NHASAF8OlPpZcTYAXg+ff8h47/7gEUgPQHd0Iuh8AeeHLH/7VbwrGwDQDpj3sDBYAn3PjvDmEfHZ0AKwDPNrhPbAB4qokf/90taRwCe5hh423jWNgGgPQ3/rt/UAB4enEXsUFfJ8CDV0CeW2Yb/1teL1798O/2e8m7IBsA0p+Kzbc1/d1RCgDpb/zPTX/3VVVeAYl+2O8G8zroRt0dANgApD/Gf3daLgUg/UmtvYPS3/2mAJD+xv/c9HfXKQCkP7np796rwSGw6Df+S//b3oSOhW0ASH/cjSgAPG/G/4Dx3z2pAJD+pKe/O1MBIP2N/7np7/7skUNg0Y/0H/9GdSxsA0D6G/+z0t8dqwDwLIH7VgHgKTL+543/7l4FgOeH6PR3D7fPIbDoN/5L/zluZsfCNgCkP1np765WAHhOjP/R6e/eVgB4QnCHu8MVAJ4N43/Y+O8+b5BDYI8E0n+ZG96xsA0A6W/8z0p/d74CwDNAdPq7/1vgFdDCJt2CPV0h4//U6e9djQ0AAAUAxv+Y8R8FAEh/FAAY/6U/JTgExoDcZRVJf2wAkLiISH8UAAAKAIz/oACgcp1IfxQABI7/0h8FAGZ/UACQMf5LfxQAAAoAjP9wO34SmG87e/J2hv/K6ccTl/q6u8//cIWxAVA5/ef8D3U0/o+Y/sWuMAqAaqEsoaZLf1cYBUDrYVEgoUYZ/6dIfx2AAqD1mJBQrjAKAIz/oAAghvRHAUDi+C/9UQBg9gcFABnjv/RHAQCgAMD4DwoACpP+KABIHP+lPwoAzP6gACBj/Jf+KAAAFADEjP/+ki8UAETWhvRHAUDg+C/9UQBg9gcFADHjPygAMP6DAoCM8V/6owDA7A8KADLGf+lPs45dAoo5e/J22gJ494v0xwYAcel/sU/6z/D1gAKA4ezJ29bS9suve9MBKADo3l7j/9e/7FMHoABgwvG/wdm/5a8QFADSf/zxf9Mv+tcBKACozF/zggKAUvb95h9QAGD8BwUA1cd/6Y8CALM/KAA4yOnHk77G/+7Sv6krjAJARsTN/q4wCgAd0Pf47wqjANABidl0+5c/rjAKgPQOOP140lo2fXP8H+vVf+wVZnH+PgCMjcvM/q4wNgBo0fbx3zd9ogDA7A8KAGLGf1AAYPwHBQAZ47/0RwGA2R8UAGSM/9IfBQBmf1AAEDP+gwIA4z8oAMgY/6U/CgDM/qAAIGP8l/4oADD7gwKAmPEfFAAY/0EBQMb4L/1RAGD2BwUAGeO/9EcBgNkfFADEjP+gAMD4DwoAMsZ/6Y8CALM/KADIGP+lPygAzP6gACBm/AcUAMZ/UACQMf5Lf1AAmP1BAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAK45v3Lz2v/5OnZfR8nMIPrafPnr38pAAAUAAAKAAAFAIACAEABAKAAbsV3gq558/yTi4C7SM4ULIDrPwoAML9Ofwhg8AoIIJYCsL+D+0cBAKAAMMSBO0cBNM2vhPMk456ZU5lfA2cDAKS/DQCPdM9OP574Ot0qKAA82LhJ2NXRnQePe/8zPHu9/lbuw6mfEdvmxbuH9f5QZ0/eGv+l/6SKHQDYAEx5dbScsNIfBUBbT3u9B77NnG0//UveDOyi5iugwVugPVV6KdTOu6DGo1/o7+XGbzHv/RVQhQIYHAMAsxdA7+k/DMPq8vzCRwsQaDUMgw4ACC2AAh3gd0IA0yn5/mf4+ruA7AEAiRtAyQ6wBACSZNcC+NIBndaAvyESmEeN9z/Dph8E8zoIoLyNPwlcowO8BQJkyN4FMHT4OshbIGBqZd7/DLv8LiCvgwDjf9wGUKMDvAUCjP+HF8DQz+sgb4EARi6ArlcBSwAgN25bAF10gCUAmEKx9z/DYX8hTI8/LGYJACTGCAXQ/ipgCQCM/xMWQHergCUAkBWjFUDLq4AlADD+T14AHa0ClgBASoxcAG2uApYAwPg/UwF0sQpYAgD5MEkBtLYKWAIA4/+sBdD4KmAJACTDhAXQTg3cuAToAOCbmVB7/J+8AK5qwO0FkFgAi68ClgDA+L9YASxeA06DAem/ZAFc1UDLHzxAiNUi/9VFVgEvggDj//IFsGANAEj/5Qtg/hqwBAA0VAAz14AOAIz/bRXAVQ00dTcA0l8BlFoFfEsoSH9aLIB5asCLICB8/G+3AGaoAR0Axv/k9G+9AObZBnQASH8FEFcDmw4DdACEpH+4VV9f7ug14EAYktM/efwfhuHoux9/6verP753d5R/z7PXN9wcH051A0h/G0D1hcCBMKSR/t0XwLg1oAMgZPyX/nUKYJQacCAMIenPlb7PALY47HjgxsOAwXkAFEp/43/BDWCUhcAeANLfBhC9ENgDQPrbAEIXAnsASH8bQPRCYA+AGtEv/RXAIU2gA0D6K4DcJtjUAWoApH/vVi7BF5sOCbb8siBHAiD9bQD1dwJ7AEh/BZDbBDoAeol+6a8Axvfzb4+2/K9qAAz+CiC3BnQASH8FoAOAWaNf+iuAJjpADYD0VwA6ABD9CkANANJfAaR1gBqAKaJf+isAHQAGfxSAGgCDPwqg5Q5QAyD6FYAaUAOwa/RLfwVQrQPUAIh+BaAG1ACiX/orADUAcl/0K4DMGtAEiH7RrwDUgBogK/dFvwJQA5oA0Y8CUAOagNKhL/oVgBp4dMD/SxnQe+6LfgXArWpAGdBd6Mt9BcAkTaAPaDDuRb8CYO4aUAwsm/VyXwHQYhPAPOS+AkAZIPdRAGgChD4KAGWA0EcBoBKQ+CgAtAKCHgUAwKRWLgGAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgAABQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAEv6D8v4I+AK37xrAAAAAElFTkSuQmCC","type":"image/png","cache":"public, max-age=31536000, immutable"}};

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
