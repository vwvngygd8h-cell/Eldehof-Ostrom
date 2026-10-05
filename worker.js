const ELDEHOF_BUILD = "6.2.1-OSTROM-PREISSTATISTIK-20261005";
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
          vaillantCsvImport: "local-arotherm-unitower-monthly",
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

async function buildWeatherPayload(env) {
  const postalCode = clean(env.OSTROM_ZIP_CODE) || "19306";
  const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodeUrl.searchParams.set("name", postalCode);
  geocodeUrl.searchParams.set("count", "1");
  geocodeUrl.searchParams.set("language", "de");
  geocodeUrl.searchParams.set("countryCode", "DE");
  const geocode = await fetchJsonWithTimeout(
    geocodeUrl.toString(),
    { headers: { accept: "application/json" } },
    { timeoutMs: 12000, retries: 1, label: "Wetter-Ortssuche" }
  );
  if (!geocode.response.ok) {
    throw httpError(geocode.response.status, "Der Wetterstandort konnte nicht geladen werden.");
  }
  const location = Array.isArray(geocode.payload?.results)
    ? geocode.payload.results[0]
    : null;
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw httpError(502, `Für die Postleitzahl ${postalCode} wurde kein Wetterstandort gefunden.`);
  }

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

const EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjIuMSDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPGxpbmsgcmVsPSJpY29uIiBocmVmPSJpY29uLTE5Mi5wbmciPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0ic3R5bGVzLmNzcz92PTYuMi4xIj4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwLXNoZWxsIj4KICA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPgogICAgPGRpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPjxzcGFuIGNsYXNzPSJicmFuZC1tYXJrIj7ijII8L3NwYW4+PHNwYW4+RWxkZWhvZjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3VidGl0bGUiPlZlcmJyYXVjaHNidWNoPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJidWlsZC1waWxsIj42LjIuMTwvc3Bhbj4KICA8L2hlYWRlcj4KCiAgPG1haW4+CiAgICA8ZGl2IGlkPSJyZWNvdmVyeUJhbm5lciIgY2xhc3M9ImJhbm5lciB3YXJuaW5nIGhpZGRlbiIgcm9sZT0ic3RhdHVzIj4KICAgICAgPGRpdj48c3Ryb25nPkxva2FsZSBTaWNoZXJoZWl0c2tvcGllIGdlZnVuZGVuPC9zdHJvbmc+PHNwYW4+RGVyIG5vcm1hbGUgTW9uYXRzZGF0ZW5zcGVpY2hlciBpc3QgbGVlciwgYWJlciBlaW5lIGZyw7xoZXJlIGxva2FsZSBLb3BpZSBpc3Qgdm9yaGFuZGVuLjwvc3Bhbj48L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0icmVzdG9yZVNoYWRvd0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldpZWRlcmhlcnN0ZWxsZW48L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IGFjdGl2ZSIgaWQ9ImRhc2hib2FyZFZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGFzaGJvYXJkVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPsOcQkVSU0lDSFQ8L3NwYW4+PGgxIGlkPSJkYXNoYm9hcmRUaXRsZSI+VmVyYnJhdWNoIGF1ZiBlaW5lbiBCbGljazwvaDE+PHA+TnVyIGRhcyBXZXNlbnRsaWNoZTogWsOkaGxlcnN0w6RuZGUsIFfDpHJtZXB1bXBlIHVuZCBPc3Ryb20tUHJlaXNlLjwvcD48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBpZD0iZGFzaGJvYXJkQWRkQnRuIiB0eXBlPSJidXR0b24iPisgWsOkaGxlcnN0w6RuZGU8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgbGF0ZXN0LXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5MRVRaVEVSIE1PTkFUPC9zcGFuPjxoMiBpZD0ibGF0ZXN0TW9udGhUaXRsZSI+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZTwvaDI+PC9kaXY+PGJ1dHRvbiBpZD0iZWRpdExhdGVzdEJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IGhpZGRlbiIgdHlwZT0iYnV0dG9uIj5CZWFyYmVpdGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQiIGlkPSJsYXRlc3RNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0iY29tcGFyaXNvbi1saW5lIiBpZD0ibGF0ZXN0Q29tcGFyaXNvbiI+PC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgb3N0cm9tLXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj4KICAgICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0PC9oMj48c21hbGwgaWQ9Im9zdHJvbVN0YXR1cyI+Tm9jaCBuaWNodCBnZWxhZGVuPC9zbWFsbD48L2Rpdj4KICAgICAgICAgIDxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5Ba3R1YWxpc2llcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0ib3N0cm9tU2V0dXBIaW50IiBjbGFzcz0iZW1wdHktc3RhdGUgaGlkZGVuIj48c3Ryb25nPk9zdHJvbSBpc3Qgbm9jaCBuaWNodCBlaW5nZXJpY2h0ZXQuPC9zdHJvbmc+PHNwYW4+RGVuIEVsZGVob2YtQXBwLVNjaGzDvHNzZWwgZmluZGVzdCBkdSB1bnRlciBEYXRlbiDihpIgT3N0cm9tLjwvc3Bhbj48YnV0dG9uIGlkPSJnb09zdHJvbVNldHRpbmdzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+RWlucmljaHRlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9Im9zdHJvbURhc2hib2FyZCIgY2xhc3M9Im9zdHJvbS1ncmlkIj4KICAgICAgICAgIDxhcnRpY2xlIGNsYXNzPSJwcmljZS1jYXJkIGN1cnJlbnQiPjxzcGFuPkFrdHVlbGxlciBQcmVpczwvc3Bhbj48c3Ryb25nIGlkPSJvc3Ryb21DdXJyZW50UHJpY2UiPuKAkzwvc3Ryb25nPjxzbWFsbCBpZD0ib3N0cm9tQ3VycmVudE1ldGEiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgPGFydGljbGUgY2xhc3M9InByaWNlLWNhcmQgYmVzdCI+PHNwYW4gaWQ9Im9zdHJvbUJlc3RMYWJlbCI+QmVzdGVzIFplaXRmZW5zdGVyPC9zcGFuPjxzdHJvbmcgaWQ9Im9zdHJvbUJlc3RQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21CZXN0TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8YXJ0aWNsZSBjbGFzcz0icHJpY2UtY2FyZCB3b3JzdCI+PHNwYW4gaWQ9Im9zdHJvbVdvcnN0TGFiZWwiPlNjaGxlY2h0ZXN0ZXMgWmVpdGZlbnN0ZXI8L3NwYW4+PHN0cm9uZyBpZD0ib3N0cm9tV29yc3RQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21Xb3JzdE1ldGEiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgcHJpY2UtY2hhcnQtd3JhcCI+PGNhbnZhcyBpZD0ib3N0cm9tTWluaUNoYXJ0IiBhcmlhLWxhYmVsPSJPc3Ryb20gUHJlaXN2ZXJsYXVmIj48L2NhbnZhcz48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGRhc2hib2FyZC1jaGFydC1wYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+VkVSTEFVRjwvc3Bhbj48aDI+R2VzYW10dmVyYnJhdWNoPC9oMj48L2Rpdj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgZGF0YS1uYXY9ImFuYWx5c2lzVmlldyIgdHlwZT0iYnV0dG9uIj5BdXN3ZXJ0dW5nIMO2ZmZuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC13cmFwIj48Y2FudmFzIGlkPSJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IiBhcmlhLWxhYmVsPSJHZXNhbXR2ZXJicmF1Y2ggZGVyIGxldHp0ZW4gTW9uYXRlIj48L2NhbnZhcz48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iY29uc3VtcHRpb25WaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImNvbnN1bXB0aW9uVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlZFUkJSQVVDSDwvc3Bhbj48aDEgaWQ9ImNvbnN1bXB0aW9uVGl0bGUiPk1vbmF0c3dlcnRlPC9oMT48cD5HZXNhbXQtIHVuZCBBbHRlbnRlaWwtVmVyYnJhdWNoIGVudHN0ZWhlbiBhdXMgZGVuIFrDpGhsZXJzdMOkbmRlbi4gV8Okcm1lcHVtcGUga29tbXQgYXVzIGRlciBteVZBSUxMQU5ULUNTVjsgU2NobGVlL0tsdXMgd2lyZCBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJhZGRSZWNvcmRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdG9vbGJhciI+PHN0cm9uZyBpZD0icmVjb3JkQ291bnQiPjAgTW9uYXRlPC9zdHJvbmc+PHNlbGVjdCBpZD0icmVjb3JkWWVhckZpbHRlciIgYXJpYS1sYWJlbD0iSmFociBmaWx0ZXJuIj48b3B0aW9uIHZhbHVlPSJhbGwiPkFsbGUgSmFocmU8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJyZWNvcmRMaXN0IiBjbGFzcz0icmVjb3JkLWxpc3QiPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJhbmFseXNpc1ZpZXciIGFyaWEtbGFiZWxsZWRieT0iYW5hbHlzaXNUaXRsZSI+CiAgICAgIDxkaXYgY2xhc3M9InBhZ2UtaGVhZCI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+QVVTV0VSVFVORzwvc3Bhbj48aDEgaWQ9ImFuYWx5c2lzVGl0bGUiPlZlcmJyYXVjaCB2ZXJzdGVoZW48L2gxPjxwPkphaHJlc3dlcnRlLCBBdWZ0ZWlsdW5nLCBLb3N0ZW4gdW5kIFfDpHJtZXB1bXBlbi1FZmZpemllbnouPC9wPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGZpbHRlci1wYW5lbCI+CiAgICAgICAgPGxhYmVsPkRldGFpbGphaHI8c2VsZWN0IGlkPSJhbmFseXNpc1llYXIiPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0iYW5hbHlzaXMtYWxsLXllYXJzLWhpbnQiPjxzdHJvbmc+TWVocmphaHJlc3ZlcmdsZWljaDwvc3Ryb25nPjxzcGFuPkFsbGUgdm9yaGFuZGVuZW4gSmFocmUgd2VyZGVuIGdlbWVpbnNhbSBkYXJnZXN0ZWxsdC4gVmVyZ2FuZ2VuZSBKYWhyZSBnZXN0cmljaGVsdCwgZGFzIGFrdHVlbGxlIEphaHIgZHVyY2hnZXpvZ2VuLjwvc3Bhbj48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0ibWV0cmljLWdyaWQgYW5hbHlzaXMtbWV0cmljcyIgaWQ9ImFuYWx5c2lzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkFVRlRFSUxVTkc8L3NwYW4+PGgyPlfDpHJtZXB1bXBlIMK3IEFsdGVudGVpbCDCtyBTY2hsZWUvS2x1czwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ibGVnZW5kIj48c3BhbiBjbGFzcz0iaGVhdCI+V8Okcm1lcHVtcGU8L3NwYW4+PHNwYW4gY2xhc3M9ImFubmV4Ij5BbHRlbnRlaWw8L3NwYW4+PHNwYW4gY2xhc3M9InJlc3QiPlNjaGxlZS9LbHVzPC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImFsbG9jYXRpb25DaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1FSFJKQUhSRVNWRVJHTEVJQ0g8L3NwYW4+PGgyPkdlc2FtdHZlcmJyYXVjaCBuYWNoIE1vbmF0ZW48L2gyPjwvZGl2PjwvZGl2PjxkaXYgaWQ9InllYXJDb21wYXJpc29uTGVnZW5kIiBjbGFzcz0ieWVhci1jb21wYXJpc29uLWxlZ2VuZCI+PC9kaXY+PGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBsYXJnZSI+PGNhbnZhcyBpZD0idG90YWxDaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJvc3Ryb21QcmljZVN0YXRzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTS1QUkVJU0U8L3NwYW4+PGgyPsOYIGtXaC1QcmVpcyDCtyBNb25hdCDCtyBRdWFydGFsIMK3IEphaHI8L2gyPjwvZGl2PjxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21QcmljZVN0YXRzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+T3N0cm9tLVByZWlzZSBha3R1YWxpc2llcmVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EZXIgQXJiZWl0c3ByZWlzIHdpcmQgYXVzIGRlbiB2b24gT3N0cm9tIGdlbGllZmVydGVuIFN0dW5kZW5wcmVpc2VuIHVuZCBkZWluZW0gdGF0c8OkY2hsaWNoZW4gT3N0cm9tLVZlcmJyYXVjaCB2ZXJicmF1Y2hzZ2V3aWNodGV0IGJlcmVjaG5ldC4gUXVhcnRhbHMtIHVuZCBKYWhyZXN3ZXJ0ZSBzaW5kIGRhaGVyIGtlaW4gZWluZmFjaGVyIE1pdHRlbHdlcnQgZGVyIE1vbmF0ZS48L3A+CiAgICAgICAgPHNlY3Rpb24gY2xhc3M9Im1ldHJpYy1ncmlkIGFuYWx5c2lzLW1ldHJpY3MiIGlkPSJvc3Ryb21QcmljZVN0YXRzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9Im9zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0IiBhcmlhLWxhYmVsPSJEdXJjaHNjaG5pdHRsaWNoZXIgT3N0cm9tLUFyYmVpdHNwcmVpcyBwcm8gTW9uYXQiPjwvY2FudmFzPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk1vbmF0PC90aD48dGg+w5ggQXJiZWl0c3ByZWlzPC90aD48dGg+RWZmZWt0aXYgaW5rbC4gRml4a29zdGVuPC90aD48dGg+T3N0cm9tLVZlcmJyYXVjaDwvdGg+PHRoPlN0YXR1czwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0ib3N0cm9tUHJpY2VTdGF0c1RhYmxlIj48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgICAgPHAgaWQ9Im9zdHJvbVByaWNlU3RhdHNTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+PC9wPgogICAgICA8L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5Nb25hdGxpY2hlIFN0cm9ta29zdGVuPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJjb3N0Q2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0iY29wUGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlfDhFJNRVBVTVBFPC9zcGFuPjxoMj5BcmJlaXRzemFobDwvaDI+PC9kaXY+PC9kaXY+PHAgY2xhc3M9Im11dGVkIj5XaXJkIG51ciBhdXMgTW9uYXRlbiBtaXQgZG9rdW1lbnRpZXJ0ZXIgZXJ6ZXVndGVyIFfDpHJtZSBiZXJlY2huZXQuPC9wPjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImNvcENoYXJ0Ij48L2NhbnZhcz48L2Rpdj48L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+TU9OQVRFPC9zcGFuPjxoMj5KYWhyZXPDvGJlcnNpY2h0PC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPkdlc2FtdDwvdGg+PHRoPldQPC90aD48dGg+QWx0ZW50ZWlsPC90aD48dGg+U2NobGVlL0tsdXM8L3RoPjx0aD5Lb3N0ZW48L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImFuYWx5c2lzVGFibGUiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj48L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJkYXRhVmlldyIgYXJpYS1sYWJlbGxlZGJ5PSJkYXRhVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkRBVEVOPC9zcGFuPjxoMSBpZD0iZGF0YVRpdGxlIj5CYWNrdXAgJiBFaW5zdGVsbHVuZ2VuPC9oMT48cD5aw6RobGVyc3TDpG5kZSwgbXlWQUlMTEFOVC1JbXBvcnQsIFNpY2hlcnVuZyB1bmQgT3N0cm9tLjwvcD48L2Rpdj48L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+REFURU5RVUFMSVTDhFQ8L3NwYW4+PGgyPk1vbmF0c3dlcnRlIHByw7xmZW48L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIGNvbXBhY3QtbWV0cmljcyIgaWQ9InF1YWxpdHlNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJxdWFsaXR5SXNzdWVzIiBjbGFzcz0iaXNzdWUtbGlzdCI+PC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KCgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJtZXRlclBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDI+R2VzYW10ICYgQWx0ZW50ZWlsPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJhZGRNZXRlckJ0biIgY2xhc3M9InByaW1hcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj4rIEVpbnRyYWdlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RHUgdHLDpGdzdCBudXIgZGllIGJlaWRlbiBha3R1ZWxsZW4gWsOkaGxlcnN0w6RuZGUgZWluLiBFbGRlaG9mIGJlcmVjaG5ldCBkYXJhdXMgYXV0b21hdGlzY2ggZGVuIE1vbmF0c3ZlcmJyYXVjaC4gQXVzZ2FuZ3NwdW5rdCBpc3QgZGVyIDAxLjEwLjIwMjYgbWl0IEdlc2FtdCAzNC4yNTUga1doIHVuZCBBbHRlbnRlaWwgOS4wNDUga1doLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBtZXRlci1sYXRlc3QiIGlkPSJtZXRlckxhdGVzdCI+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibWV0ZXJIaXN0b3J5IiBjbGFzcz0ibWV0ZXItaGlzdG9yeSI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyBtZXRlci1hY3Rpb25zIj48YnV0dG9uIGlkPSJ1bmRvTGF0ZXN0TWV0ZXJCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+TGV0enRlbiBaw6RobGVyc3RhbmQgenVyw7xja25laG1lbjwvYnV0dG9uPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJ2YWlsbGFudEltcG9ydFBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5Xw4RSTUVQVU1QRTwvc3Bhbj48aDI+bXlWQUlMTEFOVC1EYXRlbiBpbXBvcnRpZXJlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5Xw6RobGUgZGllIGV4cG9ydGllcnRlbiBDU1YtRGF0ZWllbiB2b24gYXJvVEhFUk0gdW5kIHVuaVRPV0VSLiBEYXJhdXMgw7xiZXJuaW1tdCBFbGRlaG9mIGRlbiBXw6RybWVwdW1wZW52ZXJicmF1Y2ggdW5kIGRpZSBXw6RybWVtZW5nZW4uIEdlc2FtdCB1bmQgQWx0ZW50ZWlsIGtvbW1lbiBhdXNzY2hsaWXDn2xpY2ggYXVzIGRlaW5lbiBaw6RobGVyc3TDpG5kZW4uPC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBwcmltYXJ5Ij5DU1YtRGF0ZWllbiBhdXN3w6RobGVuPGlucHV0IGlkPSJ2YWlsbGFudENzdkZpbGVzSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iLmNzdix0ZXh0L2Nzdix0ZXh0L3BsYWluIiBtdWx0aXBsZSBoaWRkZW4+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0idmFpbGxhbnRJbXBvcnRTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+Tm9jaCBrZWluZSBEYXRlaWVuIGF1c2dld8OkaGx0LjwvcD4KICAgICAgPC9zZWN0aW9uPgoKCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9InN5bmNQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+R0VSw4RURS1TWU5DPC9zcGFuPjxoMj5BdWYgYWxsZW4gR2Vyw6R0ZW4gYWt0dWVsbDwvaDI+PC9kaXY+PHNwYW4gaWQ9InN5bmNCYWRnZSIgY2xhc3M9InN5bmMtYmFkZ2UiPm5pY2h0IGVpbmdlcmljaHRldDwvc3Bhbj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkVsZGVob2Ygc3luY2hyb25pc2llcnQgTW9uYXRzd2VydGUsIFrDpGhsZXJzdMOkbmRlLCBpbXBvcnRpZXJ0ZSBWYWlsbGFudC1XZXJ0ZSB1bmQgYmVyZWNobmV0ZSBPc3Ryb20tS29zdGVuIHZlcnNjaGzDvHNzZWx0IMO8YmVyIGRlbiBiZXN0ZWhlbmRlbiBDbG91ZGZsYXJlLVRyZXNvci4gTmFjaCBlaW5lciDDhG5kZXJ1bmcgd2lyZCBhdXRvbWF0aXNjaCBob2NoZ2VsYWRlbjsgYmVpbSDDlmZmbmVuIG9kZXIgWnVyw7xja2tlaHJlbiBpbiBkaWUgQXBwIHdpcmQgYXV0b21hdGlzY2ggZGVyIG5ldWVzdGUgU3RhbmQgZ2VsYWRlbi48L3A+CiAgICAgICAgPGRpdiBpZD0ic3luY1NldHVwQm94Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5EaWVzZXMgR2Vyw6R0IGJlbmVubmVuPGlucHV0IGlkPSJzeW5jQ3JlYXRlRGV2aWNlTmFtZSIgdHlwZT0idGV4dCIgbWF4bGVuZ3RoPSI2MCIgcGxhY2Vob2xkZXI9InouIEIuIGlQYWQgS8O8Y2hlIj48L2xhYmVsPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzeW5jQ3JlYXRlQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5HZXLDpHRlLVN5bmMgZWlucmljaHRlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRldGFpbHMgY2xhc3M9InN5bmMtam9pbi1ib3giPjxzdW1tYXJ5PkRpZXNlcyBHZXLDpHQgbWl0IGJlc3RlaGVuZGVtIEVsZGVob2Yga29wcGVsbjwvc3VtbWFyeT4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+VHJlc29yLUlEPGlucHV0IGlkPSJzeW5jSm9pblZhdWx0SWQiIHR5cGU9InRleHQiIGF1dG9jb21wbGV0ZT0ib2ZmIj48L2xhYmVsPgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPktvcHBsdW5nc2NvZGU8aW5wdXQgaWQ9InN5bmNKb2luQ29kZSIgdHlwZT0idGV4dCIgYXV0b2NvbXBsZXRlPSJvbmUtdGltZS1jb2RlIiBwbGFjZWhvbGRlcj0iWFhYWC1YWFhYLVhYWFgiPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+V2llZGVyaGVyc3RlbGx1bmdzc2NobMO8c3NlbDx0ZXh0YXJlYSBpZD0ic3luY0pvaW5SZWNvdmVyeSIgcm93cz0iMyIgYXV0b2NvbXBsZXRlPSJvZmYiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5EaWVzZXMgR2Vyw6R0IGJlbmVubmVuPGlucHV0IGlkPSJzeW5jSm9pbkRldmljZU5hbWUiIHR5cGU9InRleHQiIG1heGxlbmd0aD0iNjAiIHBsYWNlaG9sZGVyPSJ6LiBCLiBpUGhvbmUiPjwvbGFiZWw+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8YnV0dG9uIGlkPSJzeW5jSm9pbkJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+R2Vyw6R0IGtvcHBlbG48L2J1dHRvbj4KICAgICAgICAgIDwvZGV0YWlscz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJzeW5jQWN0aXZlQm94IiBjbGFzcz0iaGlkZGVuIj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIHN5bmMtbWV0cmljcyI+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPkdlcsOkdDwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jRGV2aWNlVGV4dCI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJzeW5jUm9sZVRleHQiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgICA8YXJ0aWNsZT48c3Bhbj5UcmVzb3ItVmVyc2lvbjwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jUmV2aXNpb25UZXh0Ij4wPC9zdHJvbmc+PHNtYWxsIGlkPSJzeW5jTGFzdFRleHQiPm5vY2ggbmllPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPkF1dG9tYXRpazwvc3Bhbj48c3Ryb25nPmFrdGl2PC9zdHJvbmc+PHNtYWxsPmJlaSBBcHAtU3RhcnQsIFLDvGNra2VociB1bmQgbmFjaCDDhG5kZXJ1bmdlbjwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzeW5jTm93QnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5KZXR6dCBzeW5jaHJvbmlzaWVyZW48L2J1dHRvbj48YnV0dG9uIGlkPSJzeW5jUGFpckJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5OZXVlcyBHZXLDpHQga29wcGVsbjwvYnV0dG9uPjxidXR0b24gaWQ9InN5bmNEaXNjb25uZWN0QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkRpZXNlcyBHZXLDpHQgdHJlbm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRpdiBpZD0ic3luY1BhaXJSZXN1bHQiIGNsYXNzPSJzeW5jLXBhaXItcmVzdWx0IGhpZGRlbiI+PHN0cm9uZz5Lb3BwbHVuZ3NkYXRlbiBmw7xyIGRhcyBuZXVlIEdlcsOkdDwvc3Ryb25nPjxzcGFuPlRyZXNvci1JRDwvc3Bhbj48Y29kZSBpZD0ic3luY1BhaXJWYXVsdCI+4oCTPC9jb2RlPjxzcGFuPkNvZGUgKDEwIE1pbnV0ZW4pPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpckNvZGUiPuKAkzwvY29kZT48c3Bhbj5XaWVkZXJoZXJzdGVsbHVuZ3NzY2hsw7xzc2VsPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpclJlY292ZXJ5Ij7igJM8L2NvZGU+PHNtYWxsIGlkPSJzeW5jUGFpckV4cGlyeSI+PC9zbWFsbD48L2Rpdj4KICAgICAgICAgIDxwIGlkPSJzeW5jU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgICA8L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5TSUNIRVJVTkc8L3NwYW4+PGgyPlByaXZhdGVzIEJhY2t1cDwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EYXMgcHJpdmF0ZSBCYWNrdXAgZW50aMOkbHQgZGVpbmUgVmVyYnJhdWNoc2RhdGVuIHVuZCDigJMgc29mZXJuIGdlc3BlaWNoZXJ0IOKAkyBhdWNoIGRlbiBPc3Ryb20tQXBwLVNjaGzDvHNzZWwuIE5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbi48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRCYWNrdXBCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkJhY2t1cCBleHBvcnRpZXJlbjwvYnV0dG9uPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBzZWNvbmRhcnkiPkJhY2t1cCBpbXBvcnRpZXJlbjxpbnB1dCBpZD0iaW1wb3J0QmFja3VwSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iYXBwbGljYXRpb24vanNvbiwuanNvbiIgaGlkZGVuPjwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRDc3ZCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+Q1NWIGV4cG9ydGllcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPHAgaWQ9ImJhY2t1cFN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im9zdHJvbVNldHRpbmdzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0IHZlcmJpbmRlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+RWxkZWhvZi1BcHAtU2NobMO8c3NlbDxpbnB1dCBpZD0ib3N0cm9tQXBwS2V5SW5wdXQiIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9Im9mZiIgcGxhY2Vob2xkZXI9IkFwcC1TY2hsw7xzc2VsIj48L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+WmVpdGZlbnN0ZXI8c2VsZWN0IGlkPSJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0Ij48b3B0aW9uIHZhbHVlPSIxIj4xIFN0dW5kZTwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjIiPjIgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjMiPjMgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjQiPjQgU3R1bmRlbjwvb3B0aW9uPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InN3aXRjaC1yb3ciPjxpbnB1dCBpZD0ib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIgdHlwZT0iY2hlY2tib3giPjxzcGFuPkF1dG9tYXRpc2NoIGFsbGUgMTAgTWludXRlbiBha3R1YWxpc2llcmVuPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+PGJ1dHRvbiBpZD0ic2F2ZU9zdHJvbUJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuICYgcHLDvGZlbjwvYnV0dG9uPjxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21IaXN0b3J5QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkhpc3RvcmlzY2hlIFByZWlzZSBsYWRlbjwvYnV0dG9uPjxidXR0b24gaWQ9ImRpc2Nvbm5lY3RPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+VmVyYmluZHVuZyBlbnRmZXJuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBpZD0ib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgICAgPHAgaWQ9Im9zdHJvbUhpc3RvcnlTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+SGlzdG9yaXNjaGUgUHJlaXNlIG5vY2ggbmljaHQgZ2VwcsO8ZnQuPC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPktPU1RFTjwvc3Bhbj48aDI+RmFsbGJhY2stV2VydGU8L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QXJiZWl0c3ByZWlzIOKCrC9rV2g8aW5wdXQgaWQ9ImZhbGxiYWNrUHJpY2VJbnB1dCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+TW9uYXRsaWNoZSBGaXhrb3N0ZW4g4oKsPGlucHV0IGlkPSJkZWZhdWx0QmFzZUZlZUlucHV0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMSI+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJzYXZlQ29zdFNldHRpbmdzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPlNwZWljaGVybjwvYnV0dG9uPgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CiAgPC9tYWluPgoKICA8bmF2IGNsYXNzPSJib3R0b20tbmF2IiBhcmlhLWxhYmVsPSJIYXVwdG5hdmlnYXRpb24iPgogICAgPGJ1dHRvbiBjbGFzcz0iYWN0aXZlIiBkYXRhLW5hdj0iZGFzaGJvYXJkVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7ijII8L3NwYW4+w5xiZXJzaWNodDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iY29uc3VtcHRpb25WaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKWpDwvc3Bhbj5WZXJicmF1Y2g8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS1uYXY9ImFuYWx5c2lzVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7ilqU8L3NwYW4+QXVzd2VydHVuZzwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iZGF0YVZpZXciIHR5cGU9ImJ1dHRvbiI+PHNwYW4+4pqZPC9zcGFuPkRhdGVuPC9idXR0b24+CiAgPC9uYXY+CjwvZGl2PgoKPGRpdiBpZD0icmVjb3JkTW9kYWwiIGNsYXNzPSJtb2RhbCBoaWRkZW4iIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbGxlZGJ5PSJyZWNvcmRNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWw+PC9kaXY+CiAgPGZvcm0gY2xhc3M9Im1vZGFsLWNhcmQiIGlkPSJyZWNvcmRGb3JtIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1PTkFUIEJFQVJCRUlURU48L3NwYW4+PGgyIGlkPSJyZWNvcmRNb2RhbFRpdGxlIj5Nb25hdCBiZWFyYmVpdGVuPC9oMj48L2Rpdj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imljb24tYnV0dG9uIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPGlucHV0IGlkPSJlZGl0aW5nTW9udGhPcmlnaW5hbCIgdHlwZT0iaGlkZGVuIj4KICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPk1vbmF0PGlucHV0IGlkPSJyZWNvcmRNb250aCIgdHlwZT0ibW9udGgiIHJlYWRvbmx5PjwvbGFiZWw+CiAgICAgIDxzcGFuPjwvc3Bhbj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+R2VzYW10dmVyYnJhdWNoIGtXaDxpbnB1dCBpZD0icmVjb3JkVG90YWwiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIj48L2xhYmVsPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BbHRlbnRlaWwga1doPGlucHV0IGlkPSJyZWNvcmRBbm5leCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPlfDpHJtZXB1bXBlIGtXaDxpbnB1dCBpZD0icmVjb3JkSGVhdFB1bXAiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIj48L2xhYmVsPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj7DmCBTdHJvbXByZWlzIGN0L2tXaDxpbnB1dCBpZD0icmVjb3JkUHJpY2VDdCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkZpeGtvc3RlbiDigqw8aW5wdXQgaWQ9InJlY29yZEJhc2VGZWUiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9ImRlcml2ZWRQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5TY2hsZWUvS2x1czog4oCTPC9kaXY+CiAgICA8cCBpZD0icmVjb3JkU291cmNlSGludCIgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+PC9wPgogICAgPGRldGFpbHMgY2xhc3M9ImRldGFpbHMtY2FyZCI+PHN1bW1hcnk+V8Okcm1lcHVtcGVuLURldGFpbHMgKG9wdGlvbmFsKTwvc3VtbWFyeT48ZGl2IGNsYXNzPSJmb3JtLWdyaWQgZGV0YWlsLWdyaWQiPjxsYWJlbCBjbGFzcz0iZmllbGQiPkVyemV1Z3RlIFfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRHZW5lcmF0ZWQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48bGFiZWwgY2xhc3M9ImZpZWxkIj5IZWl6c3Ryb20ga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48bGFiZWwgY2xhc3M9ImZpZWxkIj5XYXJtd2Fzc2Vyc3Ryb20ga1doPGlucHV0IGlkPSJyZWNvcmREaHdFbGVjdHJpY2l0eSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPkhlaXp3w6RybWUga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0aW5nSGVhdCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPldhcm13YXNzZXJ3w6RybWUga1doPGlucHV0IGlkPSJyZWNvcmREaHdIZWF0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PC9kaXY+PC9kZXRhaWxzPgogICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+Tm90aXo8dGV4dGFyZWEgaWQ9InJlY29yZE5vdGUiIHJvd3M9IjMiIG1heGxlbmd0aD0iODAwIj48L3RleHRhcmVhPjwvbGFiZWw+CiAgICA8cCBpZD0icmVjb3JkVmFsaWRhdGlvbiIgY2xhc3M9InZhbGlkYXRpb24tdGV4dCI+PC9wPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+PHNwYW4gY2xhc3M9InNwYWNlciI+PC9zcGFuPjxidXR0b24gY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbD5BYmJyZWNoZW48L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJzdWJtaXQiPsOEbmRlcnVuZ2VuIHNwZWljaGVybjwvYnV0dG9uPjwvZGl2PgogIDwvZm9ybT4KPC9kaXY+Cgo8ZGl2IGlkPSJtZXRlck1vZGFsIiBjbGFzcz0ibW9kYWwgaGlkZGVuIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWxsZWRieT0ibWV0ZXJNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbD48L2Rpdj4KICA8Zm9ybSBjbGFzcz0ibW9kYWwtY2FyZCIgaWQ9Im1ldGVyRm9ybSI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDIgaWQ9Im1ldGVyTW9kYWxUaXRsZSI+TmV1ZSBBYmxlc3VuZzwvaDI+PC9kaXY+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJpY29uLWJ1dHRvbiIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPHAgaWQ9Im1ldGVyUHJldmlvdXMiIGNsYXNzPSJtZXRlci1wcmV2aW91cyI+PC9wPgogICAgPHAgaWQ9Im1ldGVyVGFyZ2V0TW9udGgiIGNsYXNzPSJtdXRlZCI+PC9wPgogICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QWJsZXNlZGF0dW08aW5wdXQgaWQ9Im1ldGVyRGF0ZSIgdHlwZT0iZGF0ZSIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgPHNwYW4+PC9zcGFuPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5HZXNhbXQtWsOkaGxlcnN0YW5kIGtXaDxpbnB1dCBpZD0ibWV0ZXJUb3RhbCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiIHJlcXVpcmVkPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkFsdGVudGVpbC1aw6RobGVyc3RhbmQga1doPGlucHV0IGlkPSJtZXRlckFubmV4IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0ibWV0ZXJQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5Nb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXV0b21hdGlzY2ggYmVyZWNobmV0LjwvZGl2PgogICAgPHAgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+RGllIFfDpHJtZXB1bXBlIHdpcmQgbmljaHQgaGllciBlaW5nZXRyYWdlbi4gU2llIGtvbW10IGF1c3NjaGxpZcOfbGljaCBhdXMgZGVtIG15VkFJTExBTlQtQ1NWLUltcG9ydC48L3A+CiAgICA8cCBpZD0ibWV0ZXJWYWxpZGF0aW9uIiBjbGFzcz0idmFsaWRhdGlvbi10ZXh0Ij48L3A+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj48c3BhbiBjbGFzcz0ic3BhY2VyIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iIGRhdGEtY2xvc2UtbWV0ZXItbW9kYWw+QWJicmVjaGVuPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgdHlwZT0ic3VibWl0Ij5aw6RobGVyc3TDpG5kZSBzcGVpY2hlcm48L2J1dHRvbj48L2Rpdj4KICA8L2Zvcm0+CjwvZGl2PgoKPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJ0b2FzdCBoaWRkZW4iIHJvbGU9InN0YXR1cyIgYXJpYS1saXZlPSJwb2xpdGUiPjwvZGl2Pgo8c2NyaXB0IHNyYz0iYXBwLmpzP3Y9Ni4yLjEiPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K","type":"text/html; charset=utf-8","cache":"no-cache"},"/styles.css":{"body":"OnJvb3R7CiAgY29sb3Itc2NoZW1lOmRhcms7CiAgLS1iZzojMDYxMDFjOwogIC0tcGFuZWw6IzBjMWEyYTsKICAtLXBhbmVsMjojMTAyMjM1OwogIC0tbGluZTpyZ2JhKDE3MSwxOTgsMjIwLC4xNCk7CiAgLS10ZXh0OiNmNGY4ZmI7CiAgLS1tdXRlZDojOTRhOGJhOwogIC0tZ3JlZW46IzcyZGM1NzsKICAtLW9yYW5nZTojZmY5ZjQzOwogIC0tYmx1ZTojNGQ5Y2ZmOwogIC0teWVsbG93OiNmMmQxNWY7CiAgLS1yZWQ6I2ZmNmI2YjsKICAtLXNoYWRvdzowIDE4cHggNTVweCByZ2JhKDAsMCwwLC4yNCk7CiAgLS1yYWRpdXM6MjBweDsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbHtiYWNrZ3JvdW5kOnZhcigtLWJnKTttaW4taGVpZ2h0OjEwMCU7Zm9udC1mYW1pbHk6SW50ZXIsLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixzYW5zLXNlcmlmOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQpib2R5e21hcmdpbjowO2JhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCB0b3AgcmlnaHQscmdiYSg2MCwxMjAsMTcwLC4xMCksdHJhbnNwYXJlbnQgMzUlKSx2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7bWluLWhlaWdodDoxMDB2aH0KYnV0dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXR9CmJ1dHRvbntjdXJzb3I6cG9pbnRlcn0KYnV0dG9uOmRpc2FibGVke29wYWNpdHk6LjQ4O2N1cnNvcjpub3QtYWxsb3dlZH0KLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQouYXBwLXNoZWxse21heC13aWR0aDoxMTgwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjAgMjJweCAxMTJweH0KLnRvcGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6Y2FsYygxNnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKSAwIDE4cHg7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MzA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQodG8gYm90dG9tLHJnYmEoNiwxNiwyOCwuOTgpLHJnYmEoNiwxNiwyOCwuODYpLHJnYmEoNiwxNiwyOCwwKSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCl9Ci5icmFuZHtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0Ojg1MDtsZXR0ZXItc3BhY2luZzotLjAzZW19LmJyYW5kLW1hcmt7ZGlzcGxheTppbmxpbmUtZ3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6MzZweDtoZWlnaHQ6MzZweDtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxZTYzMzMsIzJmOGU0OSk7Ym94LXNoYWRvdzowIDZweCAyNHB4IHJnYmEoNTMsMTkwLDkxLC4xOCl9Ci5zdWJ0aXRsZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWxlZnQ6NDZweDttYXJnaW4tdG9wOi00cHh9LmJ1aWxkLXBpbGx7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4xMik7Y29sb3I6I2I5ZjVhYTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTE0LDIyMCw4NywuMjIpO3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLXJhZGl1czo5OTlweH0KbWFpbntkaXNwbGF5OmJsb2NrfS52aWV3e2Rpc3BsYXk6bm9uZTthbmltYXRpb246ZmFkZSAuMThzIGVhc2V9LnZpZXcuYWN0aXZle2Rpc3BsYXk6YmxvY2t9QGtleWZyYW1lcyBmYWRle2Zyb217b3BhY2l0eTouNTt0cmFuc2Zvcm06dHJhbnNsYXRlWSg0cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5wYWdlLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDoyMnB4O21hcmdpbjoxOHB4IDAgMjRweH0ucGFnZS1oZWFkIGgxe2ZvbnQtc2l6ZTpjbGFtcCgyOHB4LDV2dyw0NHB4KTttYXJnaW46M3B4IDAgN3B4O2xpbmUtaGVpZ2h0OjEuMDU7bGV0dGVyLXNwYWNpbmc6LS4wNGVtfS5wYWdlLWhlYWQgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7bWF4LXdpZHRoOjY4MHB4O2xpbmUtaGVpZ2h0OjEuNX0uZXllYnJvd3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xNmVtO2ZvbnQtd2VpZ2h0Ojg1MDtjb2xvcjojN2Y5ZGI0O21hcmdpbi1ib3R0b206NXB4fQoucGFuZWx7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHJnYmEoMTUsMzEsNDgsLjk2KSxyZ2JhKDEwLDI0LDM5LC45OCkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjE4cHg7Ym94LXNoYWRvdzp2YXIoLS1zaGFkb3cpfQoucGFuZWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE4cHh9LnBhbmVsLWhlYWQgaDJ7bWFyZ2luOjJweCAwIDJweDtmb250LXNpemU6MjFweDtsZXR0ZXItc3BhY2luZzotLjAyNWVtfS5wYW5lbC1oZWFkIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0KLnByaW1hcnksLnNlY29uZGFyeSwuZGFuZ2VyLC5maWxlLWJ1dHRvbnthcHBlYXJhbmNlOm5vbmU7Ym9yZGVyLXJhZGl1czoxM3B4O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnQ7cGFkZGluZzoxMXB4IDE1cHg7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLXRleHQpO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjhweDt0ZXh0LWRlY29yYXRpb246bm9uZTttaW4taGVpZ2h0OjQ0cHh9LnByaW1hcnl7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyZjhlNDksIzFmNmMzOCk7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMjgpO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDQ0LDE2MSw3NywuMTgpfS5wcmltYXJ5OmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMDYpfS5zZWNvbmRhcnksLmZpbGUtYnV0dG9ue2JhY2tncm91bmQ6IzEyMjYzYTtib3JkZXItY29sb3I6cmdiYSgxNzAsMjAwLDIyNCwuMTQpO2NvbG9yOiNkY2U5ZjN9LnNlY29uZGFyeTpob3ZlciwuZmlsZS1idXR0b246aG92ZXJ7YmFja2dyb3VuZDojMTczMDQ5fS5kYW5nZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xMCk7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjI1KTtjb2xvcjojZmZhYWE5fS5jb21wYWN0e21pbi1oZWlnaHQ6MzZweDtwYWRkaW5nOjhweCAxMXB4O2ZvbnQtc2l6ZToxM3B4fS5pY29uLWJ1dHRvbntib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjOWQ3ZTI7Zm9udC1zaXplOjMwcHg7bGluZS1oZWlnaHQ6MTtwYWRkaW5nOjAgNnB4fQoubWV0cmljLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNSxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxNnB4O21pbi13aWR0aDowfS5tZXRyaWMtZ3JpZCBhcnRpY2xlIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbTo3cHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZTpjbGFtcCgxOXB4LDN2dywyNnB4KTtsaW5lLWhlaWdodDoxLjE7ZGlzcGxheTpibG9jazt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Lm1ldHJpYy1ncmlkIGFydGljbGUgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojN2Y5NmFhO2ZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NnB4O2xpbmUtaGVpZ2h0OjEuMzV9LmNvbXBhcmlzb24tbGluZXttYXJnaW46MTVweCAwIDA7Y29sb3I6I2I4YzhkNTtmb250LXNpemU6MTNweH0uY29tcGFyaXNvbi1saW5lLnBvc2l0aXZle2NvbG9yOiNmZmIxYTh9LmNvbXBhcmlzb24tbGluZS5uZWdhdGl2ZXtjb2xvcjojYTVlNjlhfS5jb21wYXJpc29uLWxpbmUubmV1dHJhbHtjb2xvcjojYjhjOGQ1fQoub3N0cm9tLXBhbmVse292ZXJmbG93OmhpZGRlbn0ub3N0cm9tLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ucHJpY2UtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMGIxYjJiO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MThweH0ucHJpY2UtY2FyZDpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowIGF1dG8gMCAwO3dpZHRoOjRweDtiYWNrZ3JvdW5kOiM2ZDg1OTl9LnByaWNlLWNhcmQuYmVzdDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ncmVlbil9LnByaWNlLWNhcmQud29yc3Q6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tcmVkKX0ucHJpY2UtY2FyZC5jdXJyZW50OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLWJsdWUpfS5wcmljZS1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9LnByaWNlLWNhcmQgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjI3cHg7bWFyZ2luOjhweCAwIDRweH0ucHJpY2UtY2FyZCBzbWFsbHtjb2xvcjojOWNiMGMwfS5lbXB0eS1zdGF0ZXtib3JkZXI6MXB4IGRhc2hlZCByZ2JhKDE3MCwyMDAsMjI0LC4yKTtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjAyKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6OXB4IDE0cHg7YWxpZ24taXRlbXM6Y2VudGVyfS5lbXB0eS1zdGF0ZSBzdHJvbmd7d2lkdGg6MTAwJX0uZW1wdHktc3RhdGUgc3Bhbntjb2xvcjp2YXIoLS1tdXRlZCk7ZmxleDoxO21pbi13aWR0aDoyMDBweH0ucHJpY2UtY2hhcnQtd3JhcHttYXJnaW4tdG9wOjE2cHh9Ci5jaGFydC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDoyNjBweDt3aWR0aDoxMDAlO21pbi13aWR0aDowfS5jaGFydC13cmFwLmxhcmdle2hlaWdodDozNDBweH0uY2hhcnQtd3JhcCBjYW52YXN7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtkaXNwbGF5OmJsb2NrfS5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjI2MHB4fS5sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNXB4O21hcmdpbjotNnB4IDAgMTRweDtjb2xvcjojYjhjNmQyO2ZvbnQtc2l6ZToxMnB4fS5sZWdlbmQgc3BhbjpiZWZvcmV7Y29udGVudDoiIjtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjNweDttYXJnaW4tcmlnaHQ6NnB4fS5sZWdlbmQgLmhlYXQ6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tb3JhbmdlKX0ubGVnZW5kIC5hbm5leDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ibHVlKX0ubGVnZW5kIC5yZXN0OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyl9Ci5yZWNvcmQtdG9vbGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MTRweH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0LC5maWx0ZXItcGFuZWwgc2VsZWN0e2JhY2tncm91bmQ6IzBiMWEyYTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEwcHggMTJweH0ucmVjb3JkLWxpc3R7ZGlzcGxheTpncmlkO2dhcDoxMHB4fS5yZWNvcmQtcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6bWlubWF4KDE1MHB4LDEuM2ZyKSByZXBlYXQoNCxtaW5tYXgoOTBweCwuODVmcikpIGF1dG87Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGExOTI4O2JvcmRlci1yYWRpdXM6MTVweDtwYWRkaW5nOjEzcHggMTRweH0ucmVjb3JkLXJvdzpob3ZlcntiYWNrZ3JvdW5kOiMwZTIwMzJ9LnJlY29yZC1tb250aCBzdHJvbmd7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTVweH0ucmVjb3JkLW1vbnRoIHNtYWxse2Rpc3BsYXk6YmxvY2s7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6M3B4fS5yZWNvcmQtdmFsdWUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOiM3Zjk2YWE7Zm9udC1zaXplOjEwcHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wOGVtfS5yZWNvcmQtdmFsdWUgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kfS5yZWNvcmQtcm93LmludmFsaWR7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjMpfQouZmlsdGVyLXBhbmVse2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczplbmR9LmZpbHRlci1wYW5lbCBsYWJlbHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWluLXdpZHRoOjE1MHB4fS5hbmFseXNpcy1tZXRyaWNze21hcmdpbi1ib3R0b206MThweH0uYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDUsbWlubWF4KDAsMWZyKSl9Ci50YWJsZS1zY3JvbGx7b3ZlcmZsb3c6YXV0bztib3JkZXItcmFkaXVzOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzIwcHh9dGgsdGR7cGFkZGluZzoxMnB4IDEzcHg7dGV4dC1hbGlnbjpyaWdodDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmb250LXNpemU6MTNweH10aDpmaXJzdC1jaGlsZCx0ZDpmaXJzdC1jaGlsZHt0ZXh0LWFsaWduOmxlZnR9dGh7Zm9udC1zaXplOjExcHg7Y29sb3I6Izg4YTBiNTtsZXR0ZXItc3BhY2luZzouMDVlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7YmFja2dyb3VuZDojMGExOTI4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MH10Ym9keSB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLmNvbXBhY3QtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSl9Lmlzc3VlLWxpc3R7ZGlzcGxheTpncmlkO2dhcDo4cHg7bWFyZ2luLXRvcDoxNHB4fS5pc3N1ZXtkaXNwbGF5OmZsZXg7Z2FwOjEycHg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTJweCAxM3B4O2JvcmRlci1yYWRpdXM6MTNweDtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0uaXNzdWUud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yMil9Lmlzc3VlLmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4yNSl9Lmlzc3VlIGRpdnttaW4td2lkdGg6MH0uaXNzdWUgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEzcHh9Lmlzc3VlIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6M3B4fS5tdXRlZHtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS41NX0uYWN0aW9uLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5zdGF0dXMtdGV4dHttaW4taGVpZ2h0OjEuNGVtO21hcmdpbjoxMnB4IDAgMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHh9LnN0YXR1cy10ZXh0Lm9re2NvbG9yOiNhNWU2OWF9LnN0YXR1cy10ZXh0LmVycm9ye2NvbG9yOiNmZmFhYTl9LnNldHRpbmdzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTNweDttYXJnaW46MTRweCAwfS5maWVsZHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjojOWRiMGMwO2ZvbnQtc2l6ZToxMnB4fS5maWVsZCBpbnB1dCwuZmllbGQgc2VsZWN0LC5maWVsZCB0ZXh0YXJlYXt3aWR0aDoxMDAlO2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTcxLDE5OCwyMjAsLjE2KTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEycHg7b3V0bGluZTpub25lfS5maWVsZCBpbnB1dDpmb2N1cywuZmllbGQgc2VsZWN0OmZvY3VzLC5maWVsZCB0ZXh0YXJlYTpmb2N1c3tib3JkZXItY29sb3I6cmdiYSg3NywxNTYsMjU1LC41NSk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NywxNTYsMjU1LC4wOCl9LnN3aXRjaC1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjExcHggMTNweDtjb2xvcjojYzdkNWRmfS5zd2l0Y2gtcm93IGlucHV0e3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7YWNjZW50LWNvbG9yOiMzYzlhNTN9Ci5iYW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTZweDttYXJnaW46MTJweCAwIDE4cHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxNXB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGQyMDMyfS5iYW5uZXIud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yOCk7YmFja2dyb3VuZDpyZ2JhKDI0MiwyMDksOTUsLjA2KX0uYmFubmVyIHN0cm9uZywuYmFubmVyIHNwYW57ZGlzcGxheTpibG9ja30uYmFubmVyIHNwYW57Y29sb3I6I2IzYzBjYTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjNweH0KLmJvdHRvbS1uYXZ7cG9zaXRpb246Zml4ZWQ7ei1pbmRleDo0MDtsZWZ0OjUwJTtib3R0b206bWF4KDEycHgsZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7d2lkdGg6bWluKDYyMHB4LGNhbGMoMTAwJSAtIDI0cHgpKTtiYWNrZ3JvdW5kOnJnYmEoOCwyMCwzMywuOTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTYpO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjdweDtib3gtc2hhZG93OjAgMTZweCA1MHB4IHJnYmEoMCwwLDAsLjQyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxNnB4KX0uYm90dG9tLW5hdiBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojODU5OWFhO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjlweCA4cHg7ZGlzcGxheTpncmlkO2dhcDozcHg7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MDttaW4td2lkdGg6MH0uYm90dG9tLW5hdiBidXR0b24gc3Bhbntmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfS5ib3R0b20tbmF2IGJ1dHRvbi5hY3RpdmV7YmFja2dyb3VuZDojMTUzMTQ3O2NvbG9yOiNmNGY4ZmJ9Ci5tb2RhbHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7cGFkZGluZzoxOHB4fS5tb2RhbC1iYWNrZHJvcHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNzIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDVweCl9Lm1vZGFsLWNhcmR7cG9zaXRpb246cmVsYXRpdmU7d2lkdGg6bWluKDc2MHB4LDEwMCUpO21heC1oZWlnaHQ6Y2FsYygxMDB2aCAtIDM2cHgpO292ZXJmbG93OmF1dG87YmFja2dyb3VuZDojMGIxYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTgpO2JvcmRlci1yYWRpdXM6MjJweDtwYWRkaW5nOjIycHg7Ym94LXNoYWRvdzowIDMwcHggOTBweCByZ2JhKDAsMCwwLC41NSl9Lm1vZGFsLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxOHB4fS5tb2RhbC1oZWFkIGgye21hcmdpbjoycHggMCAwfS5mb3JtLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0uZGVyaXZlZC1wcmV2aWV3e21hcmdpbjoxNHB4IDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTJweCAxNHB4O2ZvbnQtd2VpZ2h0OjgwMH0uZGVyaXZlZC1wcmV2aWV3LmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zNSk7Y29sb3I6I2ZmYWFhOX0uZGV0YWlscy1jYXJke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbjoxMnB4IDA7YmFja2dyb3VuZDojMDgxNzI1fS5kZXRhaWxzLWNhcmQgc3VtbWFyeXtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjEycHggMTRweDtjb2xvcjojYzdkNWRmO2ZvbnQtd2VpZ2h0OjcwMH0uZGV0YWlscy1jYXJkIC5kZXRhaWwtZ3JpZHtwYWRkaW5nOjAgMTRweCAxNHB4fS52YWxpZGF0aW9uLXRleHR7bWluLWhlaWdodDoxLjJlbTtjb2xvcjojZmZhYWE5O2ZvbnQtc2l6ZToxMnB4fS5tb2RhbC1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OXB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjE2cHh9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntmbGV4OjF9Ci50b2FzdHtwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjE1MDtsZWZ0OjUwJTtib3R0b206MTAwcHg7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7YmFja2dyb3VuZDojMTkzNjRkO2NvbG9yOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIwMCwyMjAsMjM2LC4xNik7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTFweCAxNXB4O2JveC1zaGFkb3c6MCAxNnB4IDUwcHggcmdiYSgwLDAsMCwuNCk7bWF4LXdpZHRoOm1pbig5MHZ3LDU2MHB4KTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpey5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9LnJlY29yZC1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxNTBweCwxLjJmcikgcmVwZWF0KDIsbWlubWF4KDk1cHgsLjhmcikpIGF1dG99LnJlY29yZC1yb3cgLnJlY29yZC12YWx1ZTpudGgtb2YtdHlwZSg0KSwucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVlOm50aC1vZi10eXBlKDUpe2Rpc3BsYXk6bm9uZX0ub3N0cm9tLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnByaWNlLWNhcmQuY3VycmVudHtncmlkLWNvbHVtbjoxLy0xfS5jb21wYWN0LW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfX0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmFwcC1zaGVsbHtwYWRkaW5nOjAgMTJweCAxMDRweH0udG9wYmFye3BhZGRpbmctbGVmdDo0cHg7cGFkZGluZy1yaWdodDo0cHh9LmJyYW5ke2ZvbnQtc2l6ZToyMXB4fS5icmFuZC1tYXJre3dpZHRoOjMzcHg7aGVpZ2h0OjMzcHh9LnN1YnRpdGxle21hcmdpbi1sZWZ0OjQzcHh9LnBhZ2UtaGVhZHthbGlnbi1pdGVtczpzdHJldGNoO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjttYXJnaW4tdG9wOjlweH0ucGFnZS1oZWFkIC5wcmltYXJ5e3dpZHRoOjEwMCV9LnBhZ2UtaGVhZCBoMXtmb250LXNpemU6MzFweH0ucGFuZWx7cGFkZGluZzoxNnB4O2JvcmRlci1yYWRpdXM6MTdweDttYXJnaW4tYm90dG9tOjEzcHh9LnBhbmVsLWhlYWR7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5wYW5lbC1oZWFkIGgye2ZvbnQtc2l6ZToxOHB4fS5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsbWlubWF4KDAsMWZyKSk7Z2FwOjlweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtwYWRkaW5nOjEzcHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZToyMHB4fS5vc3Ryb20tZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5wcmljZS1jYXJkLmN1cnJlbnR7Z3JpZC1jb2x1bW46YXV0b30ucHJpY2UtY2FyZHtwYWRkaW5nOjE1cHh9LnByaWNlLWNhcmQgc3Ryb25ne2ZvbnQtc2l6ZToyNHB4fS5jaGFydC13cmFwLC5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjIyNXB4fS5jaGFydC13cmFwLmxhcmdle2hlaWdodDoyNzBweH0ucmVjb3JkLXRvb2xiYXJ7YWxpZ24taXRlbXM6c3RyZXRjaH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0e21heC13aWR0aDoxNDVweH0ucmVjb3JkLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjlweH0ucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVle2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9LnJlY29yZC1yb3cgLmVkaXQtcmVjb3Jke2dyaWQtY29sdW1uOjI7Z3JpZC1yb3c6MX0ucmVjb3JkLW1vbnRoIHNtYWxse21heC13aWR0aDoyMzBweH0uZmlsdGVyLXBhbmVse2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtwYWRkaW5nOjE0cHh9LmZpbHRlci1wYW5lbCBsYWJlbHttaW4td2lkdGg6MH0uc2V0dGluZ3MtZ3JpZCwuZm9ybS1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmRldGFpbHMtY2FyZCAuZGV0YWlsLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uYWN0aW9uLXJvdz4qe2ZsZXg6MSAxIDE1MHB4fS5ib3R0b20tbmF2e3dpZHRoOmNhbGMoMTAwJSAtIDE2cHgpO2JvdHRvbTptYXgoOHB4LGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7Ym9yZGVyLXJhZGl1czoxN3B4fS5ib3R0b20tbmF2IGJ1dHRvbntmb250LXNpemU6MTBweDtwYWRkaW5nOjhweCAzcHh9LmJvdHRvbS1uYXYgYnV0dG9uIHNwYW57Zm9udC1zaXplOjE4cHh9Lm1vZGFse3BhZGRpbmc6OHB4fS5tb2RhbC1jYXJke3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE4cHg7bWF4LWhlaWdodDpjYWxjKDEwMHZoIC0gMTZweCl9Lm1vZGFsLWFjdGlvbnN7ZmxleC13cmFwOndyYXB9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntkaXNwbGF5Om5vbmV9Lm1vZGFsLWFjdGlvbnMgYnV0dG9ue2ZsZXg6MSAxIDEyMHB4fS5iYW5uZXJ7YWxpZ24taXRlbXM6c3RyZXRjaDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59LmJhbm5lciBidXR0b257YWxpZ24tc2VsZjpmbGV4LXN0YXJ0fX0KQG1lZGlhKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsqe3Njcm9sbC1iZWhhdmlvcjphdXRvIWltcG9ydGFudDthbmltYXRpb246bm9uZSFpbXBvcnRhbnQ7dHJhbnNpdGlvbjpub25lIWltcG9ydGFudH19CgovKiBFbGRlaG9mIDYuMC4xIOKAkyBsb2thbGVyIG15VkFJTExBTlQtSW1wb3J0ICovCiN2YWlsbGFudEltcG9ydFBhbmVsIC5hY3Rpb24tcm93e21hcmdpbi10b3A6MTRweH0KI3ZhaWxsYW50SW1wb3J0U3RhdHVzLm9re2NvbG9yOiNhNWU2OWF9CiN2YWlsbGFudEltcG9ydFN0YXR1cy5lcnJvcntjb2xvcjojZmZhYWE5fQoKLyogRWxkZWhvZiA2LjEuMCDigJMgWsOkaGxlcnN0w6RuZGUgYWxzIGVpbnppZ2UgbWFudWVsbGUgVmVyYnJhdWNoc2VpbmdhYmUgKi8KLnJlY29yZC1zdGF0dXMtYmFkZ2V7anVzdGlmeS1zZWxmOmVuZDtmb250LXNpemU6MTFweDtjb2xvcjojOWRiMGMwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzo2cHggOHB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDojMDgxNzI1fQoubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfQoubWV0ZXItaGlzdG9yeXtkaXNwbGF5OmdyaWQ7Z2FwOjdweDttYXJnaW46MTRweCAwfS5tZXRlci1oaXN0b3J5LXJvd3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxMDBweCwxZnIpIHJlcGVhdCgyLG1pbm1heCgxMTBweCwxZnIpKSBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjEwcHggMTJweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiMwODE3MjU7Zm9udC1zaXplOjEycHh9Lm1ldGVyLWhpc3Rvcnktcm93IHNwYW4sLm1ldGVyLWhpc3Rvcnktcm93IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0ubWV0ZXItaGlzdG9yeS1yb3cgc3Ryb25ne2ZvbnQtc2l6ZToxMnB4fS5tZXRlci1hY3Rpb25ze21hcmdpbi10b3A6MTJweH0ubWV0ZXItcHJldmlvdXN7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1O2NvbG9yOiNiOWM3ZDI7bGluZS1oZWlnaHQ6MS41fS5jb21wYWN0LW5vdGV7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfS5tZXRlci1sYXRlc3QubWV0cmljLWdyaWQgYXJ0aWNsZTpmaXJzdC1jaGlsZHtncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0ubWV0ZXItaGlzdG9yeS1yb3cgc3BhbntncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvdyBzbWFsbHtkaXNwbGF5Om5vbmV9LnJlY29yZC1zdGF0dXMtYmFkZ2V7Zm9udC1zaXplOjEwcHh9fQoKLyogRWxkZWhvZiA2LjEuMSDigJMgTW9uYXRzd2VydGUgd2llZGVyIGJlYXJiZWl0YmFyICovCi5maWVsZCBpbnB1dFtyZWFkb25seV17b3BhY2l0eTouNzI7Y3Vyc29yOmRlZmF1bHQ7YmFja2dyb3VuZDojMGIxNzIyfS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kO3doaXRlLXNwYWNlOm5vd3JhcH0KCi8qIEVsZGVob2YgNi4yLjAgKi8KLmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e2Rpc3BsYXk6Z3JpZDtnYXA6NXB4O2ZsZXg6MTttaW4td2lkdGg6MjQwcHg7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDojMGIxYTJhfS5hbmFseXNpcy1hbGwteWVhcnMtaGludCBzdHJvbmd7Zm9udC1zaXplOjEzcHh9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50IHNwYW57Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2xpbmUtaGVpZ2h0OjEuNH0ueWVhci1jb21wYXJpc29uLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHggMTZweDttYXJnaW46LTRweCAwIDEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgc3BhbntkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2NvbG9yOiNiOGM2ZDI7Zm9udC1zaXplOjEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgaXtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDoyOHB4O2hlaWdodDowO2JvcmRlci10b3A6M3B4IHNvbGlkIGN1cnJlbnRDb2xvcn0ueWVhci1jb21wYXJpc29uLWxlZ2VuZCAucGFzdCBpe2JvcmRlci10b3Atc3R5bGU6ZGFzaGVkfS5zeW5jLWJhZGdle2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGIxYTJhO2NvbG9yOnZhcigtLW11dGVkKTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6ODAwfS5zeW5jLWJhZGdlLm9re2NvbG9yOiNhNWU2OWE7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMyl9LnN5bmMtYmFkZ2UuYnVzeXtjb2xvcjojOWZkMGZmO2JvcmRlci1jb2xvcjpyZ2JhKDc3LDE1NiwyNTUsLjM1KX0uc3luYy1iYWRnZS5lcnJvcntjb2xvcjojZmZhYWE5O2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zKX0uc3luYy1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfS5zeW5jLWpvaW4tYm94e21hcmdpbi10b3A6MTRweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nLXRvcDoxMnB4fS5zeW5jLWpvaW4tYm94IHN1bW1hcnl7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6I2RjZTlmMztmb250LXdlaWdodDo4MDB9LnN5bmMtcGFpci1yZXN1bHR7ZGlzcGxheTpncmlkO2dhcDo3cHg7bWFyZ2luLXRvcDoxNHB4O3BhZGRpbmc6MTRweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzcsMTU2LDI1NSwuMjgpO2JhY2tncm91bmQ6IzBhMWQzMDtib3JkZXItcmFkaXVzOjE0cHh9LnN5bmMtcGFpci1yZXN1bHQgc3Bhbiwuc3luYy1wYWlyLXJlc3VsdCBzbWFsbHtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjExcHh9LnN5bmMtcGFpci1yZXN1bHQgY29kZXtkaXNwbGF5OmJsb2NrO3dvcmQtYnJlYWs6YnJlYWstYWxsO2NvbG9yOiNkYmVlZmY7YmFja2dyb3VuZDojMDcxNDIxO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6OHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH1AbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsuZmlsdGVyLXBhbmVse2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e21pbi13aWR0aDowfS5zeW5jLW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnN5bmMtbWV0cmljcy5tZXRyaWMtZ3JpZCBhcnRpY2xlOmxhc3QtY2hpbGR7Z3JpZC1jb2x1bW46MS8tMX19CgoucHJpY2UtcnVubmluZ3tkaXNwbGF5OmlubGluZS1ibG9jazttYXJnaW4tbGVmdDo1cHg7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDpyZ2JhKDc3LDE1NiwyNTUsLjEyKTtjb2xvcjojOWZkMGZmO2ZvbnQtc2l6ZTo5cHg7Zm9udC13ZWlnaHQ6ODAwO3ZlcnRpY2FsLWFsaWduOm1pZGRsZX0ucHJpY2Utc3RhdHMtbm90ZXtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9Cg==","type":"text/css; charset=utf-8","cache":"no-cache"},"/app.js":{"body":"KCgpID0+IHsKICAidXNlIHN0cmljdCI7CgogIGNvbnN0IEFQUF9CVUlMRCA9ICI2LjIuMS1PU1RST00tUFJFSVNTVEFUSVNUSUstMjAyNjEwMDUiOwogIGNvbnN0IERBVEFfS0VZID0gImVsZGVob2YtdjMtcmVjb3JkcyI7CiAgY29uc3QgU0VUVElOR1NfS0VZID0gImVsZGVob2YtdjMtc2V0dGluZ3MiOwogIGNvbnN0IFZBSUxMQU5UX01PTlRIU19LRVkgPSAiZWxkZWhvZi12My12YWlsbGFudC1tb250aHMtdjM4MCI7CiAgY29uc3QgT1NUUk9NX0NBQ0hFX0tFWSA9ICJlbGRlaG9mLXYzLW9zdHJvbS1saXZlLWNhY2hlIjsKICBjb25zdCBPU1RST01fQ09OVFJPTF9LRVkgPSAiZWxkZWhvZi12NS1vc3Ryb20tY29udHJvbC12NTQxIjsKICBjb25zdCBTSEFET1dfS0VZID0gImVsZGVob2YtdjYtcmVjb3Jkcy1zaGFkb3ciOwogIGNvbnN0IFNIQURPV19NRVRBX0tFWSA9ICJlbGRlaG9mLXY2LXJlY29yZHMtc2hhZG93LW1ldGEiOwogIGNvbnN0IExBU1RfQkFDS1VQX0tFWSA9ICJlbGRlaG9mLXY2LWxhc3QtYmFja3VwLWF0IjsKICBjb25zdCBNRVRFUl9LRVkgPSAiZWxkZWhvZi12Ni1tZXRlci1yZWFkaW5ncy12NjEwIjsKICBjb25zdCBNRVRFUl9NRVRBX0tFWSA9ICJlbGRlaG9mLXY2LW1ldGVyLXJlYWRpbmdzLXVwZGF0ZWQtdjYyMCI7CiAgY29uc3QgSElTVE9SWV9TRUVEX0tFWSA9ICJlbGRlaG9mLXY2LWhpc3Rvcnktc2VlZC12NjEwIjsKICBjb25zdCBTWU5DX1NUQVRFX0tFWSA9ICJlbGRlaG9mLXY2LXN5bmMtc3RhdGUtdjYyMCI7CiAgY29uc3QgU1lOQ19QQVlMT0FEX1NDSEVNQSA9ICJlbGRlaG9mLXN5bmMtcGF5bG9hZC12NjIwIjsKICBjb25zdCBTWU5DX0VOVkVMT1BFX1NDSEVNQSA9ICJlbGRlaG9mLWVuY3J5cHRlZC1zeW5jLXYxIjsKICBjb25zdCBPU1RST01fSElTVE9SWV9LRVkgPSAiZWxkZWhvZi12Ni1vc3Ryb20taGlzdG9yeS1zdGF0dXMtdjYyMCI7CiAgY29uc3QgT1NUUk9NX1BSSUNFX1NUQVRTX0tFWSA9ICJlbGRlaG9mLXY2LW9zdHJvbS1wcmljZS1zdGF0cy12NjIxIjsKICBjb25zdCBNT05USFMgPSBbIkphbiIsIkZlYiIsIk3DpHIiLCJBcHIiLCJNYWkiLCJKdW4iLCJKdWwiLCJBdWciLCJTZXAiLCJPa3QiLCJOb3YiLCJEZXoiXTsKICBjb25zdCBDT0xPUlMgPSB7IHRvdGFsOiIjNzJkYzU3IiwgaGVhdDoiI2ZmOWY0MyIsIGFubmV4OiIjNGQ5Y2ZmIiwgcmVzdDoiI2YyZDE1ZiIsIGNvbXBhcmU6IiM5YzdkZmYiLCBjb3N0OiIjNWZjN2MyIiwgZ3JpZDoicmdiYSgxNzEsMTk4LDIyMCwuMTQpIiwgdGV4dDoiIzk0YThiYSIgfTsKICBjb25zdCBZRUFSX0NPTE9SUyA9IFsiIzcyZGM1NyIsIiM0ZDljZmYiLCIjOWM3ZGZmIiwiI2ZmOWY0MyIsIiNmMmQxNWYiLCIjNWZjN2MyIiwiI2ZmN2I4YSJdOwogIGNvbnN0IEhJU1RPUklDQUxfU0VFRCA9IHsiaGVhdFB1bXAiOnsiMjAyMy0xMiI6MTU1MCwiMjAyNC0wMSI6MTk4MCwiMjAyNC0wMiI6MTExMywiMjAyNC0wMyI6OTA3LCIyMDI0LTA0Ijo1MzUsIjIwMjQtMDUiOjE1NiwiMjAyNC0wNiI6MTEwLCIyMDI0LTA3IjoxMTAsIjIwMjQtMDgiOjEwOCwiMjAyNC0wOSI6MTk4LCIyMDI0LTEwIjo0OTAsIjIwMjQtMTEiOjEwMDMsIjIwMjQtMTIiOjEzMDUsIjIwMjUtMDEiOjE2OTQsIjIwMjUtMDIiOjE0NzgsIjIwMjUtMDMiOjEwMDUsIjIwMjUtMDQiOjQ5OCwiMjAyNS0wNSI6MzY3LCIyMDI1LTA2IjoxMzcsIjIwMjUtMDciOjEwNiwiMjAyNS0wOCI6MTI4LCIyMDI1LTA5IjoxODUsIjIwMjUtMTAiOjYwNywiMjAyNS0xMSI6MTA0MCwiMjAyNS0xMiI6MTI2NSwiMjAyNi0wMSI6MTg1NSwiMjAyNi0wMiI6MTQ4OCwiMjAyNi0wMyI6ODk1LCIyMDI2LTA0Ijo2NTYsIjIwMjYtMDUiOjMwMCwiMjAyNi0wNiI6MTI2LCIyMDI2LTA3IjoxMjgsIjIwMjYtMDgiOjEyMSwiMjAyNi0wOSI6MTM3fSwiYW5uZXgiOnsiMjAyNC0wMSI6MjEwLCIyMDI0LTAyIjoyMTAsIjIwMjQtMDMiOjIxOSwiMjAyNC0wNCI6MjAwLCIyMDI0LTA1IjoyMjIsIjIwMjQtMDYiOjE2NCwiMjAyNC0wNyI6MjE5LCIyMDI0LTA4IjoyMDEsIjIwMjQtMDkiOjE5MiwiMjAyNC0xMCI6MjM3LCIyMDI0LTExIjoyMjcsIjIwMjQtMTIiOjI2NiwiMjAyNS0wMSI6MjYxLCIyMDI1LTAyIjoyMzUsIjIwMjUtMDMiOjIyMSwiMjAyNS0wNCI6MjM4LCIyMDI1LTA1IjoyMjEsIjIwMjUtMDYiOjIzNywiMjAyNS0wNyI6MjQwLCIyMDI1LTA4IjoyMzIsIjIwMjUtMDkiOjMwOCwiMjAyNS0xMCI6MjIwLCIyMDI1LTExIjoyMzcsIjIwMjUtMTIiOjI3MywiMjAyNi0wMSI6MjQwLCIyMDI2LTAyIjoyMjUsIjIwMjYtMDMiOjI3MCwiMjAyNi0wNCI6MjE1LCIyMDI2LTA1IjoyMjAsIjIwMjYtMDYiOjI1MCwiMjAyNi0wNyI6MjEwLCIyMDI2LTA4IjoyNDAsIjIwMjYtMDkiOjI2NX0sInRvdGFsIjp7IjIwMjQtMDEiOjI0NTAsIjIwMjQtMDIiOjE2MTUsIjIwMjQtMDMiOjEzMjAsIjIwMjQtMDQiOjkzMywiMjAyNC0wNSI6NzMxLCIyMDI0LTA2Ijo1ODcsIjIwMjQtMDciOjYyMCwiMjAyNC0wOCI6NTQwLCIyMDI0LTA5Ijo2MTIsIjIwMjQtMTAiOjEwMTksIjIwMjQtMTEiOjE1MjEsIjIwMjQtMTIiOjE4NTcsIjIwMjUtMDEiOjIyODIsIjIwMjUtMDIiOjIwMjMsIjIwMjUtMDMiOjE0MTQsIjIwMjUtMDQiOjk2MCwiMjAyNS0wNSI6OTMzLCIyMDI1LTA2Ijo3NTEsIjIwMjUtMDciOjY4MCwiMjAyNS0wOCI6Njc2LCIyMDI1LTA5Ijo4MTQsIjIwMjUtMTAiOjExMDUsIjIwMjUtMTEiOjE2MTUsIjIwMjUtMTIiOjE4NTAsIjIwMjYtMDEiOjI0NTAsIjIwMjYtMDIiOjIwNjAsIjIwMjYtMDMiOjE1OTcsIjIwMjYtMDQiOjEwNTEsIjIwMjYtMDUiOjc2NywiMjAyNi0wNiI6NjYyLCIyMDI2LTA3Ijo2MDgsIjIwMjYtMDgiOjY4NSwiMjAyNi0wOSI6NjU1fX07CiAgY29uc3QgQkFTRUxJTkVfTUVURVJfUkVBRElORyA9IHtkYXRlOiIyMDI2LTEwLTAxIix0b3RhbDozNDI1NSxhbm5leDo5MDQ1LG5vdGU6IlN0YXJ0d2VydCBmw7xyIGRpZSBhdXRvbWF0aXNjaGUgQmVyZWNobnVuZyBhYiBPa3RvYmVyIDIwMjYifTsKICBjb25zdCAkID0gaWQgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwoKICBsZXQgc2V0dGluZ3MgPSBsb2FkU2V0dGluZ3MoKTsKICBsZXQgcmVjb3JkcyA9IGxvYWRSZWNvcmRzKCk7CiAgbGV0IHZhaWxsYW50TW9udGhzID0gbG9hZFZhaWxsYW50TW9udGhzKCk7CiAgbGV0IG9zdHJvbUxpdmUgPSBsb2FkT3N0cm9tQ2FjaGUoKTsKICBsZXQgb3N0cm9tQnVzeSA9IGZhbHNlOwogIGxldCBvc3Ryb21UaW1lciA9IG51bGw7CiAgbGV0IHRvYXN0VGltZXIgPSBudWxsOwogIGxldCByZXNpemVUaW1lciA9IG51bGw7CiAgbGV0IGN1cnJlbnRWaWV3ID0gImRhc2hib2FyZFZpZXciOwogIGxldCBtZXRlclJlYWRpbmdzID0gbG9hZE1ldGVyUmVhZGluZ3MoKTsKICBsZXQgc3luY1N0YXRlID0gbG9hZFN5bmNTdGF0ZSgpOwogIGxldCBzeW5jQnVzeSA9IGZhbHNlOwogIGxldCBzeW5jQXBwbHlpbmcgPSBmYWxzZTsKICBsZXQgc3luY0RlYm91bmNlVGltZXIgPSBudWxsOwogIGxldCBzeW5jUG9sbFRpbWVyID0gbnVsbDsKICBsZXQgb3N0cm9tSGlzdG9yeUJ1c3kgPSBmYWxzZTsKICBsZXQgb3N0cm9tUHJpY2VTdGF0cyA9IGxvYWRPc3Ryb21QcmljZVN0YXRzKCk7CiAgbGV0IG9zdHJvbVByaWNlU3RhdHNCdXN5ID0gZmFsc2U7CgogIGZ1bmN0aW9uIHNhZmVKc29uUGFyc2UodmFsdWUsIGZhbGxiYWNrPW51bGwpeyB0cnl7cmV0dXJuIEpTT04ucGFyc2UodmFsdWUpO31jYXRjaHtyZXR1cm4gZmFsbGJhY2s7fSB9CiAgZnVuY3Rpb24gbnVsbGFibGVOdW1iZXIodmFsdWUpeyBpZih2YWx1ZT09PSIifHx2YWx1ZT09PW51bGx8fHZhbHVlPT09dW5kZWZpbmVkKXJldHVybiBudWxsOyBjb25zdCBuPU51bWJlcih2YWx1ZSk7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUobik/bjpudWxsOyB9CiAgZnVuY3Rpb24gc29ydGVkKGl0ZW1zPXJlY29yZHMpeyByZXR1cm4gWy4uLml0ZW1zXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOyB9CiAgZnVuY3Rpb24gY3VycmVudE1vbnRoS2V5KCl7IGNvbnN0IGQ9bmV3IERhdGUoKTsgcmV0dXJuIGAke2QuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsIjAiKX1gOyB9CiAgZnVuY3Rpb24gbW9udGhMYWJlbChtb250aCxsb25nPXRydWUpeyBjb25zdCBbeSxtXT1TdHJpbmcobW9udGgpLnNwbGl0KCItIikubWFwKE51bWJlcik7IGlmKCF5fHwhbSlyZXR1cm4gbW9udGg7IHJldHVybiBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLGxvbmc/e21vbnRoOiJsb25nIix5ZWFyOiJudW1lcmljIn06e21vbnRoOiJzaG9ydCIseWVhcjoiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUoeSxtLTEsMSkpOyB9CiAgZnVuY3Rpb24gbnVtKHZhbHVlLGRpZ2l0cz0wKXsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIodmFsdWUpKT9uZXcgSW50bC5OdW1iZXJGb3JtYXQoImRlLURFIix7bWluaW11bUZyYWN0aW9uRGlnaXRzOmRpZ2l0cyxtYXhpbXVtRnJhY3Rpb25EaWdpdHM6ZGlnaXRzfSkuZm9ybWF0KE51bWJlcih2YWx1ZSkpOiLigJMiOyB9CiAgZnVuY3Rpb24gZXVybyh2YWx1ZSl7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHZhbHVlKSk/bmV3IEludGwuTnVtYmVyRm9ybWF0KCJkZS1ERSIse3N0eWxlOiJjdXJyZW5jeSIsY3VycmVuY3k6IkVVUiJ9KS5mb3JtYXQoTnVtYmVyKHZhbHVlKSk6IuKAkyI7IH0KICBmdW5jdGlvbiBwY3QodmFsdWUpeyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcih2YWx1ZSkpP2Ake3ZhbHVlPjA/IisiOiIifSR7bnVtKHZhbHVlLDEpfSAlYDoi4oCTIjsgfQogIGZ1bmN0aW9uIGVzY2FwZUh0bWwodmFsdWUpeyByZXR1cm4gU3RyaW5nKHZhbHVlPz8iIikucmVwbGFjZSgvWyY8PiInXS9nLGNoPT4oeyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwiXCIiOiImcXVvdDsiLCInIjoiJiMzOTsifVtjaF0pKTsgfQogIGZ1bmN0aW9uIGNzdkNlbGwodmFsdWUpeyBjb25zdCBzPVN0cmluZyh2YWx1ZT8/IiIpOyByZXR1cm4gYCIke3MucmVwbGFjZSgvIi9nLCciIicpfSJgOyB9CiAgZnVuY3Rpb24gZGF0ZVN0YW1wKCl7IGNvbnN0IGQ9bmV3IERhdGUoKTsgcmV0dXJuIGAke2QuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsIjAiKX0tJHtTdHJpbmcoZC5nZXREYXRlKCkpLnBhZFN0YXJ0KDIsIjAiKX1gOyB9CgogIGZ1bmN0aW9uIHNhbml0aXplUmVjb3JkKHJhdyl7CiAgICBjb25zdCBtb250aD1TdHJpbmcocmF3Py5tb250aHx8IiIpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0kLy50ZXN0KG1vbnRoKSlyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7CiAgICAgIG1vbnRoLAogICAgICBoZWF0UHVtcDpudWxsYWJsZU51bWJlcihyYXcuaGVhdFB1bXApLAogICAgICBhbm5leDpudWxsYWJsZU51bWJlcihyYXcuYW5uZXgpLAogICAgICB0b3RhbDpudWxsYWJsZU51bWJlcihyYXcudG90YWwpLAogICAgICBwcmljZUN0Om51bGxhYmxlTnVtYmVyKHJhdy5wcmljZUN0ID8/IHJhdy5hdmVyYWdlUHJpY2VDdCksCiAgICAgIGJhc2VGZWU6bnVsbGFibGVOdW1iZXIocmF3LmJhc2VGZWUpLAogICAgICBub3RlOlN0cmluZyhyYXcubm90ZXx8IiIpLnRyaW0oKS5zbGljZSgwLDgwMCksCiAgICAgIGhlYXRHZW5lcmF0ZWQ6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRHZW5lcmF0ZWQpLAogICAgICBoZWF0aW5nRWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRpbmdFbGVjdHJpY2l0eSksCiAgICAgIGRod0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKHJhdy5kaHdFbGVjdHJpY2l0eSksCiAgICAgIGhlYXRpbmdIZWF0Om51bGxhYmxlTnVtYmVyKHJhdy5oZWF0aW5nSGVhdCksCiAgICAgIGRod0hlYXQ6bnVsbGFibGVOdW1iZXIocmF3LmRod0hlYXQpLAogICAgICBoZWF0UHVtcFNvdXJjZTpTdHJpbmcocmF3LmhlYXRQdW1wU291cmNlfHwiIikuc2xpY2UoMCw2MCksCiAgICAgIGhlYXRQdW1wVXBkYXRlZEF0OnJhdy5oZWF0UHVtcFVwZGF0ZWRBdD9TdHJpbmcocmF3LmhlYXRQdW1wVXBkYXRlZEF0KTpudWxsLAogICAgICBtZXRlclJlYWRpbmdEYXRlOnJhdy5tZXRlclJlYWRpbmdEYXRlP1N0cmluZyhyYXcubWV0ZXJSZWFkaW5nRGF0ZSk6bnVsbCwKICAgICAgcHJldmlvdXNNZXRlclJlYWRpbmdEYXRlOnJhdy5wcmV2aW91c01ldGVyUmVhZGluZ0RhdGU/U3RyaW5nKHJhdy5wcmV2aW91c01ldGVyUmVhZGluZ0RhdGUpOm51bGwsCiAgICAgIHRvdGFsTWV0ZXJSZWFkaW5nOm51bGxhYmxlTnVtYmVyKHJhdy50b3RhbE1ldGVyUmVhZGluZyksCiAgICAgIGFubmV4TWV0ZXJSZWFkaW5nOm51bGxhYmxlTnVtYmVyKHJhdy5hbm5leE1ldGVyUmVhZGluZyksCiAgICAgIG1ldGVyU291cmNlOlN0cmluZyhyYXcubWV0ZXJTb3VyY2V8fCIiKS5zbGljZSgwLDYwKSwKICAgICAgcHJpY2VTb3VyY2U6U3RyaW5nKHJhdy5wcmljZVNvdXJjZXx8IiIpLnNsaWNlKDAsODApLAogICAgICBwcmljZVVwZGF0ZWRBdDpyYXcucHJpY2VVcGRhdGVkQXQ/U3RyaW5nKHJhdy5wcmljZVVwZGF0ZWRBdCk6bnVsbCwKICAgICAgb3N0cm9tVmFyaWFibGVDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy5vc3Ryb21WYXJpYWJsZUNvc3RFdXIpLAogICAgICBvc3Ryb21Ub3RhbENvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3Lm9zdHJvbVRvdGFsQ29zdEV1ciksCiAgICAgIG9zdHJvbUNvbnN1bXB0aW9uS1doOm51bGxhYmxlTnVtYmVyKHJhdy5vc3Ryb21Db25zdW1wdGlvbktXaCksCiAgICAgIG9zdHJvbVByaWNlQ29tcGxldGU6Qm9vbGVhbihyYXcub3N0cm9tUHJpY2VDb21wbGV0ZSksCiAgICAgIHVwZGF0ZWRBdDpyYXcudXBkYXRlZEF0P1N0cmluZyhyYXcudXBkYXRlZEF0KTpudWxsLAogICAgICBjbG9zZWQ6Qm9vbGVhbihyYXcuY2xvc2VkKSwKICAgICAgY2xvc2VkQXQ6cmF3LmNsb3NlZEF0P1N0cmluZyhyYXcuY2xvc2VkQXQpOm51bGwKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplUmVjb3JkcyhpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHJhdyBvZiBBcnJheS5pc0FycmF5KGl0ZW1zKT9pdGVtczpbXSl7IGNvbnN0IHI9c2FuaXRpemVSZWNvcmQocmF3KTsgaWYociltYXAuc2V0KHIubW9udGgscik7IH0KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOwogIH0KICBmdW5jdGlvbiBkZXJpdmVkKHIpeyBpZighW3I/LmhlYXRQdW1wLHI/LmFubmV4LHI/LnRvdGFsXS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpKXJldHVybiBudWxsOyByZXR1cm4gci50b3RhbC1yLmhlYXRQdW1wLXIuYW5uZXg7IH0KICBmdW5jdGlvbiBjb21wbGV0ZShyKXsgY29uc3QgcmVzdD1kZXJpdmVkKHIpOyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0Pj0wOyB9CiAgZnVuY3Rpb24gcmVjb3JkQ29zdChyKXsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShyPy5vc3Ryb21Ub3RhbENvc3RFdXIpJiZyPy5vc3Ryb21QcmljZUNvbXBsZXRlKXJldHVybiBOdW1iZXIoci5vc3Ryb21Ub3RhbENvc3RFdXIpOwogICAgaWYoIU51bWJlci5pc0Zpbml0ZShyPy50b3RhbCkpcmV0dXJuIG51bGw7CiAgICBjb25zdCBwcmljZT1OdW1iZXIuaXNGaW5pdGUoci5wcmljZUN0KT9yLnByaWNlQ3QvMTAwOk51bWJlcihzZXR0aW5ncy5mYWxsYmFja1ByaWNlfHwwLjMyKTsKICAgIGNvbnN0IGJhc2U9TnVtYmVyLmlzRmluaXRlKHIuYmFzZUZlZSk/ci5iYXNlRmVlOk51bWJlcihzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZXx8MCk7CiAgICByZXR1cm4gci50b3RhbCpwcmljZStiYXNlOwogIH0KICBmdW5jdGlvbiByZWNvcmRDb3Aocil7IHJldHVybiBOdW1iZXIocj8uaGVhdFB1bXApPjAmJk51bWJlci5pc0Zpbml0ZShOdW1iZXIocj8uaGVhdEdlbmVyYXRlZCkpP051bWJlcihyLmhlYXRHZW5lcmF0ZWQpL051bWJlcihyLmhlYXRQdW1wKTpudWxsOyB9CgogIGZ1bmN0aW9uIHJhd1NldHRpbmdzKCl7IGNvbnN0IHY9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTRVRUSU5HU19LRVkpLHt9KTsgcmV0dXJuIHYmJnR5cGVvZiB2PT09Im9iamVjdCImJiFBcnJheS5pc0FycmF5KHYpP3Y6e307IH0KICBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKXsKICAgIGNvbnN0IHJhdz1yYXdTZXR0aW5ncygpOwogICAgcmV0dXJuIHsKICAgICAgLi4ucmF3LAogICAgICBmYWxsYmFja1ByaWNlOk51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3LmZhbGxiYWNrUHJpY2UpKT9OdW1iZXIocmF3LmZhbGxiYWNrUHJpY2UpOk51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3LnByaWNlKSk/TnVtYmVyKHJhdy5wcmljZSk6MC4zMiwKICAgICAgZGVmYXVsdEJhc2VGZWU6TnVtYmVyLmlzRmluaXRlKE51bWJlcihyYXcuZGVmYXVsdEJhc2VGZWUpKT9OdW1iZXIocmF3LmRlZmF1bHRCYXNlRmVlKTowLAogICAgICBvc3Ryb21BcHBLZXk6U3RyaW5nKHJhdy5vc3Ryb21BcHBLZXl8fCIiKSwKICAgICAgb3N0cm9tQXV0b1JlZnJlc2g6cmF3Lm9zdHJvbUF1dG9SZWZyZXNoIT09ZmFsc2UsCiAgICAgIHByZWZlcnJlZFdpbmRvd0hvdXJzOlsxLDIsMyw0XS5pbmNsdWRlcyhOdW1iZXIocmF3LnByZWZlcnJlZFdpbmRvd0hvdXJzKSk/TnVtYmVyKHJhdy5wcmVmZXJyZWRXaW5kb3dIb3Vycyk6MwogICAgfTsKICB9CiAgZnVuY3Rpb24gc2F2ZVNldHRpbmdzKCl7CiAgICBjb25zdCBwcmV2aW91cz1yYXdTZXR0aW5ncygpOwogICAgY29uc3QgbWVyZ2VkPXsuLi5wcmV2aW91cywKICAgICAgZmFsbGJhY2tQcmljZTpOdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZSl8fDAsCiAgICAgIGRlZmF1bHRCYXNlRmVlOk51bWJlcihzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZSl8fDAsCiAgICAgIG9zdHJvbUFwcEtleTpTdHJpbmcoc2V0dGluZ3Mub3N0cm9tQXBwS2V5fHwiIiksCiAgICAgIG9zdHJvbUF1dG9SZWZyZXNoOnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoIT09ZmFsc2UsCiAgICAgIHByZWZlcnJlZFdpbmRvd0hvdXJzOlsxLDIsMyw0XS5pbmNsdWRlcyhOdW1iZXIoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnMpKT9OdW1iZXIoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnMpOjMKICAgIH07CiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTRVRUSU5HU19LRVksSlNPTi5zdHJpbmdpZnkobWVyZ2VkKSk7CiAgICBzZXR0aW5ncz17Li4uc2V0dGluZ3MsLi4ubWVyZ2VkfTsKICB9CgogIGZ1bmN0aW9uIHJlYWRQcmltYXJ5UmVjb3JkcygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShEQVRBX0tFWSksbnVsbCk7IHJldHVybiBBcnJheS5pc0FycmF5KHJhdyk/c2FuaXRpemVSZWNvcmRzKHJhdyk6bnVsbDsgfQogIGZ1bmN0aW9uIHJlYWRTaGFkb3dSZWNvcmRzKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNIQURPV19LRVkpLG51bGwpOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3Nhbml0aXplUmVjb3JkcyhyYXcpOltdOyB9CiAgZnVuY3Rpb24gbG9hZFJlY29yZHMoKXsKICAgIGNvbnN0IHByaW1hcnk9cmVhZFByaW1hcnlSZWNvcmRzKCk7CiAgICBpZihwcmltYXJ5IT09bnVsbClyZXR1cm4gcHJpbWFyeTsKICAgIGZvcihjb25zdCBrZXkgb2YgWyJlbGRlaG9mLXYxLWRhdGEiLCJlbmVyaGF1cy12MS1kYXRhIl0pewogICAgICBjb25zdCBsZWdhY3k9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpLG51bGwpOwogICAgICBpZihBcnJheS5pc0FycmF5KGxlZ2FjeSkpewogICAgICAgIGNvbnN0IG1pZ3JhdGVkPXNhbml0aXplUmVjb3JkcyhsZWdhY3kpOwogICAgICAgIGlmKG1pZ3JhdGVkLmxlbmd0aClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShEQVRBX0tFWSxKU09OLnN0cmluZ2lmeShtaWdyYXRlZCkpOwogICAgICAgIHJldHVybiBtaWdyYXRlZDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIFtdOwogIH0KICBmdW5jdGlvbiBzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb249IsOEbmRlcnVuZyIsYWxsb3dFbXB0eT1mYWxzZX09e30pewogICAgY29uc3QgY2xlYW49c2FuaXRpemVSZWNvcmRzKG5leHQpOwogICAgY29uc3QgcHJldmlvdXM9cmVhZFByaW1hcnlSZWNvcmRzKCl8fFtdOwogICAgaWYoIWFsbG93RW1wdHkgJiYgcHJldmlvdXMubGVuZ3RoPjAgJiYgY2xlYW4ubGVuZ3RoPT09MCl0aHJvdyBuZXcgRXJyb3IoIkxlZXJlciBNb25hdHNiZXN0YW5kIHdpcmQgYXVzIFNpY2hlcmhlaXRzZ3LDvG5kZW4gbmljaHQgYXV0b21hdGlzY2ggZ2VzcGVpY2hlcnQuIik7CiAgICBpZihwcmV2aW91cy5sZW5ndGgpewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTSEFET1dfS0VZLEpTT04uc3RyaW5naWZ5KHByZXZpb3VzKSk7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNIQURPV19NRVRBX0tFWSxKU09OLnN0cmluZ2lmeSh7c2F2ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkscmVhc29uLHJlY29yZHM6cHJldmlvdXMubGVuZ3RofSkpOwogICAgfQogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkoY2xlYW4pKTsKICAgIHJlY29yZHM9Y2xlYW47CiAgICB1cGRhdGVSZWNvdmVyeUJhbm5lcigpOwogICAgaWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygpOwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZU1ldGVyUmVhZGluZyhyYXcpewogICAgY29uc3QgZGF0ZT1TdHJpbmcocmF3Py5kYXRlfHwiIik7CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcihyYXc/LnRvdGFsKSxhbm5leD1udWxsYWJsZU51bWJlcihyYXc/LmFubmV4KTsKICAgIGlmKCEvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChkYXRlKXx8IU51bWJlci5pc0Zpbml0ZSh0b3RhbCl8fCFOdW1iZXIuaXNGaW5pdGUoYW5uZXgpfHx0b3RhbDwwfHxhbm5leDwwKXJldHVybiBudWxsOwogICAgcmV0dXJuIHtkYXRlLHRvdGFsLGFubmV4LG5vdGU6U3RyaW5nKHJhdz8ubm90ZXx8IiIpLnNsaWNlKDAsMTgwKSx1cGRhdGVkQXQ6cmF3Py51cGRhdGVkQXQ/U3RyaW5nKHJhdy51cGRhdGVkQXQpOm51bGx9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZU1ldGVyUmVhZGluZ3MoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pe2NvbnN0IHI9c2FuaXRpemVNZXRlclJlYWRpbmcocmF3KTtpZihyKW1hcC5zZXQoci5kYXRlLHIpO30KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLmRhdGUubG9jYWxlQ29tcGFyZShiLmRhdGUpKTsKICB9CiAgZnVuY3Rpb24gbG9hZE1ldGVyUmVhZGluZ3MoKXtyZXR1cm4gc2FuaXRpemVNZXRlclJlYWRpbmdzKHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oTUVURVJfS0VZKSxbXSkpO30KICBmdW5jdGlvbiBzYXZlTWV0ZXJSZWFkaW5ncyhuZXh0LHt0b3VjaD10cnVlLHRpbWVzdGFtcD1udWxsfT17fSl7bWV0ZXJSZWFkaW5ncz1zYW5pdGl6ZU1ldGVyUmVhZGluZ3MobmV4dCk7bG9jYWxTdG9yYWdlLnNldEl0ZW0oTUVURVJfS0VZLEpTT04uc3RyaW5naWZ5KG1ldGVyUmVhZGluZ3MpKTtpZih0b3VjaClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShNRVRFUl9NRVRBX0tFWSx0aW1lc3RhbXB8fG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7aWYoIXN5bmNBcHBseWluZylzY2hlZHVsZUNsb3VkU3luYygpO30KICBmdW5jdGlvbiBsYXRlc3RNZXRlclJlYWRpbmcoKXtyZXR1cm4gbWV0ZXJSZWFkaW5ncy5hdCgtMSl8fG51bGw7fQogIGZ1bmN0aW9uIGRhdGVMYWJlbCh2YWx1ZSl7Y29uc3QgZD1uZXcgRGF0ZShgJHt2YWx1ZX1UMTI6MDA6MDBgKTtyZXR1cm4gTnVtYmVyLmlzTmFOKGQudmFsdWVPZigpKT92YWx1ZTpuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtkYXk6IjItZGlnaXQiLG1vbnRoOiIyLWRpZ2l0Iix5ZWFyOiJudW1lcmljIn0pLmZvcm1hdChkKTt9CiAgZnVuY3Rpb24gbmV4dE1vbnRoRmlyc3QoZGF0ZSl7Y29uc3QgW3ksbV09U3RyaW5nKGRhdGUpLnNwbGl0KCItIikubWFwKE51bWJlcik7Y29uc3QgZD1uZXcgRGF0ZSh5LG0sMSk7cmV0dXJuIGAke2QuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsIjAiKX0tMDFgO30KICBmdW5jdGlvbiBhcHBseUhpc3RvcmljYWxTZWVkKCl7CiAgICBpZihsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZX1NFRURfS0VZKSlyZXR1cm47CiAgICBjb25zdCBtYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICBjb25zdCBtb250aHM9Wy4uLm5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKEhJU1RPUklDQUxfU0VFRC50b3RhbCksLi4uT2JqZWN0LmtleXMoSElTVE9SSUNBTF9TRUVELmFubmV4KSwuLi5PYmplY3Qua2V5cyhISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXApXSldLnNvcnQoKTsKICAgIGZvcihjb25zdCBtb250aCBvZiBtb250aHMpewogICAgICBjb25zdCByPW1hcC5nZXQobW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGh9KTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQudG90YWwsbW9udGgpKXIudG90YWw9SElTVE9SSUNBTF9TRUVELnRvdGFsW21vbnRoXTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQuYW5uZXgsbW9udGgpKXIuYW5uZXg9SElTVE9SSUNBTF9TRUVELmFubmV4W21vbnRoXTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXAsbW9udGgpKXsKICAgICAgICBjb25zdCBzZWVkPUhJU1RPUklDQUxfU0VFRC5oZWF0UHVtcFttb250aF07CiAgICAgICAgY29uc3Qga2VlcEV4aXN0aW5nPU51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSYmTWF0aC5hYnMoci5oZWF0UHVtcC1zZWVkKTw9MjsKICAgICAgICBpZigha2VlcEV4aXN0aW5nKXIuaGVhdFB1bXA9c2VlZDsKICAgICAgICBpZighci5oZWF0UHVtcFNvdXJjZSlyLmhlYXRQdW1wU291cmNlPSJoaXN0b3JpY2FsLXVzZXItZGF0YSI7CiAgICAgIH0KICAgICAgaWYobW9udGg9PT0iMjAyNC0wMyIpewogICAgICAgIGNvbnN0IG5vdGU9IlrDpGhsZXJ3ZWNoc2VsIEdlc2FtdHN0cm9tIGFtIDAxLjA0LjIwMjQ6IGFsdGVyIFrDpGhsZXIgNjIuMjk2IGtXaCwgbmV1ZXIgWsOkaGxlciAxOTcga1doOyBNb25hdHN2ZXJicmF1Y2gga29ycmVrdCBtaXQgMS4zMjAga1doIGJlcsO8Y2tzaWNodGlndC4iOwogICAgICAgIGlmKCFTdHJpbmcoci5ub3RlfHwiIikuaW5jbHVkZXMoIlrDpGhsZXJ3ZWNoc2VsIEdlc2FtdHN0cm9tIikpci5ub3RlPXIubm90ZT9gJHtyLm5vdGV9IOKAoiAke25vdGV9YDpub3RlOwogICAgICB9CiAgICAgIGlmKG1vbnRoPT09IjIwMjMtMTIiJiYhci5ub3RlKXIubm90ZT0iSGlzdG9yaXNjaCBpc3QgZsO8ciBEZXplbWJlciAyMDIzIG51ciBkZXIgV8Okcm1lcHVtcGVudmVyYnJhdWNoIGRva3VtZW50aWVydC4iOwogICAgICBtYXAuc2V0KG1vbnRoLHIpOwogICAgfQogICAgc2F2ZVJlY29yZHMoWy4uLm1hcC52YWx1ZXMoKV0se3JlYXNvbjoiSGlzdG9yaXNjaGUgVmVyYnJhdWNoc2RhdGVuIDIwMjTigJMwOS8yMDI2IMO8YmVybm9tbWVuIn0pOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWV9TRUVEX0tFWSxuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpOwogIH0KICBmdW5jdGlvbiBlbnN1cmVNZXRlckJhc2VsaW5lKCl7CiAgICBpZihtZXRlclJlYWRpbmdzLnNvbWUocj0+ci5kYXRlPT09QkFTRUxJTkVfTUVURVJfUkVBRElORy5kYXRlKSlyZXR1cm47CiAgICBpZihtZXRlclJlYWRpbmdzLmxlbmd0aD09PTApc2F2ZU1ldGVyUmVhZGluZ3MoW0JBU0VMSU5FX01FVEVSX1JFQURJTkddLHt0b3VjaDpmYWxzZX0pOwogIH0KICBmdW5jdGlvbiBsb2FkVmFpbGxhbnRNb250aHMoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oVkFJTExBTlRfTU9OVEhTX0tFWSksW10pOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3JhdzpbXTsgfQogIGZ1bmN0aW9uIHNhdmVWYWlsbGFudE1vbnRocygpeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShWQUlMTEFOVF9NT05USFNfS0VZLEpTT04uc3RyaW5naWZ5KEFycmF5LmlzQXJyYXkodmFpbGxhbnRNb250aHMpP3ZhaWxsYW50TW9udGhzOltdKSk7IGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoKTsgfQogIGZ1bmN0aW9uIGxvYWRPc3Ryb21DYWNoZSgpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShPU1RST01fQ0FDSEVfS0VZKSxudWxsKTsgcmV0dXJuIHJhdyYmcmF3LmdlbmVyYXRlZEF0P3JhdzpudWxsOyB9CiAgZnVuY3Rpb24gc2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQpeyBvc3Ryb21MaXZlPXBheWxvYWR8fG51bGw7IGlmKHBheWxvYWQpbG9jYWxTdG9yYWdlLnNldEl0ZW0oT1NUUk9NX0NBQ0hFX0tFWSxKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7IGVsc2UgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oT1NUUk9NX0NBQ0hFX0tFWSk7IGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoMTgwMCk7IH0KICBmdW5jdGlvbiBzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdChyYXcpewogICAgY29uc3QgbW9udGg9U3RyaW5nKHJhdz8ubW9udGh8fCIiKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChtb250aCkpcmV0dXJuIG51bGw7CiAgICByZXR1cm4gewogICAgICBtb250aCwKICAgICAgd2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2g6bnVsbGFibGVOdW1iZXIocmF3LndlaWdodGVkQXZlcmFnZUN0UGVyS1doID8/IHJhdy5wcmljZUN0KSwKICAgICAgdG90YWxLV2g6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsS1doID8/IHJhdy5vc3Ryb21Db25zdW1wdGlvbktXaCksCiAgICAgIHZhcmlhYmxlQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcudmFyaWFibGVDb3N0RXVyID8/IHJhdy5vc3Ryb21WYXJpYWJsZUNvc3RFdXIpLAogICAgICBmaXhlZENvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3LmZpeGVkQ29zdEV1ciA/PyByYXcuYmFzZUZlZSksCiAgICAgIHRvdGFsQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcudG90YWxDb3N0RXVyID8/IHJhdy5vc3Ryb21Ub3RhbENvc3RFdXIpLAogICAgICBjb21wbGV0ZTpCb29sZWFuKHJhdy5jb21wbGV0ZSA/PyByYXcub3N0cm9tUHJpY2VDb21wbGV0ZSksCiAgICAgIHBhcnRpYWw6Qm9vbGVhbihyYXcucGFydGlhbCksCiAgICAgIHVwZGF0ZWRBdDpTdHJpbmcocmF3LnVwZGF0ZWRBdHx8cmF3LnByaWNlVXBkYXRlZEF0fHwiIikKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHJhdyBvZiBBcnJheS5pc0FycmF5KGl0ZW1zKT9pdGVtczpbXSl7Y29uc3QgaXRlbT1zYW5pdGl6ZU9zdHJvbVByaWNlU3RhdChyYXcpO2lmKGl0ZW0pbWFwLnNldChpdGVtLm1vbnRoLGl0ZW0pO30KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOwogIH0KICBmdW5jdGlvbiBsb2FkT3N0cm9tUHJpY2VTdGF0cygpeyByZXR1cm4gc2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oT1NUUk9NX1BSSUNFX1NUQVRTX0tFWSksW10pKTsgfQogIGZ1bmN0aW9uIHNhdmVPc3Ryb21QcmljZVN0YXRzKGl0ZW1zKXsgb3N0cm9tUHJpY2VTdGF0cz1zYW5pdGl6ZU9zdHJvbVByaWNlU3RhdHMoaXRlbXMpO2xvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9QUklDRV9TVEFUU19LRVksSlNPTi5zdHJpbmdpZnkob3N0cm9tUHJpY2VTdGF0cykpO2lmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoMTIwMCk7IH0KICBmdW5jdGlvbiB1cHNlcnRPc3Ryb21QcmljZVN0YXQobW9udGgsZGF0YSx7cGFydGlhbD1mYWxzZX09e30pewogICAgaWYoIS9eXGR7NH0tXGR7Mn0kLy50ZXN0KFN0cmluZyhtb250aHx8IiIpKSlyZXR1cm47CiAgICBjb25zdCBtYXA9bmV3IE1hcChvc3Ryb21QcmljZVN0YXRzLm1hcChpdGVtPT5baXRlbS5tb250aCxpdGVtXSkpOwogICAgbWFwLnNldChtb250aCxzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdCh7CiAgICAgIG1vbnRoLHdlaWdodGVkQXZlcmFnZUN0UGVyS1doOk51bWJlcihkYXRhPy53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCksdG90YWxLV2g6TnVtYmVyKGRhdGE/LnRvdGFsS1doKSx2YXJpYWJsZUNvc3RFdXI6TnVtYmVyKGRhdGE/LnZhcmlhYmxlQ29zdEV1ciksZml4ZWRDb3N0RXVyOk51bWJlcihkYXRhPy5maXhlZENvc3RFdXIpLHRvdGFsQ29zdEV1cjpOdW1iZXIoZGF0YT8udG90YWxDb3N0RXVyKSxjb21wbGV0ZTpCb29sZWFuKGRhdGE/LmNvbXBsZXRlKSxwYXJ0aWFsLHVwZGF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkKICAgIH0pKTsKICAgIHNhdmVPc3Ryb21QcmljZVN0YXRzKFsuLi5tYXAudmFsdWVzKCldKTsKICB9CgogIGZ1bmN0aW9uIHVwZGF0ZVJlY292ZXJ5QmFubmVyKCl7CiAgICBjb25zdCBwcmltYXJ5PXJlYWRQcmltYXJ5UmVjb3JkcygpOwogICAgY29uc3Qgc2hhZG93PXJlYWRTaGFkb3dSZWNvcmRzKCk7CiAgICBjb25zdCBzaG93PSghcHJpbWFyeXx8cHJpbWFyeS5sZW5ndGg9PT0wKSYmc2hhZG93Lmxlbmd0aD4wOwogICAgJCgicmVjb3ZlcnlCYW5uZXIiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFzaG93KTsKICB9CiAgZnVuY3Rpb24gcmVzdG9yZVNoYWRvdygpewogICAgY29uc3Qgc2hhZG93PXJlYWRTaGFkb3dSZWNvcmRzKCk7CiAgICBpZighc2hhZG93Lmxlbmd0aClyZXR1cm47CiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShEQVRBX0tFWSxKU09OLnN0cmluZ2lmeShzaGFkb3cpKTsKICAgIHJlY29yZHM9c2hhZG93OwogICAgdG9hc3QoYCR7c2hhZG93Lmxlbmd0aH0gTW9uYXRzd2VydGUgd2llZGVyaGVyZ2VzdGVsbHRgKTsKICAgIHJlbmRlckFsbCgpOwogIH0KCiAgZnVuY3Rpb24gdG9hc3QobWVzc2FnZSl7IGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTsgJCgidG9hc3QiKS50ZXh0Q29udGVudD1tZXNzYWdlOyAkKCJ0b2FzdCIpLmNsYXNzTGlzdC5yZW1vdmUoImhpZGRlbiIpOyB0b2FzdFRpbWVyPXNldFRpbWVvdXQoKCk9PiQoInRvYXN0IikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIiksMjYwMCk7IH0KICBmdW5jdGlvbiBzZXRTdGF0dXMoaWQsdGV4dCxraW5kPSIiKXsgY29uc3QgZWw9JChpZCk7IGVsLnRleHRDb250ZW50PXRleHR8fCIiOyBlbC5jbGFzc05hbWU9YHN0YXR1cy10ZXh0ICR7a2luZH1gLnRyaW0oKTsgfQoKICBmdW5jdGlvbiBzd2l0Y2hWaWV3KGlkKXsKICAgIGN1cnJlbnRWaWV3PWlkOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLnZpZXciKS5mb3JFYWNoKHY9PnYuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIix2LmlkPT09aWQpKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5ib3R0b20tbmF2IFtkYXRhLW5hdl0iKS5mb3JFYWNoKGI9PmIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIixiLmRhdGFzZXQubmF2PT09aWQpKTsKICAgIHdpbmRvdy5zY3JvbGxUbyh7dG9wOjAsYmVoYXZpb3I6Imluc3RhbnQifSk7CiAgICBpZihpZD09PSJhbmFseXNpc1ZpZXciKXJlbmRlckFuYWx5c2lzKCk7CiAgICBpZihpZD09PSJjb25zdW1wdGlvblZpZXciKXJlbmRlclJlY29yZHMoKTsKICAgIGlmKGlkPT09ImRhdGFWaWV3IilyZW5kZXJEYXRhKCk7CiAgICBpZihpZD09PSJkYXNoYm9hcmRWaWV3IilyZW5kZXJEYXNoYm9hcmQoKTsKICB9CgogIGZ1bmN0aW9uIHllYXJzKCl7IHJldHVybiBbLi4ubmV3IFNldChyZWNvcmRzLm1hcChyPT5OdW1iZXIoci5tb250aC5zbGljZSgwLDQpKSkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkpXS5zb3J0KChhLGIpPT5iLWEpOyB9CiAgZnVuY3Rpb24gbGF0ZXN0UmVjb3JkKCl7IHJldHVybiBzb3J0ZWQoKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKS5hdCgtMSl8fHNvcnRlZCgpLmF0KC0xKXx8bnVsbDsgfQogIGZ1bmN0aW9uIHJlY29yZEZvck1vbnRoKG1vbnRoKXsgcmV0dXJuIHJlY29yZHMuZmluZChyPT5yLm1vbnRoPT09bW9udGgpfHxudWxsOyB9CgogIGZ1bmN0aW9uIHJlbmRlckRhc2hib2FyZCgpewogICAgY29uc3QgbGF0ZXN0PWxhdGVzdFJlY29yZCgpOwogICAgJCgibGF0ZXN0TW9udGhUaXRsZSIpLnRleHRDb250ZW50PWxhdGVzdD9tb250aExhYmVsKGxhdGVzdC5tb250aCk6Ik5vY2gga2VpbmUgTW9uYXRzd2VydGUiOwogICAgJCgiZWRpdExhdGVzdEJ0biIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIWxhdGVzdCk7CiAgICBpZihsYXRlc3QpJCgiZWRpdExhdGVzdEJ0biIpLmRhdGFzZXQubW9udGg9bGF0ZXN0Lm1vbnRoOwogICAgY29uc3QgcmVzdD1sYXRlc3Q/ZGVyaXZlZChsYXRlc3QpOm51bGw7CiAgICBjb25zdCBtZXRyaWNzPWxhdGVzdD9bCiAgICAgIFsiR2VzYW10IixgJHtudW0obGF0ZXN0LnRvdGFsLDEpfSBrV2hgLGxhdGVzdC5tZXRlclJlYWRpbmdEYXRlP2BhdXMgWsOkaGxlcnN0YW5kICR7ZGF0ZUxhYmVsKGxhdGVzdC5tZXRlclJlYWRpbmdEYXRlKX1gOiJkb2t1bWVudGllcnQiXSwKICAgICAgWyJXw6RybWVwdW1wZSIsYCR7bnVtKGxhdGVzdC5oZWF0UHVtcCwxKX0ga1doYCxOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmbGF0ZXN0LnRvdGFsPjAmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QuaGVhdFB1bXApP2Ake251bShsYXRlc3QuaGVhdFB1bXAvbGF0ZXN0LnRvdGFsKjEwMCwxKX0gJSBBbnRlaWxgOiLigJMiXSwKICAgICAgWyJBbHRlbnRlaWwiLGAke251bShsYXRlc3QuYW5uZXgsMSl9IGtXaGAsbGF0ZXN0Lm1ldGVyUmVhZGluZ0RhdGU/YFrDpGhsZXIgJHtudW0obGF0ZXN0LmFubmV4TWV0ZXJSZWFkaW5nLDApfSBrV2hgOk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZsYXRlc3QudG90YWw+MCYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC5hbm5leCk/YCR7bnVtKGxhdGVzdC5hbm5leC9sYXRlc3QudG90YWwqMTAwLDEpfSAlIEFudGVpbGA6IuKAkyJdLAogICAgICBbIlNjaGxlZS9LbHVzIixgJHtudW0ocmVzdCwxKX0ga1doYCxOdW1iZXIuaXNGaW5pdGUocmVzdCkmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZsYXRlc3QudG90YWw+MD9gJHtudW0ocmVzdC9sYXRlc3QudG90YWwqMTAwLDEpfSAlIEFudGVpbGA6ImF1dG9tYXRpc2NoIl0sCiAgICAgIFsiS29zdGVuIixldXJvKHJlY29yZENvc3QobGF0ZXN0KSksbGF0ZXN0Lm9zdHJvbVByaWNlQ29tcGxldGU/YE9zdHJvbSBleGFrdCDCtyAke251bShsYXRlc3QucHJpY2VDdCwyKX0gY3Qva1doYDpOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnByaWNlQ3QpP2Ake251bShsYXRlc3QucHJpY2VDdCwyKX0gY3Qva1doYDoiRmFsbGJhY2stUHJlaXMiXQogICAgXTpbWyJHZXNhbXQiLCLigJMiLCJNb25hdCBlaW50cmFnZW4iXSxbIlfDpHJtZXB1bXBlIiwi4oCTIiwiIl0sWyJBbHRlbnRlaWwiLCLigJMiLCIiXSxbIlNjaGxlZS9LbHVzIiwi4oCTIiwiIl0sWyJLb3N0ZW4iLCLigJMiLCIiXV07CiAgICAkKCJsYXRlc3RNZXRyaWNzIikuaW5uZXJIVE1MPW1ldHJpY3MubWFwKChbbGFiZWwsdmFsdWUsc21hbGxdKT0+YDxhcnRpY2xlPjxzcGFuPiR7bGFiZWx9PC9zcGFuPjxzdHJvbmc+JHt2YWx1ZX08L3N0cm9uZz48c21hbGw+JHtzbWFsbH08L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCIiKTsKICAgIGNvbnN0IGNvbXBhcmU9bGF0ZXN0P3JlY29yZEZvck1vbnRoKGAke051bWJlcihsYXRlc3QubW9udGguc2xpY2UoMCw0KSktMX0tJHtsYXRlc3QubW9udGguc2xpY2UoNSw3KX1gKTpudWxsOwogICAgY29uc3QgZGVsdGE9bGF0ZXN0JiZjb21wYXJlJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmTnVtYmVyLmlzRmluaXRlKGNvbXBhcmUudG90YWwpJiZjb21wYXJlLnRvdGFsIT09MD8obGF0ZXN0LnRvdGFsLWNvbXBhcmUudG90YWwpL2NvbXBhcmUudG90YWwqMTAwOm51bGw7CiAgICBjb25zdCBjb21wPSQoImxhdGVzdENvbXBhcmlzb24iKTsKICAgIGNvbXAuY2xhc3NOYW1lPSJjb21wYXJpc29uLWxpbmUgbmV1dHJhbCI7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUoZGVsdGEpKXsKICAgICAgY29tcC50ZXh0Q29udGVudD1gWnVtIGdsZWljaGVuIE1vbmF0IGRlcyBWb3JqYWhyZXM6ICR7cGN0KGRlbHRhKX0gKCR7bnVtKGxhdGVzdC50b3RhbC1jb21wYXJlLnRvdGFsLDEpfSBrV2gpLmA7CiAgICAgIGNvbXAuY2xhc3NOYW1lPWBjb21wYXJpc29uLWxpbmUgJHtkZWx0YT4wPyJwb3NpdGl2ZSI6ZGVsdGE8MD8ibmVnYXRpdmUiOiJuZXV0cmFsIn1gOwogICAgfWVsc2UgY29tcC50ZXh0Q29udGVudD1sYXRlc3Q/IkbDvHIgZGllc2VuIE1vbmF0IGlzdCBub2NoIGtlaW4gdm9sbHN0w6RuZGlnZXIgVm9yamFocmVzdmVyZ2xlaWNoIHZvcmhhbmRlbi4iOiJUcmFnZSBkZW4gZXJzdGVuIE1vbmF0c3dlcnQgZWluLiI7CiAgICBkcmF3RGFzaGJvYXJkQ29uc3VtcHRpb24oKTsKICAgIHJlbmRlck9zdHJvbURhc2hib2FyZCgpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyUmVjb3JkcygpewogICAgY29uc3QgeXM9eWVhcnMoKTsKICAgIGNvbnN0IHNlbGVjdD0kKCJyZWNvcmRZZWFyRmlsdGVyIik7CiAgICBjb25zdCBjdXJyZW50PXNlbGVjdC52YWx1ZXx8ImFsbCI7CiAgICBzZWxlY3QuaW5uZXJIVE1MPSc8b3B0aW9uIHZhbHVlPSJhbGwiPkFsbGUgSmFocmU8L29wdGlvbj4nK3lzLm1hcCh5PT5gPG9wdGlvbiB2YWx1ZT0iJHt5fSI+JHt5fTwvb3B0aW9uPmApLmpvaW4oIiIpOwogICAgc2VsZWN0LnZhbHVlPXlzLmluY2x1ZGVzKE51bWJlcihjdXJyZW50KSk/Y3VycmVudDoiYWxsIjsKICAgIGNvbnN0IGZpbHRlcmVkPXNvcnRlZCgpLnJldmVyc2UoKS5maWx0ZXIocj0+c2VsZWN0LnZhbHVlPT09ImFsbCJ8fHIubW9udGguc3RhcnRzV2l0aChgJHtzZWxlY3QudmFsdWV9LWApKTsKICAgICQoInJlY29yZENvdW50IikudGV4dENvbnRlbnQ9YCR7ZmlsdGVyZWQubGVuZ3RofSAke2ZpbHRlcmVkLmxlbmd0aD09PTE/Ik1vbmF0IjoiTW9uYXRlIn1gOwogICAgaWYoIWZpbHRlcmVkLmxlbmd0aCl7ICQoInJlY29yZExpc3QiKS5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImVtcHR5LXN0YXRlIj48c3Ryb25nPk5vY2gga2VpbmUgTW9uYXRzd2VydGUgaW4gZGllc2VyIEF1c3dhaGwuPC9zdHJvbmc+PHNwYW4+WsOkaGxlcnN0w6RuZGUgdW5kIG15VkFJTExBTlQtQ1NWIGVyemV1Z2VuIGRpZSBNb25hdHN3ZXJ0ZSBhdXRvbWF0aXNjaC48L3NwYW4+PC9kaXY+JzsgcmV0dXJuOyB9CiAgICAkKCJyZWNvcmRMaXN0IikuaW5uZXJIVE1MPWZpbHRlcmVkLm1hcChyPT57CiAgICAgIGNvbnN0IHJlc3Q9ZGVyaXZlZChyKSwgaW52YWxpZD1OdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8MDsKICAgICAgY29uc3Qgc3RhdHVzPWludmFsaWQ/IlVucGxhdXNpYmVsIjpjb21wbGV0ZShyKT8idm9sbHN0w6RuZGlnIjoidW52b2xsc3TDpG5kaWciOwogICAgICBjb25zdCBzb3VyY2U9KHIubWV0ZXJSZWFkaW5nRGF0ZT9gIOKAoiBaw6RobGVyIGJpcyAke2RhdGVMYWJlbChyLm1ldGVyUmVhZGluZ0RhdGUpfWA6ci5oZWF0UHVtcFNvdXJjZT8uc3RhcnRzV2l0aCgibXl2YWlsbGFudCIpPyIg4oCiIFfDpHJtZXB1bXBlIGF1cyBDU1YiOiIiKSsoci5vc3Ryb21QcmljZUNvbXBsZXRlPyIg4oCiIE9zdHJvbS1QcmVpcyBleGFrdCI6IiIpOwogICAgICByZXR1cm4gYDxhcnRpY2xlIGNsYXNzPSJyZWNvcmQtcm93ICR7aW52YWxpZD8iaW52YWxpZCI6IiJ9Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtbW9udGgiPjxzdHJvbmc+JHtlc2NhcGVIdG1sKG1vbnRoTGFiZWwoci5tb250aCkpfTwvc3Ryb25nPjxzbWFsbD4ke3N0YXR1c30ke3NvdXJjZX0ke3Iubm90ZT9gIOKAoiAke2VzY2FwZUh0bWwoci5ub3RlLnNsaWNlKDAsNzApKX1gOiIifTwvc21hbGw+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5HZXNhbXQ8L3NwYW4+PHN0cm9uZz4ke251bShyLnRvdGFsLDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPlfDpHJtZXB1bXBlPC9zcGFuPjxzdHJvbmc+JHtudW0oci5oZWF0UHVtcCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5BbHRlbnRlaWw8L3NwYW4+PHN0cm9uZz4ke251bShyLmFubmV4LDEpfSBrV2g8L3N0cm9uZz48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdmFsdWUiPjxzcGFuPlNjaGxlZS9LbHVzPC9zcGFuPjxzdHJvbmc+JHtudW0ocmVzdCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QgZWRpdC1yZWNvcmQiIHR5cGU9ImJ1dHRvbiIgZGF0YS1lZGl0LW1vbnRoPSIke3IubW9udGh9Ij5CZWFyYmVpdGVuPC9idXR0b24+CiAgICAgIDwvYXJ0aWNsZT5gOwogICAgfSkuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiBvcGVuUmVjb3JkTW9kYWwobW9udGgpewogICAgY29uc3Qgcj1yZWNvcmRGb3JNb250aChtb250aCk7CiAgICBpZighcil7dG9hc3QoIk1vbmF0IG5pY2h0IGdlZnVuZGVuIik7cmV0dXJuO30KICAgICQoInJlY29yZE1vZGFsVGl0bGUiKS50ZXh0Q29udGVudD1tb250aExhYmVsKHIubW9udGgpOwogICAgJCgiZWRpdGluZ01vbnRoT3JpZ2luYWwiKS52YWx1ZT1yLm1vbnRoOwogICAgJCgicmVjb3JkTW9udGgiKS52YWx1ZT1yLm1vbnRoOwogICAgJCgicmVjb3JkVG90YWwiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci50b3RhbCk/ci50b3RhbDoiIjsKICAgICQoInJlY29yZEhlYXRQdW1wIikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApP3IuaGVhdFB1bXA6IiI7CiAgICAkKCJyZWNvcmRBbm5leCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmFubmV4KT9yLmFubmV4OiIiOwogICAgJCgicmVjb3JkUHJpY2VDdCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLnByaWNlQ3QpP3IucHJpY2VDdDoiIjsKICAgICQoInJlY29yZEJhc2VGZWUiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5iYXNlRmVlKT9yLmJhc2VGZWU6IiI7CiAgICAkKCJyZWNvcmRIZWF0R2VuZXJhdGVkIikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdEdlbmVyYXRlZCk/ci5oZWF0R2VuZXJhdGVkOiIiOwogICAgJCgicmVjb3JkSGVhdGluZ0VsZWN0cmljaXR5IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuaGVhdGluZ0VsZWN0cmljaXR5KT9yLmhlYXRpbmdFbGVjdHJpY2l0eToiIjsKICAgICQoInJlY29yZERod0VsZWN0cmljaXR5IikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuZGh3RWxlY3RyaWNpdHkpP3IuZGh3RWxlY3RyaWNpdHk6IiI7CiAgICAkKCJyZWNvcmRIZWF0aW5nSGVhdCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmhlYXRpbmdIZWF0KT9yLmhlYXRpbmdIZWF0OiIiOwogICAgJCgicmVjb3JkRGh3SGVhdCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmRod0hlYXQpP3IuZGh3SGVhdDoiIjsKICAgICQoInJlY29yZE5vdGUiKS52YWx1ZT1yLm5vdGV8fCIiOwogICAgJCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSIiOwogICAgJCgicmVjb3JkU291cmNlSGludCIpLnRleHRDb250ZW50PXIubWV0ZXJSZWFkaW5nRGF0ZQogICAgICA/IGBEaWVzZXIgTW9uYXQgd3VyZGUgYXVzIFrDpGhsZXJzdMOkbmRlbiBiZXJlY2huZXQuIEVpbmUgS29ycmVrdHVyIGhpZXIgw6RuZGVydCBudXIgZGVuIE1vbmF0c3dlcnQ7IGRpZSBnZXNwZWljaGVydGVuIFrDpGhsZXJzdMOkbmRlIGJpcyAke2RhdGVMYWJlbChyLm1ldGVyUmVhZGluZ0RhdGUpfSBibGVpYmVuIGVyaGFsdGVuLmAKICAgICAgOiByLmhlYXRQdW1wU291cmNlPy5zdGFydHNXaXRoKCJteXZhaWxsYW50IikKICAgICAgICA/ICJEaWUgV8Okcm1lcHVtcGVud2VydGUgc3RhbW1lbiBhdXMgZWluZXIgbXlWQUlMTEFOVC1DU1YuIE1hbnVlbGxlIMOEbmRlcnVuZ2VuIGvDtm5uZW4gYmVpIGVpbmVtIHNww6R0ZXJlbiBlcm5ldXRlbiBDU1YtSW1wb3J0IHdpZWRlciBlcnNldHp0IHdlcmRlbi4iCiAgICAgICAgOiAiTWFudWVsbGUgS29ycmVrdHVyIGVpbmVzIGdlc3BlaWNoZXJ0ZW4gTW9uYXRzd2VydGVzLiI7CiAgICB1cGRhdGVEZXJpdmVkUHJldmlldygpOwogICAgJCgicmVjb3JkTW9kYWwiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsKICAgIGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9ImhpZGRlbiI7CiAgfQogIGZ1bmN0aW9uIGNsb3NlUmVjb3JkTW9kYWwoKXsgJCgicmVjb3JkTW9kYWwiKS5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsgZG9jdW1lbnQuYm9keS5zdHlsZS5vdmVyZmxvdz0iIjsgfQogIGZ1bmN0aW9uIHVwZGF0ZURlcml2ZWRQcmV2aWV3KCl7CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRUb3RhbCIpLnZhbHVlKSxoZWF0PW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRQdW1wIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEFubmV4IikudmFsdWUpOwogICAgY29uc3QgZWw9JCgiZGVyaXZlZFByZXZpZXciKTsKICAgIGlmKFt0b3RhbCxoZWF0LGFubmV4XS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpKXsKICAgICAgY29uc3QgcmVzdD10b3RhbC1oZWF0LWFubmV4OwogICAgICBlbC50ZXh0Q29udGVudD1gU2NobGVlL0tsdXM6ICR7bnVtKHJlc3QsMyl9IGtXaGA7CiAgICAgIGVsLmNsYXNzTGlzdC50b2dnbGUoImVycm9yIixyZXN0PDApOwogICAgfWVsc2V7CiAgICAgIGVsLnRleHRDb250ZW50PSJTY2hsZWUvS2x1czog4oCTICh3aXJkIGF1cyBHZXNhbXQg4oiSIFfDpHJtZXB1bXBlIOKIkiBBbHRlbnRlaWwgYmVyZWNobmV0KSI7CiAgICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoImVycm9yIik7CiAgICB9CiAgfQogIGZ1bmN0aW9uIHNhdmVFZGl0ZWRSZWNvcmQoZXZlbnQpewogICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IG1vbnRoPSQoImVkaXRpbmdNb250aE9yaWdpbmFsIikudmFsdWU7CiAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aChtb250aCk7CiAgICBpZighZXhpc3RpbmcpeyQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iRGVyIE1vbmF0IHd1cmRlIG5pY2h0IGdlZnVuZGVuLiI7cmV0dXJuO30KICAgIGNvbnN0IHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoInJlY29yZFRvdGFsIikudmFsdWUpLGhlYXRQdW1wPW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRQdW1wIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEFubmV4IikudmFsdWUpOwogICAgaWYoW3RvdGFsLGhlYXRQdW1wLGFubmV4XS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpJiZ0b3RhbC1oZWF0UHVtcC1hbm5leDwtLjAxKXsKICAgICAgJCgicmVjb3JkVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJVbnBsYXVzaWJlbDogV8Okcm1lcHVtcGUgKyBBbHRlbnRlaWwgc2luZCBncsO2w59lciBhbHMgZGVyIEdlc2FtdHZlcmJyYXVjaC4iO3JldHVybjsKICAgIH0KICAgIGNvbnN0IGhlYXRDaGFuZ2VkPWhlYXRQdW1wIT09ZXhpc3RpbmcuaGVhdFB1bXA7CiAgICBjb25zdCBtZXRlckNoYW5nZWQ9dG90YWwhPT1leGlzdGluZy50b3RhbHx8YW5uZXghPT1leGlzdGluZy5hbm5leDsKICAgIGNvbnN0IG5leHRQcmljZUN0PW51bGxhYmxlTnVtYmVyKCQoInJlY29yZFByaWNlQ3QiKS52YWx1ZSksbmV4dEJhc2VGZWU9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkQmFzZUZlZSIpLnZhbHVlKTsKICAgIGNvbnN0IHByaWNlQ2hhbmdlZD1uZXh0UHJpY2VDdCE9PWV4aXN0aW5nLnByaWNlQ3R8fG5leHRCYXNlRmVlIT09ZXhpc3RpbmcuYmFzZUZlZTsKICAgIGNvbnN0IHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIGNvbnN0IHJlY29yZD17Li4uZXhpc3RpbmcsCiAgICAgIHRvdGFsLGhlYXRQdW1wLGFubmV4LAogICAgICBwcmljZUN0Om5leHRQcmljZUN0LAogICAgICBiYXNlRmVlOm5leHRCYXNlRmVlLAogICAgICBoZWF0R2VuZXJhdGVkOm51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRHZW5lcmF0ZWQiKS52YWx1ZSksCiAgICAgIGhlYXRpbmdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiKS52YWx1ZSksCiAgICAgIGRod0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZERod0VsZWN0cmljaXR5IikudmFsdWUpLAogICAgICBoZWF0aW5nSGVhdDpudWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0aW5nSGVhdCIpLnZhbHVlKSwKICAgICAgZGh3SGVhdDpudWxsYWJsZU51bWJlcigkKCJyZWNvcmREaHdIZWF0IikudmFsdWUpLAogICAgICBub3RlOiQoInJlY29yZE5vdGUiKS52YWx1ZS50cmltKCksCiAgICAgIGhlYXRQdW1wU291cmNlOmhlYXRDaGFuZ2VkPyJtYW51YWwtY29ycmVjdGlvbiI6ZXhpc3RpbmcuaGVhdFB1bXBTb3VyY2UsCiAgICAgIGhlYXRQdW1wVXBkYXRlZEF0OmhlYXRDaGFuZ2VkP3N0YW1wOmV4aXN0aW5nLmhlYXRQdW1wVXBkYXRlZEF0LAogICAgICBtZXRlclNvdXJjZTptZXRlckNoYW5nZWQmJmV4aXN0aW5nLm1ldGVyU291cmNlP2Ake2V4aXN0aW5nLm1ldGVyU291cmNlfSttYW51YWwtbW9udGgtY29ycmVjdGlvbmA6ZXhpc3RpbmcubWV0ZXJTb3VyY2UsCiAgICAgIHByaWNlU291cmNlOnByaWNlQ2hhbmdlZD8ibWFudWFsLWNvcnJlY3Rpb24iOmV4aXN0aW5nLnByaWNlU291cmNlLAogICAgICBwcmljZVVwZGF0ZWRBdDpwcmljZUNoYW5nZWQ/c3RhbXA6ZXhpc3RpbmcucHJpY2VVcGRhdGVkQXQsCiAgICAgIG9zdHJvbVZhcmlhYmxlQ29zdEV1cjpwcmljZUNoYW5nZWQ/bnVsbDpleGlzdGluZy5vc3Ryb21WYXJpYWJsZUNvc3RFdXIsCiAgICAgIG9zdHJvbVRvdGFsQ29zdEV1cjpwcmljZUNoYW5nZWQ/bnVsbDpleGlzdGluZy5vc3Ryb21Ub3RhbENvc3RFdXIsCiAgICAgIG9zdHJvbUNvbnN1bXB0aW9uS1doOnByaWNlQ2hhbmdlZD9udWxsOmV4aXN0aW5nLm9zdHJvbUNvbnN1bXB0aW9uS1doLAogICAgICBvc3Ryb21QcmljZUNvbXBsZXRlOnByaWNlQ2hhbmdlZD9mYWxzZTpleGlzdGluZy5vc3Ryb21QcmljZUNvbXBsZXRlLAogICAgICB1cGRhdGVkQXQ6c3RhbXAKICAgIH07CiAgICBjb25zdCBuZXh0PXJlY29yZHMuZmlsdGVyKHI9PnIubW9udGghPT1tb250aCk7bmV4dC5wdXNoKHJlY29yZCk7CiAgICB0cnl7c2F2ZVJlY29yZHMobmV4dCx7cmVhc29uOmBNb25hdCAke21vbnRofSBtYW51ZWxsIGtvcnJpZ2llcnRgfSk7fQogICAgY2F0Y2goZXJyb3IpeyQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1lcnJvci5tZXNzYWdlO3JldHVybjt9CiAgICBjbG9zZVJlY29yZE1vZGFsKCk7cmVuZGVyQWxsKCk7dG9hc3QoYCR7bW9udGhMYWJlbChtb250aCl9IGdlw6RuZGVydGApOwogIH0KCiAgZnVuY3Rpb24gb3Blbk1ldGVyTW9kYWwoKXsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXthbGVydCgiRXMgZmVobHQgZWluIEF1c2dhbmdzesOkaGxlcnN0YW5kLiIpO3JldHVybjt9CiAgICAkKCJtZXRlckRhdGUiKS52YWx1ZT1uZXh0TW9udGhGaXJzdChwcmV2aW91cy5kYXRlKTsKICAgICQoIm1ldGVyVG90YWwiKS52YWx1ZT0iIjsKICAgICQoIm1ldGVyQW5uZXgiKS52YWx1ZT0iIjsKICAgICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSIiOwogICAgdXBkYXRlTWV0ZXJQcmV2aWV3KCk7CiAgICAkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7CiAgICBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSJoaWRkZW4iOwogICAgc2V0VGltZW91dCgoKT0+JCgibWV0ZXJUb3RhbCIpLmZvY3VzKCksNTApOwogIH0KICBmdW5jdGlvbiBjbG9zZU1ldGVyTW9kYWwoKXsgJCgibWV0ZXJNb2RhbCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOyBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSIiOyB9CiAgZnVuY3Rpb24gdXBkYXRlTWV0ZXJQcmV2aWV3KCl7CiAgICBjb25zdCBwcmV2aW91cz1sYXRlc3RNZXRlclJlYWRpbmcoKTsKICAgIGlmKCFwcmV2aW91cylyZXR1cm47CiAgICBjb25zdCBkYXRlPSQoIm1ldGVyRGF0ZSIpLnZhbHVlfHxuZXh0TW9udGhGaXJzdChwcmV2aW91cy5kYXRlKTsKICAgIGNvbnN0IHRhcmdldE1vbnRoPXByZXZpb3VzLmRhdGUuc2xpY2UoMCw3KTsKICAgICQoIm1ldGVyUHJldmlvdXMiKS5pbm5lckhUTUw9YFZvcmhlcmlnZXIgU3RhbmQ6IDxzdHJvbmc+JHtkYXRlTGFiZWwocHJldmlvdXMuZGF0ZSl9PC9zdHJvbmc+IMK3IEdlc2FtdCA8c3Ryb25nPiR7bnVtKHByZXZpb3VzLnRvdGFsLDApfSBrV2g8L3N0cm9uZz4gwrcgQWx0ZW50ZWlsIDxzdHJvbmc+JHtudW0ocHJldmlvdXMuYW5uZXgsMCl9IGtXaDwvc3Ryb25nPmA7CiAgICAkKCJtZXRlclRhcmdldE1vbnRoIikudGV4dENvbnRlbnQ9YEJlcmVjaG5ldCB3aXJkIGRlciBWZXJicmF1Y2ggZsO8ciAke21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfS5gOwogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJUb3RhbCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJtZXRlckFubmV4IikudmFsdWUpOwogICAgaWYoTnVtYmVyLmlzRmluaXRlKHRvdGFsKSYmTnVtYmVyLmlzRmluaXRlKGFubmV4KSl7CiAgICAgIGNvbnN0IHRvdGFsVXNlPXRvdGFsLXByZXZpb3VzLnRvdGFsLGFubmV4VXNlPWFubmV4LXByZXZpb3VzLmFubmV4OwogICAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aCh0YXJnZXRNb250aCksaGVhdD1leGlzdGluZz8uaGVhdFB1bXA7CiAgICAgIGNvbnN0IHJlc3Q9TnVtYmVyLmlzRmluaXRlKGhlYXQpP3RvdGFsVXNlLWFubmV4VXNlLWhlYXQ6bnVsbDsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuaW5uZXJIVE1MPWBHZXNhbXQ6IDxzdHJvbmc+JHtudW0odG90YWxVc2UsMSl9IGtXaDwvc3Ryb25nPiDCtyBBbHRlbnRlaWw6IDxzdHJvbmc+JHtudW0oYW5uZXhVc2UsMSl9IGtXaDwvc3Ryb25nPiR7TnVtYmVyLmlzRmluaXRlKGhlYXQpP2AgwrcgV8Okcm1lcHVtcGU6IDxzdHJvbmc+JHtudW0oaGVhdCwxKX0ga1doPC9zdHJvbmc+IMK3IFNjaGxlZS9LbHVzOiA8c3Ryb25nPiR7bnVtKHJlc3QsMSl9IGtXaDwvc3Ryb25nPmA6YCDCtyBXw6RybWVwdW1wZTogPHN0cm9uZz5DU1YgZmVobHQ8L3N0cm9uZz5gfWA7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLmNsYXNzTGlzdC50b2dnbGUoImVycm9yIix0b3RhbFVzZTwwfHxhbm5leFVzZTwwfHwoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PDApKTsKICAgIH1lbHNlewogICAgICAkKCJtZXRlclByZXZpZXciKS50ZXh0Q29udGVudD0iTW9uYXRzdmVyYnLDpHVjaGUgd2VyZGVuIGF1cyBkZXIgRGlmZmVyZW56IHp1bSB2b3JoZXJpZ2VuIFrDpGhsZXJzdGFuZCBiZXJlY2huZXQuIjsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuY2xhc3NMaXN0LnJlbW92ZSgiZXJyb3IiKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2F2ZU1ldGVyUmVhZGluZ0Zyb21Gb3JtKGV2ZW50KXsKICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICBjb25zdCBwcmV2aW91cz1sYXRlc3RNZXRlclJlYWRpbmcoKTsKICAgIGlmKCFwcmV2aW91cylyZXR1cm47CiAgICBjb25zdCBkYXRlPSQoIm1ldGVyRGF0ZSIpLnZhbHVlLHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyVG90YWwiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJBbm5leCIpLnZhbHVlKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChkYXRlKSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJCaXR0ZSBlaW4gZ8O8bHRpZ2VzIEFibGVzZWRhdHVtIHfDpGhsZW4uIjsgcmV0dXJuOyB9CiAgICBpZihkYXRlPD1wcmV2aW91cy5kYXRlKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9YERhcyBEYXR1bSBtdXNzIG5hY2ggZGVtIGxldHp0ZW4gU3RhbmQgdm9tICR7ZGF0ZUxhYmVsKHByZXZpb3VzLmRhdGUpfSBsaWVnZW4uYDsgcmV0dXJuOyB9CiAgICBpZighTnVtYmVyLmlzRmluaXRlKHRvdGFsKXx8IU51bWJlci5pc0Zpbml0ZShhbm5leCkpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iQml0dGUgYmVpZGUgWsOkaGxlcnN0w6RuZGUgZWludHJhZ2VuLiI7IHJldHVybjsgfQogICAgaWYodG90YWw8cHJldmlvdXMudG90YWwpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iRGVyIEdlc2FtdHrDpGhsZXJzdGFuZCBpc3Qga2xlaW5lciBhbHMgZGVyIHZvcmhlcmlnZSBTdGFuZC4gRWluIG5ldWVyIFrDpGhsZXIgbcO8c3N0ZSBzZXBhcmF0IGJlcsO8Y2tzaWNodGlndCB3ZXJkZW4uIjsgcmV0dXJuOyB9CiAgICBpZihhbm5leDxwcmV2aW91cy5hbm5leCl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBpc3Qga2xlaW5lciBhbHMgZGVyIHZvcmhlcmlnZSBTdGFuZC4iOyByZXR1cm47IH0KICAgIGNvbnN0IHRhcmdldE1vbnRoPXByZXZpb3VzLmRhdGUuc2xpY2UoMCw3KSx0b3RhbFVzZT10b3RhbC1wcmV2aW91cy50b3RhbCxhbm5leFVzZT1hbm5leC1wcmV2aW91cy5hbm5leDsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRoOnRhcmdldE1vbnRofSk7CiAgICBjb25zdCByZXN0PU51bWJlci5pc0Zpbml0ZShleGlzdGluZy5oZWF0UHVtcCk/dG90YWxVc2UtYW5uZXhVc2UtZXhpc3RpbmcuaGVhdFB1bXA6bnVsbDsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwtLjAxKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9YFVucGxhdXNpYmVsOiBOYWNoIEFienVnIHZvbiBXw6RybWVwdW1wZSB1bmQgQWx0ZW50ZWlsIGVyZ2lidCBTY2hsZWUvS2x1cyAke251bShyZXN0LDEpfSBrV2guYDsgcmV0dXJuOyB9CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgICBjb25zdCBuZXh0UmVjb3JkPXsuLi5leGlzdGluZyx0b3RhbDp0b3RhbFVzZSxhbm5leDphbm5leFVzZSxtZXRlclJlYWRpbmdEYXRlOmRhdGUscHJldmlvdXNNZXRlclJlYWRpbmdEYXRlOnByZXZpb3VzLmRhdGUsdG90YWxNZXRlclJlYWRpbmc6dG90YWwsYW5uZXhNZXRlclJlYWRpbmc6YW5uZXgsbWV0ZXJTb3VyY2U6ImN1bXVsYXRpdmUtcmVhZGluZ3MiLHVwZGF0ZWRBdDpzdGFtcH07CiAgICBjb25zdCBuZXh0PXJlY29yZHMuZmlsdGVyKHI9PnIubW9udGghPT10YXJnZXRNb250aCk7bmV4dC5wdXNoKG5leHRSZWNvcmQpOwogICAgdHJ5ewogICAgICBzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YFrDpGhsZXJzdMOkbmRlICR7ZGF0ZUxhYmVsKGRhdGUpfSBnZXNwZWljaGVydGB9KTsKICAgICAgc2F2ZU1ldGVyUmVhZGluZ3MoWy4uLm1ldGVyUmVhZGluZ3Mse2RhdGUsdG90YWwsYW5uZXgsbm90ZTpgVmVyYnJhdWNoICR7dGFyZ2V0TW9udGh9YCx1cGRhdGVkQXQ6c3RhbXB9XSk7CiAgICB9Y2F0Y2goZXJyb3IpeyQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWVycm9yLm1lc3NhZ2U7cmV0dXJuO30KICAgIGNsb3NlTWV0ZXJNb2RhbCgpO3JlbmRlckFsbCgpOwogICAgdG9hc3QoTnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmhlYXRQdW1wKT9gJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0gdm9sbHN0w6RuZGlnIGJlcmVjaG5ldGA6YFrDpGhsZXJzdMOkbmRlIGdlc3BlaWNoZXJ0IMK3IFfDpHJtZXB1bXBlbi1DU1YgZmVobHQgbm9jaGApOwogIH0KICBmdW5jdGlvbiB1bmRvTGF0ZXN0TWV0ZXJSZWFkaW5nKCl7CiAgICBpZihtZXRlclJlYWRpbmdzLmxlbmd0aDw9MSlyZXR1cm47CiAgICBjb25zdCBsYXRlc3Q9bWV0ZXJSZWFkaW5ncy5hdCgtMSkscHJldmlvdXM9bWV0ZXJSZWFkaW5ncy5hdCgtMiksdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpOwogICAgaWYoIWNvbmZpcm0oYFrDpGhsZXJzdGFuZCB2b20gJHtkYXRlTGFiZWwobGF0ZXN0LmRhdGUpfSB6dXLDvGNrbmVobWVuPyBEaWUgZGFyYXVzIGJlcmVjaG5ldGVuIFdlcnRlIGbDvHIgJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0gd2VyZGVuIGVudGZlcm50LmApKXJldHVybjsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKTsKICAgIGlmKGV4aXN0aW5nKXsKICAgICAgY29uc3QgY2xlYXJlZD17Li4uZXhpc3RpbmcsdG90YWw6bnVsbCxhbm5leDpudWxsLG1ldGVyUmVhZGluZ0RhdGU6bnVsbCxwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6bnVsbCx0b3RhbE1ldGVyUmVhZGluZzpudWxsLGFubmV4TWV0ZXJSZWFkaW5nOm51bGwsbWV0ZXJTb3VyY2U6IiIsdXBkYXRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKX07CiAgICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PXRhcmdldE1vbnRoKTtuZXh0LnB1c2goY2xlYXJlZCk7c2F2ZVJlY29yZHMobmV4dCx7cmVhc29uOmBMZXR6dGVuIFrDpGhsZXJzdGFuZCAke2xhdGVzdC5kYXRlfSB6dXLDvGNrZ2Vub21tZW5gfSk7CiAgICB9CiAgICBzYXZlTWV0ZXJSZWFkaW5ncyhtZXRlclJlYWRpbmdzLnNsaWNlKDAsLTEpKTtyZW5kZXJBbGwoKTt0b2FzdCgiTGV0enRlbiBaw6RobGVyc3RhbmQgenVyw7xja2dlbm9tbWVuIik7CiAgfQoKICBmdW5jdGlvbiBhbmFseXNpc1llYXJSb3dzKHllYXIpeyByZXR1cm4gcmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aC5zdGFydHNXaXRoKGAke3llYXJ9LWApKS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOyB9CiAgZnVuY3Rpb24gb3N0cm9tU3RhdHNGb3JZZWFyKHllYXIpewogICAgY29uc3QgY2FjaGU9bmV3IE1hcChvc3Ryb21QcmljZVN0YXRzLmZpbHRlcihpdGVtPT5pdGVtLm1vbnRoLnN0YXJ0c1dpdGgoYCR7eWVhcn0tYCkpLm1hcChpdGVtPT5baXRlbS5tb250aCxpdGVtXSkpOwogICAgZm9yKGNvbnN0IHIgb2YgYW5hbHlzaXNZZWFyUm93cyh5ZWFyKSl7CiAgICAgIGlmKCFyLm9zdHJvbVByaWNlQ29tcGxldGV8fCFOdW1iZXIuaXNGaW5pdGUoci5wcmljZUN0KXx8IU51bWJlci5pc0Zpbml0ZShyLm9zdHJvbUNvbnN1bXB0aW9uS1doKXx8ci5vc3Ryb21Db25zdW1wdGlvbktXaDw9MCljb250aW51ZTsKICAgICAgY29uc3QgZnJvbVJlY29yZD1zYW5pdGl6ZU9zdHJvbVByaWNlU3RhdCh7bW9udGg6ci5tb250aCx3ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaDpyLnByaWNlQ3QsdG90YWxLV2g6ci5vc3Ryb21Db25zdW1wdGlvbktXaCx2YXJpYWJsZUNvc3RFdXI6ci5vc3Ryb21WYXJpYWJsZUNvc3RFdXIsZml4ZWRDb3N0RXVyOnIuYmFzZUZlZSx0b3RhbENvc3RFdXI6ci5vc3Ryb21Ub3RhbENvc3RFdXIsY29tcGxldGU6dHJ1ZSxwYXJ0aWFsOmZhbHNlLHVwZGF0ZWRBdDpyLnByaWNlVXBkYXRlZEF0fHxyLnVwZGF0ZWRBdHx8IiJ9KTsKICAgICAgY29uc3QgZXhpc3Rpbmc9Y2FjaGUuZ2V0KHIubW9udGgpOwogICAgICBpZighZXhpc3Rpbmd8fERhdGUucGFyc2UoZnJvbVJlY29yZC51cGRhdGVkQXR8fCIiKT49RGF0ZS5wYXJzZShleGlzdGluZy51cGRhdGVkQXR8fCIiKSljYWNoZS5zZXQoci5tb250aCxmcm9tUmVjb3JkKTsKICAgIH0KICAgIHJldHVybiBbLi4uY2FjaGUudmFsdWVzKCldLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7CiAgfQogIGZ1bmN0aW9uIG9zdHJvbVBlcmlvZEF2ZXJhZ2UoaXRlbXMpewogICAgY29uc3QgdmFsaWQ9KEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKS5maWx0ZXIoaXRlbT0+TnVtYmVyLmlzRmluaXRlKGl0ZW0udG90YWxLV2gpJiZpdGVtLnRvdGFsS1doPjAmJk51bWJlci5pc0Zpbml0ZShpdGVtLnZhcmlhYmxlQ29zdEV1cikpOwogICAgaWYoIXZhbGlkLmxlbmd0aClyZXR1cm4ge2F2ZXJhZ2VDdDpudWxsLGVmZmVjdGl2ZUN0Om51bGwsa1doOjAsdmFyaWFibGVDb3N0RXVyOjAsZml4ZWRDb3N0RXVyOjAsdG90YWxDb3N0RXVyOjAsbW9udGhzOjAscGFydGlhbDpmYWxzZX07CiAgICBjb25zdCBrV2g9dmFsaWQucmVkdWNlKChzdW0saXRlbSk9PnN1bStOdW1iZXIoaXRlbS50b3RhbEtXaHx8MCksMCk7CiAgICBjb25zdCB2YXJpYWJsZUNvc3RFdXI9dmFsaWQucmVkdWNlKChzdW0saXRlbSk9PnN1bStOdW1iZXIoaXRlbS52YXJpYWJsZUNvc3RFdXJ8fDApLDApOwogICAgY29uc3QgZml4ZWRDb3N0RXVyPXZhbGlkLnJlZHVjZSgoc3VtLGl0ZW0pPT5zdW0rTnVtYmVyKGl0ZW0uZml4ZWRDb3N0RXVyfHwwKSwwKTsKICAgIGNvbnN0IHRvdGFsQ29zdEV1cj12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtKyhOdW1iZXIuaXNGaW5pdGUoaXRlbS50b3RhbENvc3RFdXIpP051bWJlcihpdGVtLnRvdGFsQ29zdEV1cik6TnVtYmVyKGl0ZW0udmFyaWFibGVDb3N0RXVyfHwwKStOdW1iZXIoaXRlbS5maXhlZENvc3RFdXJ8fDApKSwwKTsKICAgIHJldHVybiB7YXZlcmFnZUN0OmtXaD4wP3ZhcmlhYmxlQ29zdEV1ci9rV2gqMTAwOm51bGwsZWZmZWN0aXZlQ3Q6a1doPjA/dG90YWxDb3N0RXVyL2tXaCoxMDA6bnVsbCxrV2gsdmFyaWFibGVDb3N0RXVyLGZpeGVkQ29zdEV1cix0b3RhbENvc3RFdXIsbW9udGhzOnZhbGlkLmxlbmd0aCxwYXJ0aWFsOnZhbGlkLnNvbWUoaXRlbT0+aXRlbS5wYXJ0aWFsKX07CiAgfQogIGZ1bmN0aW9uIHF1YXJ0ZXJGb3JNb250aChtb250aCl7cmV0dXJuIE1hdGguZmxvb3IoKE51bWJlcihTdHJpbmcobW9udGgpLnNsaWNlKDUsNykpLTEpLzMpKzE7fQogIGZ1bmN0aW9uIHJlbmRlck9zdHJvbVByaWNlU3RhdHMoeWVhcil7CiAgICBpZighJCgnb3N0cm9tUHJpY2VTdGF0c01ldHJpY3MnKSlyZXR1cm47CiAgICBjb25zdCBpdGVtcz1vc3Ryb21TdGF0c0ZvclllYXIoeWVhcik7CiAgICBjb25zdCBjdXJyZW50WWVhcj1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk7CiAgICBjb25zdCBhbm51YWw9b3N0cm9tUGVyaW9kQXZlcmFnZShpdGVtcyk7CiAgICBjb25zdCBjYXJkcz1bW1N0cmluZyh5ZWFyKSxhbm51YWwseWVhcj09PWN1cnJlbnRZZWFyPyJiaXMgaGV1dGUiOiJKYWhyZXN3ZXJ0Il1dOwogICAgZm9yKGxldCBxPTE7cTw9NDtxKyspY2FyZHMucHVzaChbYFEke3F9YCxvc3Ryb21QZXJpb2RBdmVyYWdlKGl0ZW1zLmZpbHRlcihpdGVtPT5xdWFydGVyRm9yTW9udGgoaXRlbS5tb250aCk9PT1xKSksYCR7aXRlbXMuZmlsdGVyKGl0ZW09PnF1YXJ0ZXJGb3JNb250aChpdGVtLm1vbnRoKT09PXEpLmxlbmd0aH0gTW9uYXQoZSlgXSk7CiAgICAkKCdvc3Ryb21QcmljZVN0YXRzTWV0cmljcycpLmlubmVySFRNTD1jYXJkcy5tYXAoKFtsYWJlbCxzdGF0cyxzdWJdKT0+YDxhcnRpY2xlPjxzcGFuPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPjxzdHJvbmc+JHtOdW1iZXIuaXNGaW5pdGUoc3RhdHMuYXZlcmFnZUN0KT9gJHtudW0oc3RhdHMuYXZlcmFnZUN0LDIpfSBjdC9rV2hgOiLigJMifTwvc3Ryb25nPjxzbWFsbD4ke3N0YXRzLm1vbnRocz9gJHtlc2NhcGVIdG1sKHN1Yil9IMK3ICR7bnVtKHN0YXRzLmtXaCwwKX0ga1doJHtOdW1iZXIuaXNGaW5pdGUoc3RhdHMuZWZmZWN0aXZlQ3QpP2AgwrcgaW5rbC4gRml4a29zdGVuICR7bnVtKHN0YXRzLmVmZmVjdGl2ZUN0LDIpfSBjdC9rV2hgOiIifWA6ImtlaW5lIE9zdHJvbS1EYXRlbiJ9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbignJyk7CiAgICBjb25zdCBtb250aE1hcD1uZXcgTWFwKGl0ZW1zLm1hcChpdGVtPT5bTnVtYmVyKGl0ZW0ubW9udGguc2xpY2UoNSw3KSksaXRlbV0pKTsKICAgICQoJ29zdHJvbVByaWNlU3RhdHNUYWJsZScpLmlubmVySFRNTD1BcnJheS5mcm9tKHtsZW5ndGg6MTJ9LChfLGkpPT5pKzEpLm1hcChtPT57CiAgICAgIGNvbnN0IGl0ZW09bW9udGhNYXAuZ2V0KG0pO2lmKCFpdGVtKXJldHVybiBgPHRyPjx0ZD4ke01PTlRIU1ttLTFdfTwvdGQ+PHRkPuKAkzwvdGQ+PHRkPuKAkzwvdGQ+PHRkPuKAkzwvdGQ+PHRkPuKAkzwvdGQ+PC90cj5gOwogICAgICBjb25zdCBlZmZlY3RpdmU9TnVtYmVyKGl0ZW0udG90YWxLV2gpPjAmJk51bWJlci5pc0Zpbml0ZShpdGVtLnRvdGFsQ29zdEV1cik/TnVtYmVyKGl0ZW0udG90YWxDb3N0RXVyKS9OdW1iZXIoaXRlbS50b3RhbEtXaCkqMTAwOm51bGw7CiAgICAgIGNvbnN0IHJ1bm5pbmc9aXRlbS5wYXJ0aWFsfHxpdGVtLm1vbnRoPT09Y3VycmVudE1vbnRoS2V5KCk7CiAgICAgIHJldHVybiBgPHRyPjx0ZD4ke01PTlRIU1ttLTFdfSR7cnVubmluZz8nIDxzbWFsbCBjbGFzcz0icHJpY2UtcnVubmluZyI+bGF1ZmVuZDwvc21hbGw+JzonJ308L3RkPjx0ZD4ke251bShpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doLDIpfSBjdDwvdGQ+PHRkPiR7TnVtYmVyLmlzRmluaXRlKGVmZmVjdGl2ZSk/YCR7bnVtKGVmZmVjdGl2ZSwyKX0gY3RgOiLigJMifTwvdGQ+PHRkPiR7bnVtKGl0ZW0udG90YWxLV2gsMSl9IGtXaDwvdGQ+PHRkPiR7aXRlbS5jb21wbGV0ZT8nT3N0cm9tIGV4YWt0JzondW52b2xsc3TDpG5kaWcnfTwvdGQ+PC90cj5gOwogICAgfSkuam9pbignJyk7CiAgICBjb25zdCBsYXN0PWl0ZW1zLm1hcChpdGVtPT5EYXRlLnBhcnNlKGl0ZW0udXBkYXRlZEF0fHwnJykpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpLnNvcnQoKGEsYik9PmItYSlbMF07CiAgICAkKCdvc3Ryb21QcmljZVN0YXRzU3RhdHVzJykudGV4dENvbnRlbnQ9b3N0cm9tUHJpY2VTdGF0c0J1c3k/J09zdHJvbS1QcmVpc2Ugd2VyZGVuIGdlbGFkZW4g4oCmJzppdGVtcy5sZW5ndGg/YCR7aXRlbXMubGVuZ3RofSBNb25hdChlKSB2ZXJmw7xnYmFyJHtsYXN0P2AgwrcgenVsZXR6dCAke2Zvcm1hdERhdGVUaW1lKGxhc3QpfWA6Jyd9IMK3IFF1YXJ0YWwvSmFociB2ZXJicmF1Y2hzZ2V3aWNodGV0YDpzZXR0aW5ncy5vc3Ryb21BcHBLZXk/J05vY2gga2VpbmUgUHJlaXNzdGF0aXN0aWsgZsO8ciBkaWVzZXMgSmFociBnZWxhZGVuLic6J05vY2gga2VpbmUgUHJlaXNzdGF0aXN0aWsgc3luY2hyb25pc2llcnQuIEF1ZiBlaW5lbSB2ZXJidW5kZW5lbiBHZXLDpHQgbWl0IE9zdHJvbS1TY2hsw7xzc2VsIGFrdHVhbGlzaWVyZW4uJzsKICAgICQoJ3JlZnJlc2hPc3Ryb21QcmljZVN0YXRzQnRuJykuZGlzYWJsZWQ9b3N0cm9tUHJpY2VTdGF0c0J1c3l8fCFzZXR0aW5ncy5vc3Ryb21BcHBLZXk7CiAgICBkcmF3T3N0cm9tQXZlcmFnZVByaWNlQ2hhcnQoeWVhcixpdGVtcyk7CiAgfQogIGZ1bmN0aW9uIGRyYXdPc3Ryb21BdmVyYWdlUHJpY2VDaGFydCh5ZWFyLGl0ZW1zPW9zdHJvbVN0YXRzRm9yWWVhcih5ZWFyKSl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoJ29zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0JykpO2lmKCFjKXJldHVybjtjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsKICAgIGNvbnN0IHZhbHM9aXRlbXMubWFwKGl0ZW09Pk51bWJlcihpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSkuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7aWYoIXZhbHMubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCwnS2VpbmUgT3N0cm9tLVByZWlzZGF0ZW4nKTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMpKjEuMTV8fDE7CiAgICBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7CiAgICBjb25zdCBtYXA9bmV3IE1hcChpdGVtcy5tYXAoaXRlbT0+W051bWJlcihpdGVtLm1vbnRoLnNsaWNlKDUsNykpLTEsaXRlbV0pKTtjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLmNvc3Q7Y3R4LmxpbmVXaWR0aD0yLjg7Y3R4LmJlZ2luUGF0aCgpO2xldCBzdGFydGVkPWZhbHNlOwogICAgZm9yKGxldCBtPTA7bTwxMjttKyspe2NvbnN0IGl0ZW09bWFwLmdldChtKTtpZighaXRlbXx8IU51bWJlci5pc0Zpbml0ZShpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSljb250aW51ZTtjb25zdCB4PWZyYW1lLmxlZnQrZnJhbWUucGxvdFcqbS8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1pdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doL21heCk7aWYoIXN0YXJ0ZWQpe2N0eC5tb3ZlVG8oeCx5KTtzdGFydGVkPXRydWU7fWVsc2UgY3R4LmxpbmVUbyh4LHkpO31jdHguc3Ryb2tlKCk7CiAgICBjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O2ZvcihsZXQgbT0wO208MTI7bSsrKXtjb25zdCBpdGVtPW1hcC5nZXQobSk7aWYoIWl0ZW18fCFOdW1iZXIuaXNGaW5pdGUoaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpY29udGludWU7Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKm0vMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaC9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSwzLjIsMCxNYXRoLlBJKjIpO2N0eC5maWxsKCk7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZm9udD0nMTBweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmJztjdHguZmlsbFRleHQobnVtKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gsMSkseC0xMCxNYXRoLm1heCgxMCx5LTgpKTtjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O30KICB9CiAgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE9zdHJvbVByaWNlU3RhdHMoeWVhcix7c2lsZW50PWZhbHNlfT17fSl7CiAgICBpZihvc3Ryb21QcmljZVN0YXRzQnVzeSlyZXR1cm4gZmFsc2U7aWYoIXNldHRpbmdzLm9zdHJvbUFwcEtleSl7aWYoIXNpbGVudCl0b2FzdCgnT3N0cm9tIHp1ZXJzdCB2ZXJiaW5kZW4nKTtyZXR1cm4gZmFsc2U7fQogICAgY29uc3QgeT1OdW1iZXIoeWVhcik7aWYoIU51bWJlci5pc0ludGVnZXIoeSl8fHk8MjAyMHx8eT5uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkpe2lmKCFzaWxlbnQpdG9hc3QoJ1VuZ8O8bHRpZ2VzIEphaHInKTtyZXR1cm4gZmFsc2U7fQogICAgY29uc3Qgbm93PW5ldyBEYXRlKCksbGFzdE1vbnRoPXk9PT1ub3cuZ2V0RnVsbFllYXIoKT9ub3cuZ2V0TW9udGgoKSsxOjEyO29zdHJvbVByaWNlU3RhdHNCdXN5PXRydWU7cmVuZGVyT3N0cm9tUHJpY2VTdGF0cyh5KTsKICAgIGxldCB1cGRhdGVkPTAsdW5hdmFpbGFibGU9MDtjb25zdCByZWNvcmRNYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICB0cnl7CiAgICAgIGZvcihsZXQgbT0xO208PWxhc3RNb250aDttKyspewogICAgICAgIGNvbnN0IG1vbnRoPWAke3l9LSR7U3RyaW5nKG0pLnBhZFN0YXJ0KDIsJzAnKX1gO2lmKCFzaWxlbnQpJCgnb3N0cm9tUHJpY2VTdGF0c1N0YXR1cycpLnRleHRDb250ZW50PWAke21vbnRoTGFiZWwobW9udGgsZmFsc2UpfSB3aXJkIHZvbiBPc3Ryb20gZ2VsYWRlbiDigKYgKCR7bX0vJHtsYXN0TW9udGh9KWA7CiAgICAgICAgdHJ5ewogICAgICAgICAgY29uc3QgZGF0YT1hd2FpdCBvc3Ryb21GZXRjaChgL2FwaS9tb250aD9tb250aD0ke2VuY29kZVVSSUNvbXBvbmVudChtb250aCl9YCk7CiAgICAgICAgICBpZighZGF0YT8uY29tcGxldGV8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKXx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS50b3RhbEtXaCkpfHxOdW1iZXIoZGF0YS50b3RhbEtXaCk8PTB8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEudmFyaWFibGVDb3N0RXVyKSkpe3VuYXZhaWxhYmxlKys7Y29udGludWU7fQogICAgICAgICAgY29uc3QgcGFydGlhbD1tb250aD09PWN1cnJlbnRNb250aEtleSgpO3Vwc2VydE9zdHJvbVByaWNlU3RhdChtb250aCxkYXRhLHtwYXJ0aWFsfSk7dXBkYXRlZCsrOwogICAgICAgICAgaWYoIXBhcnRpYWwmJnJlY29yZE1hcC5oYXMobW9udGgpKXtjb25zdCBpdGVtPXJlY29yZE1hcC5nZXQobW9udGgpLHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtpdGVtLnByaWNlQ3Q9TnVtYmVyKGRhdGEud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpO2l0ZW0uYmFzZUZlZT1OdW1iZXIoZGF0YS5maXhlZENvc3RFdXIpfHwwO2l0ZW0ub3N0cm9tVmFyaWFibGVDb3N0RXVyPU51bWJlcihkYXRhLnZhcmlhYmxlQ29zdEV1cik7aXRlbS5vc3Ryb21Ub3RhbENvc3RFdXI9TnVtYmVyKGRhdGEudG90YWxDb3N0RXVyKTtpdGVtLm9zdHJvbUNvbnN1bXB0aW9uS1doPU51bWJlcihkYXRhLnRvdGFsS1doKTtpdGVtLm9zdHJvbVByaWNlQ29tcGxldGU9dHJ1ZTtpdGVtLnByaWNlU291cmNlPSdvc3Ryb20taG91cmx5LWNvbnN1bXB0aW9uLXdlaWdodGVkJztpdGVtLnByaWNlVXBkYXRlZEF0PXN0YW1wO2l0ZW0udXBkYXRlZEF0PXN0YW1wO3JlY29yZE1hcC5zZXQobW9udGgsaXRlbSk7fQogICAgICAgIH1jYXRjaHt1bmF2YWlsYWJsZSsrO30KICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlPT5zZXRUaW1lb3V0KHJlc29sdmUsMTQwKSk7CiAgICAgIH0KICAgICAgaWYodXBkYXRlZClzYXZlUmVjb3JkcyhbLi4ucmVjb3JkTWFwLnZhbHVlcygpXSx7cmVhc29uOmBPc3Ryb20tUHJlaXNzdGF0aXN0aWsgJHt5fSBha3R1YWxpc2llcnRgfSk7CiAgICAgIHJlbmRlckFsbCgpO2lmKCFzaWxlbnQpdG9hc3QoYCR7dXBkYXRlZH0gT3N0cm9tLU1vbmF0KGUpIGbDvHIgJHt5fSBha3R1YWxpc2llcnQke3VuYXZhaWxhYmxlP2AgwrcgJHt1bmF2YWlsYWJsZX0gbmljaHQgdmVyZsO8Z2JhcmA6Jyd9YCk7cmV0dXJuIHVwZGF0ZWQ+MDsKICAgIH1maW5hbGx5e29zdHJvbVByaWNlU3RhdHNCdXN5PWZhbHNlO3JlbmRlck9zdHJvbVByaWNlU3RhdHMoeSk7fQogIH0KICBmdW5jdGlvbiBhbm51YWxTdW1zKHJvd3MpewogICAgcmV0dXJuIHJvd3MucmVkdWNlKChhLHIpPT57IGlmKE51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSlhLnRvdGFsKz1yLnRvdGFsOyBpZihOdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCkpYS5oZWF0Kz1yLmhlYXRQdW1wOyBpZihOdW1iZXIuaXNGaW5pdGUoci5hbm5leCkpYS5hbm5leCs9ci5hbm5leDsgY29uc3QgcmVzdD1kZXJpdmVkKHIpOyBpZihOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q+PTApYS5yZXN0Kz1yZXN0OyBjb25zdCBjb3N0PXJlY29yZENvc3Qocik7IGlmKE51bWJlci5pc0Zpbml0ZShjb3N0KSlhLmNvc3QrPWNvc3Q7IGlmKE51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSlhLmNvdW50Kys7IHJldHVybiBhOyB9LHt0b3RhbDowLGhlYXQ6MCxhbm5leDowLHJlc3Q6MCxjb3N0OjAsY291bnQ6MH0pOwogIH0KICBmdW5jdGlvbiByZW5kZXJBbmFseXNpcygpewogICAgY29uc3QgeXM9eWVhcnMoKTsKICAgIGNvbnN0IHllYXJTZWxlY3Q9JCgiYW5hbHlzaXNZZWFyIik7CiAgICBjb25zdCBwcmlvcj1OdW1iZXIoeWVhclNlbGVjdC52YWx1ZSk7CiAgICBjb25zdCBzZWxlY3RlZD15cy5pbmNsdWRlcyhwcmlvcik/cHJpb3I6KHlzWzBdfHxuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkpOwogICAgeWVhclNlbGVjdC5pbm5lckhUTUw9KHlzLmxlbmd0aD95czpbbmV3IERhdGUoKS5nZXRGdWxsWWVhcigpXSkubWFwKHk9PmA8b3B0aW9uIHZhbHVlPSIke3l9Ij4ke3l9PC9vcHRpb24+YCkuam9pbigiIik7CiAgICB5ZWFyU2VsZWN0LnZhbHVlPVN0cmluZyhzZWxlY3RlZCk7CiAgICBjb25zdCByb3dzPWFuYWx5c2lzWWVhclJvd3Moc2VsZWN0ZWQpLCBzdW1zPWFubnVhbFN1bXMocm93cyk7CiAgICBjb25zdCBwcmV2aW91c1llYXI9eXMuZmlsdGVyKHk9Pnk8c2VsZWN0ZWQpLnNvcnQoKGEsYik9PmItYSlbMF18fG51bGw7CiAgICBjb25zdCBwcmV2aW91c1Jvd3M9cHJldmlvdXNZZWFyP2FuYWx5c2lzWWVhclJvd3MocHJldmlvdXNZZWFyKTpbXTsKICAgIGNvbnN0IHByZXZpb3VzPWFubnVhbFN1bXMocHJldmlvdXNSb3dzKTsKICAgIGNvbnN0IHRvdGFsRGVsdGE9cHJldmlvdXMuY291bnQmJnByZXZpb3VzLnRvdGFsPygoc3Vtcy50b3RhbC1wcmV2aW91cy50b3RhbCkvcHJldmlvdXMudG90YWwqMTAwKTpudWxsOwogICAgY29uc3QgY29wUm93cz1yb3dzLm1hcChyZWNvcmRDb3ApLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpOwogICAgY29uc3QgYW5udWFsQ29wPXJvd3MucmVkdWNlKChhLHIpPT57IGlmKE51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSYmTnVtYmVyLmlzRmluaXRlKHIuaGVhdEdlbmVyYXRlZCkpe2EuZSs9ci5oZWF0UHVtcDthLmgrPXIuaGVhdEdlbmVyYXRlZDt9IHJldHVybiBhO30se2U6MCxoOjB9KTsKICAgIGNvbnN0IGV4YWN0UHJpY2VNb250aHM9cm93cy5maWx0ZXIocj0+ci5vc3Ryb21QcmljZUNvbXBsZXRlJiZOdW1iZXIuaXNGaW5pdGUoci5vc3Ryb21Ub3RhbENvc3RFdXIpKS5sZW5ndGg7CiAgICBjb25zdCBtZXRyaWNzPVsKICAgICAgWyJHZXNhbXQiLGAke251bShzdW1zLnRvdGFsLDApfSBrV2hgLE51bWJlci5pc0Zpbml0ZSh0b3RhbERlbHRhKT9gJHtwY3QodG90YWxEZWx0YSl9IHp1ICR7cHJldmlvdXNZZWFyfWA6YCR7c3Vtcy5jb3VudH0gTW9uYXRlYF0sCiAgICAgIFsiV8Okcm1lcHVtcGUiLGAke251bShzdW1zLmhlYXQsMCl9IGtXaGAsc3Vtcy50b3RhbD9gJHtudW0oc3Vtcy5oZWF0L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiQWx0ZW50ZWlsIixgJHtudW0oc3Vtcy5hbm5leCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLmFubmV4L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiU2NobGVlL0tsdXMiLGAke251bShzdW1zLnJlc3QsMCl9IGtXaGAsc3Vtcy50b3RhbD9gJHtudW0oc3Vtcy5yZXN0L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiS29zdGVuIixldXJvKHN1bXMuY29zdCksZXhhY3RQcmljZU1vbnRocz9gJHtleGFjdFByaWNlTW9udGhzfSBNb25hdChlKSBtaXQgT3N0cm9tLVN0dW5kZW5wcmVpc2VuYDphbm51YWxDb3AuZT4wP2BXUC1BcmJlaXRzemFobCAke251bShhbm51YWxDb3AuaC9hbm51YWxDb3AuZSwyKX1gOiJGYWxsYmFjay1QcmVpc2UiXQogICAgXTsKICAgICQoImFuYWx5c2lzTWV0cmljcyIpLmlubmVySFRNTD1tZXRyaWNzLm1hcCgoW2wsdixzXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2x9PC9zcGFuPjxzdHJvbmc+JHt2fTwvc3Ryb25nPjxzbWFsbD4ke3N9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbigiIik7CiAgICAkKCJhbmFseXNpc1RhYmxlIikuaW5uZXJIVE1MPXJvd3MubGVuZ3RoP3Jvd3MubWFwKHI9PmA8dHI+PHRkPiR7ZXNjYXBlSHRtbChtb250aExhYmVsKHIubW9udGgsZmFsc2UpKX08L3RkPjx0ZD4ke251bShyLnRvdGFsLDEpfTwvdGQ+PHRkPiR7bnVtKHIuaGVhdFB1bXAsMSl9PC90ZD48dGQ+JHtudW0oci5hbm5leCwxKX08L3RkPjx0ZD4ke251bShkZXJpdmVkKHIpLDEpfTwvdGQ+PHRkPiR7ZXVybyhyZWNvcmRDb3N0KHIpKX0ke3Iub3N0cm9tUHJpY2VDb21wbGV0ZT8iICoiOiIifTwvdGQ+PC90cj5gKS5qb2luKCIiKTonPHRyPjx0ZCBjb2xzcGFuPSI2Ij5LZWluZSBNb25hdHNkYXRlbiBmw7xyIGRpZXNlcyBKYWhyLjwvdGQ+PC90cj4nOwogICAgJCgiY29wUGFuZWwiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFjb3BSb3dzLmxlbmd0aCk7CiAgICByZW5kZXJPc3Ryb21QcmljZVN0YXRzKHNlbGVjdGVkKTsKICAgIGRyYXdBbGxvY2F0aW9uQ2hhcnQocm93cyk7IGRyYXdUb3RhbENoYXJ0QWxsWWVhcnMoeXMpOyBkcmF3Q29zdENoYXJ0KHJvd3MpOyBpZihjb3BSb3dzLmxlbmd0aClkcmF3Q29wQ2hhcnQocm93cyk7CiAgfQoKICBmdW5jdGlvbiBjYW52YXNTZXR1cChjYW52YXMpewogICAgaWYoIWNhbnZhcylyZXR1cm4gbnVsbDsKICAgIGNvbnN0IHJlY3Q9Y2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOyBjb25zdCBkcHI9TWF0aC5taW4od2luZG93LmRldmljZVBpeGVsUmF0aW98fDEsMik7IGNvbnN0IHdpZHRoPU1hdGgubWF4KDI4MCxNYXRoLnJvdW5kKHJlY3Qud2lkdGh8fDYwMCkpOyBjb25zdCBoZWlnaHQ9TWF0aC5tYXgoMTgwLE1hdGgucm91bmQocmVjdC5oZWlnaHR8fDI2MCkpOwogICAgY2FudmFzLndpZHRoPU1hdGgucm91bmQod2lkdGgqZHByKTsgY2FudmFzLmhlaWdodD1NYXRoLnJvdW5kKGhlaWdodCpkcHIpOyBjb25zdCBjdHg9Y2FudmFzLmdldENvbnRleHQoIjJkIik7IGN0eC5zZXRUcmFuc2Zvcm0oZHByLDAsMCxkcHIsMCwwKTsgY3R4LmNsZWFyUmVjdCgwLDAsd2lkdGgsaGVpZ2h0KTsgcmV0dXJuIHtjdHgsd2lkdGgsaGVpZ2h0fTsKICB9CiAgZnVuY3Rpb24gZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsdGV4dD0iS2VpbmUgRGF0ZW4iKXsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7IGN0eC5mb250PSIxM3B4IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LFNlZ29lIFVJLHNhbnMtc2VyaWYiOyBjdHgudGV4dEFsaWduPSJjZW50ZXIiOyBjdHguZmlsbFRleHQodGV4dCx3aWR0aC8yLGhlaWdodC8yKTsgY3R4LnRleHRBbGlnbj0ibGVmdCI7CiAgfQogIGZ1bmN0aW9uIGNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsbGFiZWxzLHtsZWZ0PTQ4LGJvdHRvbT0zNCx0b3A9MTUscmlnaHQ9MTJ9PXt9KXsKICAgIGNvbnN0IHBsb3RXPXdpZHRoLWxlZnQtcmlnaHQsIHBsb3RIPWhlaWdodC10b3AtYm90dG9tOwogICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkOyBjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0OyBjdHguZm9udD0iMTBweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjsgY3R4LmxpbmVXaWR0aD0xOwogICAgZm9yKGxldCBpPTA7aTw9NDtpKyspeyBjb25zdCB5PXRvcCtwbG90SCppLzQ7IGN0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKGxlZnQseSk7Y3R4LmxpbmVUbyh3aWR0aC1yaWdodCx5KTtjdHguc3Ryb2tlKCk7IGNvbnN0IHZhbD1tYXgqKDEtaS80KTtjdHguZmlsbFRleHQobnVtKHZhbCwwKSw0LHkrMyk7IH0KICAgIGlmKGxhYmVscz8ubGVuZ3RoKXsgbGFiZWxzLmZvckVhY2goKGxhYmVsLGkpPT57IGNvbnN0IHg9bGVmdCsobGFiZWxzLmxlbmd0aD09PTE/cGxvdFcvMjpwbG90VyppLyhsYWJlbHMubGVuZ3RoLTEpKTsgY3R4LmZpbGxUZXh0KGxhYmVsLHgtMTAsaGVpZ2h0LTEwKTsgfSk7IH0KICAgIHJldHVybiB7bGVmdCxyaWdodCx0b3AsYm90dG9tLHBsb3RXLHBsb3RIfTsKICB9CiAgZnVuY3Rpb24gZHJhd0Rhc2hib2FyZENvbnN1bXB0aW9uKCl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoImRhc2hib2FyZENvbnN1bXB0aW9uQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHJvd3M9c29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkuc2xpY2UoLTEyKTsgaWYoIXJvd3MubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCk7cmV0dXJuO30KICAgIGNvbnN0IG1heD1NYXRoLm1heCguLi5yb3dzLm1hcChyPT5yLnRvdGFsKSkqMS4xMnx8MTsgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxyb3dzLm1hcChyPT5NT05USFNbTnVtYmVyKHIubW9udGguc2xpY2UoNSw3KSktMV0pLHt9KTsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMudG90YWw7Y3R4LmxpbmVXaWR0aD0yLjU7Y3R4LmJlZ2luUGF0aCgpO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9ZnJhbWUubGVmdCsocm93cy5sZW5ndGg9PT0xP2ZyYW1lLnBsb3RXLzI6ZnJhbWUucGxvdFcqaS8ocm93cy5sZW5ndGgtMSkpO2NvbnN0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXIudG90YWwvbWF4KTtpP2N0eC5saW5lVG8oeCx5KTpjdHgubW92ZVRvKHgseSk7fSk7Y3R4LnN0cm9rZSgpOwogICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMudG90YWw7cm93cy5mb3JFYWNoKChyLGkpPT57Y29uc3QgeD1mcmFtZS5sZWZ0Kyhyb3dzLmxlbmd0aD09PTE/ZnJhbWUucGxvdFcvMjpmcmFtZS5wbG90VyppLyhyb3dzLmxlbmd0aC0xKSk7Y29uc3QgeT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtci50b3RhbC9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSwzLDAsTWF0aC5QSSoyKTtjdHguZmlsbCgpO30pOwogIH0KICBmdW5jdGlvbiBkcmF3QWxsb2NhdGlvbkNoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJhbGxvY2F0aW9uQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbGlkPXJvd3MuZmlsdGVyKHI9PltyLmhlYXRQdW1wLHIuYW5uZXgsci50b3RhbF0uc29tZShOdW1iZXIuaXNGaW5pdGUpKTsgaWYoIXZhbGlkLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4udmFsaWQubWFwKHI9Pk1hdGgubWF4KDAsTnVtYmVyKHIudG90YWwpfHwoKE51bWJlcihyLmhlYXRQdW1wKXx8MCkrKE51bWJlcihyLmFubmV4KXx8MCkrKE1hdGgubWF4KDAsZGVyaXZlZChyKSl8fDApKSkpKSoxLjF8fDE7IGNvbnN0IGxhYmVscz12YWxpZC5tYXAocj0+TU9OVEhTW051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTFdKTsgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxsYWJlbHMse30pOyBjb25zdCBzbG90PWZyYW1lLnBsb3RXL3ZhbGlkLmxlbmd0aCwgYmFyVz1NYXRoLm1pbigzOCxzbG90Ki42Mik7CiAgICB2YWxpZC5mb3JFYWNoKChyLGkpPT57IGNvbnN0IHg9ZnJhbWUubGVmdCtzbG90KmkrKHNsb3QtYmFyVykvMjsgbGV0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIOyBjb25zdCBwYXJ0cz1bW01hdGgubWF4KDAsTnVtYmVyKHIuaGVhdFB1bXApfHwwKSxDT0xPUlMuaGVhdF0sW01hdGgubWF4KDAsTnVtYmVyKHIuYW5uZXgpfHwwKSxDT0xPUlMuYW5uZXhdLFtNYXRoLm1heCgwLGRlcml2ZWQocil8fDApLENPTE9SUy5yZXN0XV07IGZvcihjb25zdCBbdixjb2xvcl0gb2YgcGFydHMpe2NvbnN0IGg9ZnJhbWUucGxvdEgqdi9tYXg7eS09aDtjdHguZmlsbFN0eWxlPWNvbG9yO2N0eC5maWxsUmVjdCh4LHksYmFyVyxoKTt9IH0pOwogIH0KICBmdW5jdGlvbiB5ZWFyQ29sb3IoeWVhcix5ZWFyc0FzYyl7CiAgICBjb25zdCBpbmRleD1NYXRoLm1heCgwLHllYXJzQXNjLmluZGV4T2YoeWVhcikpOwogICAgcmV0dXJuIFlFQVJfQ09MT1JTW2luZGV4JVlFQVJfQ09MT1JTLmxlbmd0aF07CiAgfQogIGZ1bmN0aW9uIGRyYXdUb3RhbENoYXJ0QWxsWWVhcnMoeWVhckxpc3QpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJ0b3RhbENoYXJ0IikpOyBpZighYylyZXR1cm47CiAgICBjb25zdCB5ZWFyc0FzYz1bLi4ueWVhckxpc3RdLnNvcnQoKGEsYik9PmEtYik7CiAgICBjb25zdCBzZXJpZXM9eWVhcnNBc2MubWFwKHllYXI9Pih7eWVhcixyb3dzOmFuYWx5c2lzWWVhclJvd3MoeWVhcil9KSkuZmlsdGVyKHM9PnMucm93cy5zb21lKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkpOwogICAgY29uc3QgdmFscz1zZXJpZXMuZmxhdE1hcChzPT5zLnJvd3MpLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpOwogICAgaWYoIXZhbHMubGVuZ3RoKXtkcmF3RW1wdHkoYy5jdHgsYy53aWR0aCxjLmhlaWdodCk7JCgieWVhckNvbXBhcmlzb25MZWdlbmQiKS5pbm5lckhUTUw9IiI7cmV0dXJuO30KICAgIGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCBtYXg9TWF0aC5tYXgoLi4udmFscy5tYXAocj0+ci50b3RhbCkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsKICAgIGNvbnN0IGN1cnJlbnRZZWFyPW5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKTsKICAgICQoInllYXJDb21wYXJpc29uTGVnZW5kIikuaW5uZXJIVE1MPXNlcmllcy5tYXAoaXRlbT0+e2NvbnN0IGNvbG9yPXllYXJDb2xvcihpdGVtLnllYXIseWVhcnNBc2MpO2NvbnN0IHBhc3Q9aXRlbS55ZWFyIT09Y3VycmVudFllYXI7cmV0dXJuIGA8c3BhbiBjbGFzcz0iJHtwYXN0PyJwYXN0IjoiY3VycmVudCJ9IiBzdHlsZT0iY29sb3I6JHtjb2xvcn0iPjxpPjwvaT4ke2l0ZW0ueWVhcn0ke3Bhc3Q/IiI6IiDCtyBha3R1ZWxsIn08L3NwYW4+YDt9KS5qb2luKCIiKTsKICAgIGZvcihjb25zdCBpdGVtIG9mIHNlcmllcyl7CiAgICAgIGNvbnN0IGNvbG9yPXllYXJDb2xvcihpdGVtLnllYXIseWVhcnNBc2MpLGRhc2hlZD1pdGVtLnllYXIhPT1jdXJyZW50WWVhcjsKICAgICAgY29uc3QgbWFwPW5ldyBNYXAoaXRlbS5yb3dzLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpLm1hcChyPT5bTnVtYmVyKHIubW9udGguc2xpY2UoNSw3KSktMSxyLnRvdGFsXSkpOwogICAgICBjdHguc3Ryb2tlU3R5bGU9Y29sb3I7Y3R4LmxpbmVXaWR0aD1kYXNoZWQ/Mi4yOjM7Y3R4LnNldExpbmVEYXNoKGRhc2hlZD9bNyw1XTpbXSk7Y3R4LmJlZ2luUGF0aCgpO2xldCBzdGFydGVkPWZhbHNlOwogICAgICBmb3IobGV0IG09MDttPDEyO20rKyl7aWYoIW1hcC5oYXMobSkpY29udGludWU7Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKm0vMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtbWFwLmdldChtKS9tYXgpO2lmKCFzdGFydGVkKXtjdHgubW92ZVRvKHgseSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8oeCx5KTt9CiAgICAgIGN0eC5zdHJva2UoKTtjdHguc2V0TGluZURhc2goW10pOwogICAgICBjdHguZmlsbFN0eWxlPWNvbG9yO2ZvcihsZXQgbT0wO208MTI7bSsrKXtpZighbWFwLmhhcyhtKSljb250aW51ZTtjb25zdCB4PWZyYW1lLmxlZnQrZnJhbWUucGxvdFcqbS8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1tYXAuZ2V0KG0pL21heCk7Y3R4LmJlZ2luUGF0aCgpO2N0eC5hcmMoeCx5LGRhc2hlZD8yLjI6My4yLDAsTWF0aC5QSSoyKTtjdHguZmlsbCgpO30KICAgIH0KICB9CgogIGZ1bmN0aW9uIGRyYXdDb3N0Q2hhcnQocm93cyl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoImNvc3RDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgdmFscz1yb3dzLm1hcChyPT5yZWNvcmRDb3N0KHIpKTsgaWYoIXZhbHMuc29tZShOdW1iZXIuaXNGaW5pdGUpKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCwiS2VpbmUgS29zdGVuZGF0ZW4iKTtyZXR1cm47fSBjb25zdCBtYXg9TWF0aC5tYXgoLi4udmFscy5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKSkqMS4xMnx8MTsgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxNT05USFMse30pOyBjb25zdCBzbG90PWZyYW1lLnBsb3RXLzEyLGJhclc9TWF0aC5taW4oMzgsc2xvdCouNjIpOyB2YWxzLmZvckVhY2goKHYsaSk9PntpZighTnVtYmVyLmlzRmluaXRlKHYpKXJldHVybjtjb25zdCBoPWZyYW1lLnBsb3RIKnYvbWF4LHg9ZnJhbWUubGVmdCtzbG90KmkrKHNsb3QtYmFyVykvMix5PWZyYW1lLnRvcCtmcmFtZS5wbG90SC1oO2N0eC5maWxsU3R5bGU9Q09MT1JTLmNvc3Q7Y3R4LmZpbGxSZWN0KHgseSxiYXJXLGgpO30pOwogIH0KICBmdW5jdGlvbiBkcmF3Q29wQ2hhcnQocm93cyl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoImNvcENoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxzPXJvd3MubWFwKHJlY29yZENvcCk7IGlmKCF2YWxzLnNvbWUoTnVtYmVyLmlzRmluaXRlKSl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQpO3JldHVybjt9IGNvbnN0IG1heD1NYXRoLm1heCg1LC4uLnZhbHMuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkpKjEuMDU7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5oZWF0O2N0eC5saW5lV2lkdGg9Mi40O2N0eC5iZWdpblBhdGgoKTtsZXQgc3RhcnRlZD1mYWxzZTt2YWxzLmZvckVhY2goKHYsaSk9PntpZighTnVtYmVyLmlzRmluaXRlKHYpKXJldHVybjtjb25zdCB4PWZyYW1lLmxlZnQrZnJhbWUucGxvdFcqaS8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS12L21heCk7aWYoIXN0YXJ0ZWQpe2N0eC5tb3ZlVG8oeCx5KTtzdGFydGVkPXRydWU7fWVsc2UgY3R4LmxpbmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlck1ldGVyUGFuZWwoKXsKICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RNZXRlclJlYWRpbmcoKTsKICAgIGlmKCFsYXRlc3QpcmV0dXJuOwogICAgJCgibWV0ZXJMYXRlc3QiKS5pbm5lckhUTUw9YDxhcnRpY2xlPjxzcGFuPlN0YW5kIHZvbTwvc3Bhbj48c3Ryb25nPiR7ZGF0ZUxhYmVsKGxhdGVzdC5kYXRlKX08L3N0cm9uZz48c21hbGw+bGV0enRlIEFibGVzdW5nPC9zbWFsbD48L2FydGljbGU+PGFydGljbGU+PHNwYW4+R2VzYW10PC9zcGFuPjxzdHJvbmc+JHtudW0obGF0ZXN0LnRvdGFsLDApfSBrV2g8L3N0cm9uZz48c21hbGw+WsOkaGxlcnN0YW5kPC9zbWFsbD48L2FydGljbGU+PGFydGljbGU+PHNwYW4+QWx0ZW50ZWlsPC9zcGFuPjxzdHJvbmc+JHtudW0obGF0ZXN0LmFubmV4LDApfSBrV2g8L3N0cm9uZz48c21hbGw+WsOkaGxlcnN0YW5kPC9zbWFsbD48L2FydGljbGU+YDsKICAgICQoIm1ldGVySGlzdG9yeSIpLmlubmVySFRNTD1tZXRlclJlYWRpbmdzLnNsaWNlKCkucmV2ZXJzZSgpLnNsaWNlKDAsOCkubWFwKChyLGkpPT5gPGRpdiBjbGFzcz0ibWV0ZXItaGlzdG9yeS1yb3ciPjxzcGFuPiR7ZGF0ZUxhYmVsKHIuZGF0ZSl9PC9zcGFuPjxzdHJvbmc+R2VzYW10ICR7bnVtKHIudG90YWwsMCl9PC9zdHJvbmc+PHN0cm9uZz5BbHRlbnRlaWwgJHtudW0oci5hbm5leCwwKX08L3N0cm9uZz4ke2k9PT1tZXRlclJlYWRpbmdzLmxlbmd0aC0xPyc8c21hbGw+U3RhcnR3ZXJ0PC9zbWFsbD4nOicnfTwvZGl2PmApLmpvaW4oIiIpOwogICAgJCgidW5kb0xhdGVzdE1ldGVyQnRuIikuZGlzYWJsZWQ9bWV0ZXJSZWFkaW5ncy5sZW5ndGg8PTE7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckRhdGEoKXsKICAgIGNvbnN0IGlzc3Vlcz1bXTsgbGV0IGNvbXBsZXRlQ291bnQ9MDsKICAgIGZvcihjb25zdCByIG9mIHJlY29yZHMpewogICAgICBjb25zdCBtaXNzaW5nPVtdOyBpZighTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKW1pc3NpbmcucHVzaCgiR2VzYW10Iik7IGlmKCFOdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCkpbWlzc2luZy5wdXNoKCJXw6RybWVwdW1wZSIpOyBpZighTnVtYmVyLmlzRmluaXRlKHIuYW5uZXgpKW1pc3NpbmcucHVzaCgiQWx0ZW50ZWlsIik7IGNvbnN0IHJlc3Q9ZGVyaXZlZChyKTsKICAgICAgaWYoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PDApaXNzdWVzLnB1c2goe2xldmVsOiJlcnJvciIsbW9udGg6ci5tb250aCx0aXRsZToiQXVmdGVpbHVuZyB1bnBsYXVzaWJlbCIsZGV0YWlsOmBTY2hsZWUvS2x1cyBlcmdpYnQgJHtudW0ocmVzdCwxKX0ga1doLmB9KTsKICAgICAgZWxzZSBpZihtaXNzaW5nLmxlbmd0aClpc3N1ZXMucHVzaCh7bGV2ZWw6Indhcm5pbmciLG1vbnRoOnIubW9udGgsdGl0bGU6Ik1vbmF0IHVudm9sbHN0w6RuZGlnIixkZXRhaWw6YEZlaGx0OiAke21pc3Npbmcuam9pbigiLCAiKX1gfSk7CiAgICAgIGVsc2UgY29tcGxldGVDb3VudCsrOwogICAgfQogICAgY29uc3QgbGF0ZXN0PWxhdGVzdFJlY29yZCgpOwogICAgY29uc3QgcT1bCiAgICAgIFsiTW9uYXRlIixTdHJpbmcocmVjb3Jkcy5sZW5ndGgpLCJnZXNwZWljaGVydCJdLAogICAgICBbIlZvbGxzdMOkbmRpZyIsU3RyaW5nKGNvbXBsZXRlQ291bnQpLHJlY29yZHMubGVuZ3RoP2Ake251bShjb21wbGV0ZUNvdW50L3JlY29yZHMubGVuZ3RoKjEwMCwwKX0gJWA6IuKAkyJdLAogICAgICBbIkhpbndlaXNlIixTdHJpbmcoaXNzdWVzLmxlbmd0aCksaXNzdWVzLnNvbWUoaT0+aS5sZXZlbD09PSJlcnJvciIpPyJtaW5kLiAxIEZlaGxlciI6InByw7xmZW4iXSwKICAgICAgWyJMZXR6dGVyIE1vbmF0IixsYXRlc3Q/bW9udGhMYWJlbChsYXRlc3QubW9udGgsZmFsc2UpOiLigJMiLCJhdXRvbWF0aXNjaCBiZXJlY2huZXQiXQogICAgXTsKICAgICQoInF1YWxpdHlNZXRyaWNzIikuaW5uZXJIVE1MPXEubWFwKChbbCx2LHNdKT0+YDxhcnRpY2xlPjxzcGFuPiR7bH08L3NwYW4+PHN0cm9uZz4ke3Z9PC9zdHJvbmc+PHNtYWxsPiR7c308L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCIiKTsKICAgICQoInF1YWxpdHlJc3N1ZXMiKS5pbm5lckhUTUw9aXNzdWVzLmxlbmd0aD9pc3N1ZXMuc2xpY2UoKS5yZXZlcnNlKCkuc2xpY2UoMCwxNikubWFwKGk9PmA8YXJ0aWNsZSBjbGFzcz0iaXNzdWUgJHtpLmxldmVsfSI+PGRpdj48c3Ryb25nPiR7ZXNjYXBlSHRtbChtb250aExhYmVsKGkubW9udGgpKX06ICR7ZXNjYXBlSHRtbChpLnRpdGxlKX08L3N0cm9uZz48c21hbGw+JHtlc2NhcGVIdG1sKGkuZGV0YWlsKX08L3NtYWxsPjwvZGl2PjwvYXJ0aWNsZT5gKS5qb2luKCIiKTonPGFydGljbGUgY2xhc3M9Imlzc3VlIj48ZGl2PjxzdHJvbmc+S2VpbmUgQXVmZsOkbGxpZ2tlaXRlbjwvc3Ryb25nPjxzbWFsbD5BbGxlIGdlc3BlaWNoZXJ0ZW4gTW9uYXRlIHNpbmQgcGxhdXNpYmVsIHVuZCB2b2xsc3TDpG5kaWcuPC9zbWFsbD48L2Rpdj48L2FydGljbGU+JzsKICAgIHJlbmRlck1ldGVyUGFuZWwoKTsKICAgICQoIm9zdHJvbUFwcEtleUlucHV0IikudmFsdWU9c2V0dGluZ3Mub3N0cm9tQXBwS2V5fHwiIjsKICAgICQoIm9zdHJvbUF1dG9SZWZyZXNoSW5wdXQiKS5jaGVja2VkPXNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoIT09ZmFsc2U7CiAgICAkKCJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0IikudmFsdWU9U3RyaW5nKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzfHwzKTsKICAgICQoImZhbGxiYWNrUHJpY2VJbnB1dCIpLnZhbHVlPU51bWJlcihzZXR0aW5ncy5mYWxsYmFja1ByaWNlfHwwLjMyKS50b0ZpeGVkKDMpOwogICAgJCgiZGVmYXVsdEJhc2VGZWVJbnB1dCIpLnZhbHVlPU51bWJlcihzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZXx8MCkudG9GaXhlZCgyKTsKICAgIGNvbnN0IGxhc3RCYWNrdXA9bG9jYWxTdG9yYWdlLmdldEl0ZW0oTEFTVF9CQUNLVVBfS0VZKTsgJCgiYmFja3VwU3RhdHVzIikudGV4dENvbnRlbnQ9bGFzdEJhY2t1cD9gTGV0enRlcyBCYWNrdXA6ICR7bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7ZGF0ZVN0eWxlOiJtZWRpdW0iLHRpbWVTdHlsZToic2hvcnQifSkuZm9ybWF0KG5ldyBEYXRlKGxhc3RCYWNrdXApKX1gOiJOb2NoIGtlaW4gQmFja3VwIG1pdCBFbGRlaG9mIDYuMiBlcnN0ZWxsdC4iOwogICAgY29uc3QgaGlzdG9yeVN0YXR1cz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE9TVFJPTV9ISVNUT1JZX0tFWSksbnVsbCk7CiAgICBpZigkKCJvc3Ryb21IaXN0b3J5U3RhdHVzIikpJCgib3N0cm9tSGlzdG9yeVN0YXR1cyIpLnRleHRDb250ZW50PW9zdHJvbUhpc3RvcnlCdXN5PyJIaXN0b3Jpc2NoZSBPc3Ryb20tUHJlaXNlIHdlcmRlbiBnZWxhZGVuIOKApiI6aGlzdG9yeVN0YXR1cz8udXBkYXRlZEF0P2BQcmVpc2hpc3RvcmllIHp1bGV0enQgJHtmb3JtYXREYXRlVGltZShoaXN0b3J5U3RhdHVzLnVwZGF0ZWRBdCl9IMK3ICR7aGlzdG9yeVN0YXR1cy51cGRhdGVkfHwwfSBNb25hdChlKSBleGFrdCDCtyAke2hpc3RvcnlTdGF0dXMudW5hdmFpbGFibGV8fDB9IG5pY2h0IHZlcmbDvGdiYXJgOmBIaXN0b3Jpc2NoZSBQcmVpc2Ugbm9jaCBuaWNodCBnZXByw7xmdC5gOwogICAgcmVuZGVyU3luY1BhbmVsKCk7CiAgfQoKICBmdW5jdGlvbiBkb3dubG9hZEJsb2IoY29udGVudCxmaWxlbmFtZSx0eXBlKXsgY29uc3QgYmxvYj1uZXcgQmxvYihbY29udGVudF0se3R5cGV9KTsgY29uc3QgdXJsPVVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7IGNvbnN0IGE9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiYSIpOyBhLmhyZWY9dXJsO2EuZG93bmxvYWQ9ZmlsZW5hbWU7ZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChhKTthLmNsaWNrKCk7YS5yZW1vdmUoKTtzZXRUaW1lb3V0KCgpPT5VUkwucmV2b2tlT2JqZWN0VVJMKHVybCksMTAwMCk7IH0KICBmdW5jdGlvbiBleHBvcnRCYWNrdXAoKXsKICAgIGNvbnN0IG5vdz1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgICBjb25zdCByZWxldmFudFNldHRpbmdzPXtmYWxsYmFja1ByaWNlOnNldHRpbmdzLmZhbGxiYWNrUHJpY2UsZGVmYXVsdEJhc2VGZWU6c2V0dGluZ3MuZGVmYXVsdEJhc2VGZWUsb3N0cm9tQXBwS2V5OnNldHRpbmdzLm9zdHJvbUFwcEtleSxvc3Ryb21BdXRvUmVmcmVzaDpzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCxwcmVmZXJyZWRXaW5kb3dIb3VyczpzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vyc307CiAgICBjb25zdCBwYXlsb2FkPXt2ZXJzaW9uOiI2LjIuMSIsYXBwOiJFbGRlaG9mIixwdXJwb3NlOiJQcml2YXRlcyBsb2thbGVzIEJhY2t1cCDigJMgbmljaHQgw7ZmZmVudGxpY2ggaG9jaGxhZGVuIixleHBvcnRlZEF0Om5vdyxzZXR0aW5nczpyZWxldmFudFNldHRpbmdzLHJlY29yZHMsdmFpbGxhbnRNb250aHMsbWV0ZXJSZWFkaW5ncyxvc3Ryb21QcmljZVN0YXRzfTsKICAgIGRvd25sb2FkQmxvYihKU09OLnN0cmluZ2lmeShwYXlsb2FkLG51bGwsMiksYEVsZGVob2ZfUFJJVkFURV9CYWNrdXBfJHtkYXRlU3RhbXAoKX0uanNvbmAsImFwcGxpY2F0aW9uL2pzb24iKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTEFTVF9CQUNLVVBfS0VZLG5vdyk7IHJlbmRlckRhdGEoKTsgdG9hc3QoIlByaXZhdGVzIEJhY2t1cCBlcnN0ZWxsdCIpOwogIH0KICBmdW5jdGlvbiBleHBvcnRDc3YoKXsKICAgIGNvbnN0IHJvd3M9W1siTW9uYXQiLCJXw6RybWVwdW1wZSBrV2giLCJFcnpldWd0ZSBXw6RybWUga1doIiwiQXJiZWl0c3phaGwiLCJBbHRlbnRlaWwga1doIiwiU2NobGVlL0tsdXMga1doIiwiR2VzYW10IGtXaCIsIkdlc2FtdC1aw6RobGVyc3RhbmQga1doIiwiQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2giLCJBYmxlc2VkYXR1bSIsIlByZWlzIGN0L2tXaCIsIkZpeGtvc3RlbiBFVVIiLCJLb3N0ZW4gRVVSIiwiUHJlaXNxdWVsbGUiLCJPc3Ryb20tVmVyYnJhdWNoIGtXaCIsIk5vdGl6Il1dOwogICAgZm9yKGNvbnN0IHIgb2Ygc29ydGVkKCkpcm93cy5wdXNoKFtyLm1vbnRoLHIuaGVhdFB1bXA/PyIiLHIuaGVhdEdlbmVyYXRlZD8/IiIscmVjb3JkQ29wKHIpPz8iIixyLmFubmV4Pz8iIixkZXJpdmVkKHIpPz8iIixyLnRvdGFsPz8iIixyLnRvdGFsTWV0ZXJSZWFkaW5nPz8iIixyLmFubmV4TWV0ZXJSZWFkaW5nPz8iIixyLm1ldGVyUmVhZGluZ0RhdGU/PyIiLHIucHJpY2VDdD8/IiIsci5iYXNlRmVlPz8iIixyZWNvcmRDb3N0KHIpPz8iIixyLnByaWNlU291cmNlfHwiIixyLm9zdHJvbUNvbnN1bXB0aW9uS1doPz8iIixyLm5vdGV8fCIiXSk7CiAgICBkb3dubG9hZEJsb2IoIlx1RkVGRiIrcm93cy5tYXAocm93PT5yb3cubWFwKGNzdkNlbGwpLmpvaW4oIjsiKSkuam9pbigiXG4iKSxgRWxkZWhvZl9WZXJicmF1Y2hfJHtkYXRlU3RhbXAoKX0uY3N2YCwidGV4dC9jc3Y7Y2hhcnNldD11dGYtOCIpOyB0b2FzdCgiQ1NWIGVyc3RlbGx0Iik7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhY2t1cChmaWxlKXsKICAgIHRyeXsKICAgICAgY29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKGF3YWl0IGZpbGUudGV4dCgpKTsgY29uc3QgaW5jb21pbmc9QXJyYXkuaXNBcnJheShwYXlsb2FkKT9wYXlsb2FkOihBcnJheS5pc0FycmF5KHBheWxvYWQucmVjb3Jkcyk/cGF5bG9hZC5yZWNvcmRzOnBheWxvYWQuZGF0YSk7IGlmKCFBcnJheS5pc0FycmF5KGluY29taW5nKSl0aHJvdyBuZXcgRXJyb3IoIktlaW5lIE1vbmF0c2RhdGVuIGdlZnVuZGVuLiIpOwogICAgICBjb25zdCBjbGVhbmVkPXNhbml0aXplUmVjb3JkcyhpbmNvbWluZyk7IGlmKCFjbGVhbmVkLmxlbmd0aCYmIWNvbmZpcm0oIkRhcyBCYWNrdXAgZW50aMOkbHQga2VpbmUgTW9uYXRzd2VydGUuIExlZXJlbiBCZXN0YW5kIHdpcmtsaWNoIGltcG9ydGllcmVuPyIpKXJldHVybjsKICAgICAgaWYoIWNvbmZpcm0oYCR7Y2xlYW5lZC5sZW5ndGh9IE1vbmF0c3dlcnRlIGF1cyBkZW0gQmFja3VwIMO8YmVybmVobWVuPyBEZXIgYWt0dWVsbGUgU3RhbmQgd2lyZCB2b3JoZXIgbG9rYWwgZ2VzaWNoZXJ0LmApKXJldHVybjsKICAgICAgY29uc3QgaW1wb3J0U3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgICBzYXZlUmVjb3JkcyhjbGVhbmVkLm1hcChyPT4oey4uLnIsdXBkYXRlZEF0OmltcG9ydFN0YW1wfSkpLHtyZWFzb246IkJhY2t1cCBpbXBvcnRpZXJ0IixhbGxvd0VtcHR5OnRydWV9KTsKICAgICAgaWYocGF5bG9hZC5zZXR0aW5ncyYmdHlwZW9mIHBheWxvYWQuc2V0dGluZ3M9PT0ib2JqZWN0Iil7CiAgICAgICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLnBheWxvYWQuc2V0dGluZ3N9OwogICAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5wcmljZSkpJiYhTnVtYmVyLmlzRmluaXRlKE51bWJlcihwYXlsb2FkLnNldHRpbmdzLmZhbGxiYWNrUHJpY2UpKSlzZXR0aW5ncy5mYWxsYmFja1ByaWNlPU51bWJlcihwYXlsb2FkLnNldHRpbmdzLnByaWNlKTsKICAgICAgICBzYXZlU2V0dGluZ3MoKTsKICAgICAgfQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQudmFpbGxhbnRNb250aHMpKXsgdmFpbGxhbnRNb250aHM9cGF5bG9hZC52YWlsbGFudE1vbnRocy5tYXAodj0+KHsuLi52LHVwZGF0ZWRBdDppbXBvcnRTdGFtcH0pKTsgc2F2ZVZhaWxsYW50TW9udGhzKCk7IH0KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLm1ldGVyUmVhZGluZ3MpKXtzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3MpO31lbHNle21ldGVyUmVhZGluZ3M9bG9hZE1ldGVyUmVhZGluZ3MoKTtlbnN1cmVNZXRlckJhc2VsaW5lKCk7fQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQub3N0cm9tUHJpY2VTdGF0cykpc2F2ZU9zdHJvbVByaWNlU3RhdHMocGF5bG9hZC5vc3Ryb21QcmljZVN0YXRzKTsKICAgICAgcmVuZGVyQWxsKCk7IHRvYXN0KCJCYWNrdXAgaW1wb3J0aWVydCIpOwogICAgfWNhdGNoKGVycm9yKXsgYWxlcnQoYEJhY2t1cCBrb25udGUgbmljaHQgaW1wb3J0aWVydCB3ZXJkZW46ICR7ZXJyb3IubWVzc2FnZX1gKTsgfQogICAgZmluYWxseXsgJCgiaW1wb3J0QmFja3VwSW5wdXQiKS52YWx1ZT0iIjsgfQogIH0KCgogIC8qIEVsZGVob2YgNi4wLjEg4oCTIHNjaGxhbmtlciBsb2thbGVyIG15VkFJTExBTlQtQ1NWLUltcG9ydCAqLwogIGZ1bmN0aW9uIHZhaWxsYW50Q3N2TnVtYmVyKHZhbHVlKXsKICAgIGNvbnN0IHRleHQ9U3RyaW5nKHZhbHVlPz8iIikudHJpbSgpOwogICAgaWYoIXRleHQpcmV0dXJuIG51bGw7CiAgICBjb25zdCBub3JtYWxpemVkPXRleHQuaW5jbHVkZXMoIiwiKSYmdGV4dC5pbmNsdWRlcygiLiIpCiAgICAgID90ZXh0Lmxhc3RJbmRleE9mKCIsIik+dGV4dC5sYXN0SW5kZXhPZigiLiIpCiAgICAgICAgP3RleHQucmVwbGFjZSgvXC4vZywiIikucmVwbGFjZSgiLCIsIi4iKQogICAgICAgIDp0ZXh0LnJlcGxhY2UoLywvZywiIikKICAgICAgOnRleHQucmVwbGFjZSgiLCIsIi4iKTsKICAgIGNvbnN0IG51bWJlcj1OdW1iZXIobm9ybWFsaXplZCk7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG51bWJlcik/bnVtYmVyOm51bGw7CiAgfQogIGZ1bmN0aW9uIHZhaWxsYW50Q3N2RGF0ZVBhcnRzKHZhbHVlKXsKICAgIGNvbnN0IG1hdGNoPS9eKFxkezR9KS0oXGR7Mn0pLShcZHsyfSkoPzpbIFRdKFxkezJ9KTooXGR7Mn0pOihcZHsyfSkpPyQvLmV4ZWMoU3RyaW5nKHZhbHVlfHwiIikudHJpbSgpKTsKICAgIGlmKCFtYXRjaClyZXR1cm4gbnVsbDsKICAgIGNvbnN0IHllYXI9TnVtYmVyKG1hdGNoWzFdKSxtb250aD1OdW1iZXIobWF0Y2hbMl0pLGRheT1OdW1iZXIobWF0Y2hbM10pOwogICAgY29uc3QgZGF0ZT1uZXcgRGF0ZShEYXRlLlVUQyh5ZWFyLG1vbnRoLTEsZGF5KSk7CiAgICBpZihkYXRlLmdldFVUQ0Z1bGxZZWFyKCkhPT15ZWFyfHxkYXRlLmdldFVUQ01vbnRoKCkhPT1tb250aC0xfHxkYXRlLmdldFVUQ0RhdGUoKSE9PWRheSlyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7eWVhcixtb250aCxkYXksZGF0ZUtleTpgJHttYXRjaFsxXX0tJHttYXRjaFsyXX0tJHttYXRjaFszXX1gLG1vbnRoS2V5OmAke21hdGNoWzFdfS0ke21hdGNoWzJdfWAsZGF0ZVRpbWU6U3RyaW5nKHZhbHVlfHwiIikudHJpbSgpfTsKICB9CiAgZnVuY3Rpb24gZGV0ZWN0VmFpbGxhbnRDc3ZUeXBlKGhlYWRlcnMpewogICAgY29uc3QgZmllbGRzPW5ldyBTZXQoaGVhZGVycyksaGFzPW5hbWU9PmZpZWxkcy5oYXMobmFtZSk7CiAgICBpZihoYXMoIkRhdGVUaW1lIikmJmhhcygiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6RG9tZXN0aWNIb3RXYXRlciIpKXJldHVybiAiYXJvdGhlcm0tZW5lcmd5IjsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpJiZoYXMoIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpJiYhaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpKXJldHVybiAidW5pdG93ZXItZW5lcmd5IjsKICAgIHJldHVybiAidW5rbm93biI7CiAgfQogIGZ1bmN0aW9uIHBhcnNlVmFpbGxhbnRDc3ZUZXh0KHRleHQsaW5kZXg9MCl7CiAgICBjb25zdCBub3JtYWxpemVkPVN0cmluZyh0ZXh0fHwiIikucmVwbGFjZSgvXlx1RkVGRi8sIiIpLnJlcGxhY2UoL1xyXG4/L2csIlxuIik7CiAgICBjb25zdCBkYXRhTGluZXM9bm9ybWFsaXplZC5zcGxpdCgiXG4iKS5maWx0ZXIobGluZT0+e2NvbnN0IHQ9bGluZS50cmltKCk7cmV0dXJuIHQmJiF0LnN0YXJ0c1dpdGgoIiMiKTt9KTsKICAgIGlmKCFkYXRhTGluZXMubGVuZ3RoKXJldHVybiB7aW5kZXgsdHlwZToidW5rbm93biIscm93czpbXSxpbnZhbGlkUm93czowfTsKICAgIGNvbnN0IGRlbGltaXRlcj1kYXRhTGluZXNbMF0uaW5jbHVkZXMoIjsiKT8iOyI6IiwiOwogICAgY29uc3QgaGVhZGVycz1kYXRhTGluZXNbMF0uc3BsaXQoZGVsaW1pdGVyKS5tYXAodj0+di50cmltKCkpOwogICAgY29uc3QgdHlwZT1kZXRlY3RWYWlsbGFudENzdlR5cGUoaGVhZGVycykscm93cz1bXTtsZXQgaW52YWxpZFJvd3M9MDsKICAgIGZvcihjb25zdCBsaW5lIG9mIGRhdGFMaW5lcy5zbGljZSgxKSl7CiAgICAgIGlmKCFsaW5lLnRyaW0oKSljb250aW51ZTsKICAgICAgY29uc3QgdmFsdWVzPWxpbmUuc3BsaXQoZGVsaW1pdGVyKTsKICAgICAgY29uc3QgcmF3PU9iamVjdC5mcm9tRW50cmllcyhoZWFkZXJzLm1hcCgoaGVhZGVyLGNvbHVtbik9PltoZWFkZXIsdmFsdWVzW2NvbHVtbl0/PyIiXSkpOwogICAgICBjb25zdCBkYXRlPXZhaWxsYW50Q3N2RGF0ZVBhcnRzKHJhdy5EYXRlVGltZSk7aWYoIWRhdGUpe2ludmFsaWRSb3dzKys7Y29udGludWU7fQogICAgICBjb25zdCBwYXJzZWQ9ey4uLmRhdGUsdmFsdWVzOnt9fTsKICAgICAgZm9yKGNvbnN0IGhlYWRlciBvZiBoZWFkZXJzKXtpZihoZWFkZXIhPT0iRGF0ZVRpbWUiKXBhcnNlZC52YWx1ZXNbaGVhZGVyXT12YWlsbGFudENzdk51bWJlcihyYXdbaGVhZGVyXSk7fQogICAgICByb3dzLnB1c2gocGFyc2VkKTsKICAgIH0KICAgIHJldHVybiB7aW5kZXgsdHlwZSxoZWFkZXJzLHJvd3MsaW52YWxpZFJvd3N9OwogIH0KICBmdW5jdGlvbiBzYW1lVmFpbGxhbnRWYWx1ZShhLGIsdG9sZXJhbmNlPS4wNSl7CiAgICBpZihhPT1udWxsfHxiPT1udWxsKXJldHVybiBhPT1udWxsJiZiPT1udWxsOwogICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoYSkpJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGIpKT9NYXRoLmFicyhOdW1iZXIoYSktTnVtYmVyKGIpKTw9dG9sZXJhbmNlOlN0cmluZyhhKT09PVN0cmluZyhiKTsKICB9CiAgZnVuY3Rpb24gYnVpbGRWYWlsbGFudEltcG9ydFByZXZpZXcocGFyc2VkRmlsZXMpewogICAgY29uc3QgZW5lcmd5VHlwZXM9WyJhcm90aGVybS1lbmVyZ3kiLCJ1bml0b3dlci1lbmVyZ3kiXTsKICAgIGNvbnN0IGRhaWx5PXsiYXJvdGhlcm0tZW5lcmd5IjpuZXcgTWFwKCksInVuaXRvd2VyLWVuZXJneSI6bmV3IE1hcCgpfTsKICAgIGNvbnN0IGNvbmZsaWN0TW9udGhzPW5ldyBTZXQoKTtsZXQgZHVwbGljYXRlUm93cz0wOwogICAgZm9yKGNvbnN0IGZpbGUgb2YgcGFyc2VkRmlsZXMuZmlsdGVyKGY9PmVuZXJneVR5cGVzLmluY2x1ZGVzKGYudHlwZSkpKXsKICAgICAgY29uc3QgdGFyZ2V0PWRhaWx5W2ZpbGUudHlwZV07CiAgICAgIGZvcihjb25zdCByb3cgb2YgZmlsZS5yb3dzKXsKICAgICAgICBjb25zdCBleGlzdGluZz10YXJnZXQuZ2V0KHJvdy5kYXRlS2V5KTsKICAgICAgICBpZighZXhpc3Rpbmcpe3RhcmdldC5zZXQocm93LmRhdGVLZXkscm93KTtjb250aW51ZTt9CiAgICAgICAgY29uc3QgbWV0cmljcz1uZXcgU2V0KFsuLi5PYmplY3Qua2V5cyhleGlzdGluZy52YWx1ZXN8fHt9KSwuLi5PYmplY3Qua2V5cyhyb3cudmFsdWVzfHx7fSldKTsKICAgICAgICBjb25zdCBkaWZmZXJzPVsuLi5tZXRyaWNzXS5zb21lKG1ldHJpYz0+IXNhbWVWYWlsbGFudFZhbHVlKGV4aXN0aW5nLnZhbHVlcz8uW21ldHJpY10scm93LnZhbHVlcz8uW21ldHJpY10pKTsKICAgICAgICBpZihkaWZmZXJzKWNvbmZsaWN0TW9udGhzLmFkZChyb3cubW9udGhLZXkpO2Vsc2UgZHVwbGljYXRlUm93cysrOwogICAgICB9CiAgICB9CiAgICBjb25zdCBhbGxEYXRlcz1bLi4ubmV3IFNldChbLi4uZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLmtleXMoKSwuLi5kYWlseVsidW5pdG93ZXItZW5lcmd5Il0ua2V5cygpXSldOwogICAgY29uc3QgbW9udGhLZXlzPVsuLi5uZXcgU2V0KGFsbERhdGVzLm1hcChkPT5kLnNsaWNlKDAsNykpKV0uc29ydCgpOwogICAgY29uc3Qgc3VtPShtYXAsZGF0ZXMsbWV0cmljKT0+ZGF0ZXMucmVkdWNlKChzLGtleSk9Pntjb25zdCB2PW1hcC5nZXQoa2V5KT8udmFsdWVzPy5bbWV0cmljXTtyZXR1cm4gcysoTnVtYmVyLmlzRmluaXRlKHYpP3Y6MCk7fSwwKTsKICAgIGNvbnN0IGZ1bGw9KGRhdGVzLHksbSk9Pntjb25zdCBleHBlY3RlZD1uZXcgRGF0ZSh5LG0sMCkuZ2V0RGF0ZSgpLHU9Wy4uLm5ldyBTZXQoZGF0ZXMpXS5zb3J0KCk7cmV0dXJuIHUubGVuZ3RoPT09ZXhwZWN0ZWQmJnVbMF09PT1gJHt5fS0ke1N0cmluZyhtKS5wYWRTdGFydCgyLCIwIil9LTAxYCYmdS5hdCgtMSk9PT1gJHt5fS0ke1N0cmluZyhtKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKGV4cGVjdGVkKS5wYWRTdGFydCgyLCIwIil9YDt9OwogICAgY29uc3QgY3VycmVudD1jdXJyZW50TW9udGhLZXkoKTsKICAgIGNvbnN0IG1vbnRocz1tb250aEtleXMubWFwKG1vbnRoPT57CiAgICAgIGNvbnN0IHk9TnVtYmVyKG1vbnRoLnNsaWNlKDAsNCkpLG09TnVtYmVyKG1vbnRoLnNsaWNlKDUsNykpOwogICAgICBjb25zdCBhcm89Wy4uLmRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXS5rZXlzKCldLmZpbHRlcihrPT5rLnN0YXJ0c1dpdGgoYCR7bW9udGh9LWApKS5zb3J0KCk7CiAgICAgIGNvbnN0IHVuaT1bLi4uZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLmtleXMoKV0uZmlsdGVyKGs9Pmsuc3RhcnRzV2l0aChgJHttb250aH0tYCkpLnNvcnQoKTsKICAgICAgY29uc3QgdW5pb249Wy4uLm5ldyBTZXQoWy4uLmFybywuLi51bmldKV0uc29ydCgpOwogICAgICBjb25zdCBjb21wbGV0ZT1mdWxsKGFybyx5LG0pJiZmdWxsKHVuaSx5LG0pOwogICAgICBjb25zdCBoZWF0aW5nRWxlY3RyaWNpdHk9KHN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpK3N1bShkYWlseVsidW5pdG93ZXItZW5lcmd5Il0sdW5pLCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpKS8xMDAwOwogICAgICBjb25zdCBkaHdFbGVjdHJpY2l0eT1zdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkRvbWVzdGljSG90V2F0ZXIiKS8xMDAwOwogICAgICBjb25zdCBoZWF0aW5nSGVhdD0oc3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpK3N1bShkYWlseVsidW5pdG93ZXItZW5lcmd5Il0sdW5pLCJIZWF0R2VuZXJhdGVkOkhlYXRpbmciKSkvMTAwMDsKICAgICAgY29uc3QgZGh3SGVhdD1zdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiSGVhdEdlbmVyYXRlZDpEb21lc3RpY0hvdFdhdGVyIikvMTAwMDsKICAgICAgY29uc3QgZWxlY3RyaWNpdHlLV2g9aGVhdGluZ0VsZWN0cmljaXR5K2Rod0VsZWN0cmljaXR5LGhlYXRHZW5lcmF0ZWRLV2g9aGVhdGluZ0hlYXQrZGh3SGVhdDsKICAgICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgobW9udGgpOwogICAgICBjb25zdCBuZWdhdGl2ZVJlc3Q9Qm9vbGVhbihleGlzdGluZyYmTnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLnRvdGFsKSYmTnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmFubmV4KSYmZXhpc3RpbmcudG90YWwtZWxlY3RyaWNpdHlLV2gtZXhpc3RpbmcuYW5uZXg8LS4wMSk7CiAgICAgIGNvbnN0IGhhc0NvbmZsaWN0PWNvbmZsaWN0TW9udGhzLmhhcyhtb250aCksaGFzQm90aD1hcm8ubGVuZ3RoPjAmJnVuaS5sZW5ndGg+MCxpc0N1cnJlbnQ9bW9udGg9PT1jdXJyZW50LGlzRnV0dXJlPW1vbnRoPmN1cnJlbnQ7CiAgICAgIGNvbnN0IGJsb2NrZWQ9IWhhc0JvdGh8fGhhc0NvbmZsaWN0fHxuZWdhdGl2ZVJlc3R8fGlzRnV0dXJlfHwoIWNvbXBsZXRlJiYhaXNDdXJyZW50KTsKICAgICAgcmV0dXJuIHttb250aCxlbGVjdHJpY2l0eUtXaCxoZWF0R2VuZXJhdGVkS1doLGhlYXRpbmdFbGVjdHJpY2l0eUtXaDpoZWF0aW5nRWxlY3RyaWNpdHksZGh3RWxlY3RyaWNpdHlLV2g6ZGh3RWxlY3RyaWNpdHksaGVhdGluZ0hlYXRLV2g6aGVhdGluZ0hlYXQsZGh3SGVhdEtXaDpkaHdIZWF0LGNvbXBsZXRlLGNvdmVyYWdlU3RhcnQ6dW5pb25bMF18fG51bGwsY292ZXJhZ2VFbmQ6dW5pb24uYXQoLTEpfHxudWxsLGJsb2NrZWQsaGFzQm90aCxoYXNDb25mbGljdCxuZWdhdGl2ZVJlc3QsaXNDdXJyZW50fTsKICAgIH0pOwogICAgcmV0dXJuIHttb250aHMsZHVwbGljYXRlUm93cyxyZWNvZ25pemVkOnBhcnNlZEZpbGVzLmZpbHRlcihmPT5mLnR5cGUhPT0idW5rbm93biIpLmxlbmd0aCx1bmtub3duOnBhcnNlZEZpbGVzLmZpbHRlcihmPT5mLnR5cGU9PT0idW5rbm93biIpLmxlbmd0aCxpbnZhbGlkUm93czpwYXJzZWRGaWxlcy5yZWR1Y2UoKHMsZik9PnMrZi5pbnZhbGlkUm93cywwKX07CiAgfQogIGZ1bmN0aW9uIG1lcmdlVmFpbGxhbnRJbXBvcnQobW9udGhzKXsKICAgIGNvbnN0IHJlY29yZE1hcD1uZXcgTWFwKHJlY29yZHMubWFwKHI9PltyLm1vbnRoLHsuLi5yfV0pKTsKICAgIGNvbnN0IHZhaWxsYW50TWFwPW5ldyBNYXAoKHZhaWxsYW50TW9udGhzfHxbXSkubWFwKHY9Plt2Lm1vbnRoLHsuLi52fV0pKTsKICAgIGNvbnN0IHN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtsZXQgaW1wb3J0ZWQ9MCxjcmVhdGVkPTAscGFydGlhbD0wOwogICAgZm9yKGNvbnN0IG1vbnRoIG9mIG1vbnRocy5maWx0ZXIobT0+IW0uYmxvY2tlZCkpewogICAgICBjb25zdCBleGlzdGluZz1yZWNvcmRNYXAuZ2V0KG1vbnRoLm1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRoOm1vbnRoLm1vbnRofSk7CiAgICAgIGNvbnN0IHdhc05ldz0hcmVjb3JkTWFwLmhhcyhtb250aC5tb250aCk7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wPW1vbnRoLmVsZWN0cmljaXR5S1doOwogICAgICBleGlzdGluZy5oZWF0R2VuZXJhdGVkPW1vbnRoLmhlYXRHZW5lcmF0ZWRLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRpbmdFbGVjdHJpY2l0eT1tb250aC5oZWF0aW5nRWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmRod0VsZWN0cmljaXR5PW1vbnRoLmRod0VsZWN0cmljaXR5S1doOwogICAgICBleGlzdGluZy5oZWF0aW5nSGVhdD1tb250aC5oZWF0aW5nSGVhdEtXaDsKICAgICAgZXhpc3RpbmcuZGh3SGVhdD1tb250aC5kaHdIZWF0S1doOwogICAgICBleGlzdGluZy5oZWF0UHVtcFNvdXJjZT1tb250aC5jb21wbGV0ZT8ibXl2YWlsbGFudC1jc3YtaW1wb3J0IjoibXl2YWlsbGFudC1jc3YtaW1wb3J0LXBhcnRpYWwiOwogICAgICBleGlzdGluZy5oZWF0UHVtcFVwZGF0ZWRBdD1zdGFtcDsKICAgICAgZXhpc3RpbmcudXBkYXRlZEF0PXN0YW1wOwogICAgICBpZighbW9udGguY29tcGxldGUpewogICAgICAgIHBhcnRpYWwrKzsKICAgICAgICBjb25zdCBub3RlPWBteVZBSUxMQU5UIENTVi1UZWlsbW9uYXQgJHttb250aC5jb3ZlcmFnZVN0YXJ0fSBiaXMgJHttb250aC5jb3ZlcmFnZUVuZH1gOwogICAgICAgIGlmKCFTdHJpbmcoZXhpc3Rpbmcubm90ZXx8IiIpLmluY2x1ZGVzKG5vdGUpKWV4aXN0aW5nLm5vdGU9ZXhpc3Rpbmcubm90ZT9gJHtleGlzdGluZy5ub3RlfSDigKIgJHtub3RlfWA6bm90ZTsKICAgICAgICBleGlzdGluZy5jbG9zZWQ9ZmFsc2U7ZXhpc3RpbmcuY2xvc2VkQXQ9bnVsbDsKICAgICAgfQogICAgICByZWNvcmRNYXAuc2V0KG1vbnRoLm1vbnRoLGV4aXN0aW5nKTsKICAgICAgdmFpbGxhbnRNYXAuc2V0KG1vbnRoLm1vbnRoLHttb250aDptb250aC5tb250aCxlbGVjdHJpY2l0eUtXaDptb250aC5lbGVjdHJpY2l0eUtXaCxoZWF0R2VuZXJhdGVkS1doOm1vbnRoLmhlYXRHZW5lcmF0ZWRLV2gsaGVhdGluZ0VsZWN0cmljaXR5S1doOm1vbnRoLmhlYXRpbmdFbGVjdHJpY2l0eUtXaCxkaHdFbGVjdHJpY2l0eUtXaDptb250aC5kaHdFbGVjdHJpY2l0eUtXaCxoZWF0aW5nSGVhdEtXaDptb250aC5oZWF0aW5nSGVhdEtXaCxkaHdIZWF0S1doOm1vbnRoLmRod0hlYXRLV2gsc291cmNlOmV4aXN0aW5nLmhlYXRQdW1wU291cmNlLGVzdGltYXRlZDohbW9udGguY29tcGxldGUsdXBkYXRlZEF0OnN0YW1wfSk7CiAgICAgIGltcG9ydGVkKys7aWYod2FzTmV3KWNyZWF0ZWQrKzsKICAgIH0KICAgIHNhdmVSZWNvcmRzKFsuLi5yZWNvcmRNYXAudmFsdWVzKCldLHtyZWFzb246Im15VkFJTExBTlQgQ1NWIGltcG9ydGllcnQifSk7CiAgICB2YWlsbGFudE1vbnRocz1bLi4udmFpbGxhbnRNYXAudmFsdWVzKCldLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7c2F2ZVZhaWxsYW50TW9udGhzKCk7CiAgICByZXR1cm4ge2ltcG9ydGVkLGNyZWF0ZWQscGFydGlhbH07CiAgfQogIGFzeW5jIGZ1bmN0aW9uIGltcG9ydFZhaWxsYW50Q3N2RmlsZXMoZmlsZUxpc3QpewogICAgY29uc3QgZmlsZXM9Wy4uLihmaWxlTGlzdHx8W10pXTsKICAgIGlmKCFmaWxlcy5sZW5ndGgpcmV0dXJuOwogICAgc2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsIkRhdGVpZW4gd2VyZGVuIGxva2FsIGdlcHLDvGZ0IOKApiIpOwogICAgdHJ5ewogICAgICBjb25zdCBwYXJzZWQ9W107CiAgICAgIGZvcihsZXQgaT0wO2k8ZmlsZXMubGVuZ3RoO2krKylwYXJzZWQucHVzaChwYXJzZVZhaWxsYW50Q3N2VGV4dChhd2FpdCBmaWxlc1tpXS50ZXh0KCksaSkpOwogICAgICBjb25zdCBwcmV2aWV3PWJ1aWxkVmFpbGxhbnRJbXBvcnRQcmV2aWV3KHBhcnNlZCk7CiAgICAgIGNvbnN0IGltcG9ydGFibGU9cHJldmlldy5tb250aHMuZmlsdGVyKG09PiFtLmJsb2NrZWQpOwogICAgICBjb25zdCBtaXNzaW5nQXJvPSFwYXJzZWQuc29tZShmPT5mLnR5cGU9PT0iYXJvdGhlcm0tZW5lcmd5IiksbWlzc2luZ1VuaT0hcGFyc2VkLnNvbWUoZj0+Zi50eXBlPT09InVuaXRvd2VyLWVuZXJneSIpOwogICAgICBpZihtaXNzaW5nQXJvfHxtaXNzaW5nVW5pKXRocm93IG5ldyBFcnJvcihgRXMgZmVobGVuICR7W21pc3NpbmdBcm8/ImFyb1RIRVJNLUVuZXJnaWUiOm51bGwsbWlzc2luZ1VuaT8idW5pVE9XRVItRW5lcmdpZSI6bnVsbF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIiB1bmQgIil9LiBCaXR0ZSBiZWlkZSBFeHBvcnRkYXRlaWVuIGF1c3fDpGhsZW4uYCk7CiAgICAgIGlmKCFwcmV2aWV3Lm1vbnRocy5sZW5ndGgpdGhyb3cgbmV3IEVycm9yKCJLZWluZSBXw6RybWVwdW1wZW4tTW9uYXRzZGF0ZW4gZXJrYW5udC4iKTsKICAgICAgaWYoIWltcG9ydGFibGUubGVuZ3RoKXsKICAgICAgICBjb25zdCBibG9ja2VkPXByZXZpZXcubW9udGhzLm1hcChtPT5gJHttb250aExhYmVsKG0ubW9udGgsZmFsc2UpfTogJHttLmhhc0NvbmZsaWN0PyJLb25mbGlrdCI6bS5uZWdhdGl2ZVJlc3Q/InVucGxhdXNpYmxlciBSZXN0dmVyYnJhdWNoIjohbS5oYXNCb3RoPyJEYXRlaSBmZWhsdCI6IW0uY29tcGxldGUmJiFtLmlzQ3VycmVudD8iaGlzdG9yaXNjaGVyIFRlaWxtb25hdCI6Im5pY2h0IGltcG9ydGllcmJhciJ9YCkuam9pbigiIOKAoiAiKTsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEtlaW5lIGltcG9ydGllcmJhcmVuIE1vbmF0ZS4gJHtibG9ja2VkfWApOwogICAgICB9CiAgICAgIGNvbnN0IGJsb2NrZWRDb3VudD1wcmV2aWV3Lm1vbnRocy5sZW5ndGgtaW1wb3J0YWJsZS5sZW5ndGg7CiAgICAgIGNvbnN0IG1lc3NhZ2U9YCR7aW1wb3J0YWJsZS5sZW5ndGh9IE1vbmF0KGUpIGltcG9ydGllcmVuPyR7YmxvY2tlZENvdW50P2AgJHtibG9ja2VkQ291bnR9IHVudm9sbHN0w6RuZGlnZS9hdWZmw6RsbGlnZSBNb25hdGUgd2VyZGVuIMO8YmVyc3BydW5nZW4uYDoiIn0gR2VzYW10dmVyYnJhdWNoLCBBbHRlbnRlaWwsIFByZWlzZSB1bmQgTm90aXplbiBibGVpYmVuIGVyaGFsdGVuLmA7CiAgICAgIGlmKCFjb25maXJtKG1lc3NhZ2UpKXtzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIiwiSW1wb3J0IGFiZ2Vicm9jaGVuLiIpO3JldHVybjt9CiAgICAgIGNvbnN0IHJlc3VsdD1tZXJnZVZhaWxsYW50SW1wb3J0KGltcG9ydGFibGUpOwogICAgICByZW5kZXJBbGwoKTsKICAgICAgc2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsYCR7cmVzdWx0LmltcG9ydGVkfSBNb25hdChlKSBpbXBvcnRpZXJ0JHtyZXN1bHQucGFydGlhbD9gIMK3ICR7cmVzdWx0LnBhcnRpYWx9IGFrdHVlbGxlciBUZWlsbW9uYXRgOiIifSR7YmxvY2tlZENvdW50P2AgwrcgJHtibG9ja2VkQ291bnR9IMO8YmVyc3BydW5nZW5gOiIifS5gLCJvayIpOwogICAgICB0b2FzdChgJHtyZXN1bHQuaW1wb3J0ZWR9IFfDpHJtZXB1bXBlbi1Nb25hdGUgaW1wb3J0aWVydGApOwogICAgfWNhdGNoKGVycm9yKXtzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIixlcnJvci5tZXNzYWdlLCJlcnJvciIpO30KICAgIGZpbmFsbHl7JCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikudmFsdWU9IiI7fQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gb3N0cm9tRmV0Y2gocGF0aCl7CiAgICBpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXRocm93IG5ldyBFcnJvcigiQXBwLVNjaGzDvHNzZWwgZmVobHQuIik7CiAgICBjb25zdCByZXNwb25zZT1hd2FpdCBmZXRjaChwYXRoLHtoZWFkZXJzOnsieC1lbGRlaG9mLWtleSI6c2V0dGluZ3Mub3N0cm9tQXBwS2V5LCJhY2NlcHQiOiJhcHBsaWNhdGlvbi9qc29uIn0sY2FjaGU6Im5vLXN0b3JlIn0pOyBjb25zdCB0ZXh0PWF3YWl0IHJlc3BvbnNlLnRleHQoKTsgbGV0IHBheWxvYWQ9e307IHRyeXtwYXlsb2FkPXRleHQ/SlNPTi5wYXJzZSh0ZXh0KTp7fTt9Y2F0Y2h7fQogICAgaWYoIXJlc3BvbnNlLm9rKXRocm93IG5ldyBFcnJvcihwYXlsb2FkLmVycm9yfHxwYXlsb2FkLm1lc3NhZ2V8fHRleHR8fGBGZWhsZXIgJHtyZXNwb25zZS5zdGF0dXN9YCk7IHJldHVybiBwYXlsb2FkOwogIH0KICBhc3luYyBmdW5jdGlvbiByZWZyZXNoT3N0cm9tKHNob3dUb2FzdD1mYWxzZSl7CiAgICBpZihvc3Ryb21CdXN5fHwhc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTtyZXR1cm4gZmFsc2U7fQogICAgb3N0cm9tQnVzeT10cnVlO3JlbmRlck9zdHJvbURhc2hib2FyZCgpOwogICAgdHJ5eyBjb25zdCBwYXlsb2FkPWF3YWl0IG9zdHJvbUZldGNoKGAvYXBpL2xpdmUke3Nob3dUb2FzdD8iP3JlZnJlc2g9MSI6IiJ9YCk7IHNhdmVPc3Ryb21DYWNoZShwYXlsb2FkKTsgaWYoc2hvd1RvYXN0KXRvYXN0KCJPc3Ryb20gYWt0dWFsaXNpZXJ0Iik7IHJldHVybiB0cnVlOyB9CiAgICBjYXRjaChlcnJvcil7IHNldE9zdHJvbVN0YXR1cyhgRmVobGVyOiAke2Vycm9yLm1lc3NhZ2V9YCwiZXJyb3IiKTsgaWYoc2hvd1RvYXN0KXRvYXN0KGBPc3Ryb206ICR7ZXJyb3IubWVzc2FnZX1gKTsgcmV0dXJuIGZhbHNlOyB9CiAgICBmaW5hbGx5e29zdHJvbUJ1c3k9ZmFsc2U7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7fQogIH0KICBmdW5jdGlvbiBzY2hlZHVsZU9zdHJvbSgpeyBjbGVhckludGVydmFsKG9zdHJvbVRpbWVyKTtvc3Ryb21UaW1lcj1udWxsOyBpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkmJnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoIT09ZmFsc2Upb3N0cm9tVGltZXI9c2V0SW50ZXJ2YWwoKCk9PnJlZnJlc2hPc3Ryb20oZmFsc2UpLDEwKjYwKjEwMDApOyB9CiAgZnVuY3Rpb24gc2V0T3N0cm9tU3RhdHVzKHRleHQsa2luZD0iIil7IGNvbnN0IGVsPSQoIm9zdHJvbVN0YXR1cyIpO2VsLnRleHRDb250ZW50PXRleHQ7ZWwuc3R5bGUuY29sb3I9a2luZD09PSJlcnJvciI/IiNmZmFhYTkiOiIiOyB9CiAgZnVuY3Rpb24gZm9ybWF0RGF0ZVRpbWUodmFsdWUpeyBjb25zdCBkPW5ldyBEYXRlKHZhbHVlKTsgaWYoTnVtYmVyLmlzTmFOKGQudmFsdWVPZigpKSlyZXR1cm4gIuKAkyI7IHJldHVybiBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHt3ZWVrZGF5OiJzaG9ydCIsZGF5OiIyLWRpZ2l0Iixtb250aDoiMi1kaWdpdCIsaG91cjoiMi1kaWdpdCIsbWludXRlOiIyLWRpZ2l0In0pLmZvcm1hdChkKTsgfQogIGZ1bmN0aW9uIGludGVydmFsUm93cygpeyByZXR1cm4gKEFycmF5LmlzQXJyYXkob3N0cm9tTGl2ZT8ucHJpY2VGb3JlY2FzdCk/b3N0cm9tTGl2ZS5wcmljZUZvcmVjYXN0OltdKS5tYXAocD0+KHt0aW1lOm5ldyBEYXRlKHAuZGF0ZXx8cC5zdGFydHx8cC50aW1lc3RhbXApLmdldFRpbWUoKSxwcmljZTpOdW1iZXIocC50b3RhbEN0UGVyS1doPz9wLnByaWNlQ3RQZXJLV2g/P3AucHJpY2UpfSkpLmZpbHRlcihwPT5OdW1iZXIuaXNGaW5pdGUocC50aW1lKSYmTnVtYmVyLmlzRmluaXRlKHAucHJpY2UpKS5zb3J0KChhLGIpPT5hLnRpbWUtYi50aW1lKTsgfQogIGZ1bmN0aW9uIGluZmVyU3RlcChyb3dzKXsgY29uc3QgZGlmZnM9W107Zm9yKGxldCBpPTE7aTxyb3dzLmxlbmd0aDtpKyspe2NvbnN0IGQ9cm93c1tpXS50aW1lLXJvd3NbaS0xXS50aW1lO2lmKGQ+PTUqNjBlMyYmZDw9MiozNjAwZTMpZGlmZnMucHVzaChkKTt9IGlmKCFkaWZmcy5sZW5ndGgpcmV0dXJuIDM2MDBlMztkaWZmcy5zb3J0KChhLGIpPT5hLWIpO3JldHVybiBkaWZmc1tNYXRoLmZsb29yKGRpZmZzLmxlbmd0aC8yKV07IH0KICBmdW5jdGlvbiBjb21wdXRlUHJpY2VXaW5kb3cocm93cyxob3Vycyxtb2RlKXsKICAgIGlmKCFyb3dzLmxlbmd0aClyZXR1cm4gbnVsbDsgY29uc3Qgc3RlcD1pbmZlclN0ZXAocm93cyk7IGNvbnN0IGNvdW50PU1hdGgubWF4KDEsTWF0aC5yb3VuZChob3VycyozNjAwZTMvc3RlcCkpOyBjb25zdCBub3c9RGF0ZS5ub3coKTsgY29uc3QgcG9vbD1yb3dzLmZpbHRlcihyPT5yLnRpbWU+PW5vdy1zdGVwKS5zbGljZSgwLE1hdGgubWF4KGNvdW50LE1hdGgucm91bmQoNDgqMzYwMGUzL3N0ZXApKSk7CiAgICBsZXQgYmVzdD1udWxsOwogICAgZm9yKGxldCBpPTA7aStjb3VudDw9cG9vbC5sZW5ndGg7aSsrKXtjb25zdCBzbGljZT1wb29sLnNsaWNlKGksaStjb3VudCk7bGV0IGNvbnRpZ3VvdXM9dHJ1ZTtmb3IobGV0IGo9MTtqPHNsaWNlLmxlbmd0aDtqKyspaWYoc2xpY2Vbal0udGltZS1zbGljZVtqLTFdLnRpbWU+c3RlcCoxLjYpe2NvbnRpZ3VvdXM9ZmFsc2U7YnJlYWs7fWlmKCFjb250aWd1b3VzKWNvbnRpbnVlO2NvbnN0IGF2Zz1zbGljZS5yZWR1Y2UoKHMscik9PnMrci5wcmljZSwwKS9zbGljZS5sZW5ndGg7Y29uc3QgY2FuZGlkYXRlPXtzdGFydDpzbGljZVswXS50aW1lLGVuZDpzbGljZS5hdCgtMSkudGltZStzdGVwLGF2Z307aWYoIWJlc3R8fChtb2RlPT09Im1pbiI/YXZnPGJlc3QuYXZnOmF2Zz5iZXN0LmF2ZykpYmVzdD1jYW5kaWRhdGU7fQogICAgcmV0dXJuIGJlc3Q7CiAgfQogIGZ1bmN0aW9uIHJlbmRlck9zdHJvbURhc2hib2FyZCgpewogICAgY29uc3QgY2FuUmVmcmVzaD1Cb29sZWFuKHNldHRpbmdzLm9zdHJvbUFwcEtleSk7CiAgICBjb25zdCBoYXNTeW5jZWREYXRhPUJvb2xlYW4ob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXQpOwogICAgY29uc3QgdmlzaWJsZT1jYW5SZWZyZXNofHxoYXNTeW5jZWREYXRhOwogICAgJCgib3N0cm9tU2V0dXBIaW50IikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIix2aXNpYmxlKTsKICAgICQoIm9zdHJvbURhc2hib2FyZCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIXZpc2libGUpOwogICAgJCgib3N0cm9tTWluaUNoYXJ0IikucGFyZW50RWxlbWVudC5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCF2aXNpYmxlKTsKICAgICQoInJlZnJlc2hPc3Ryb21CdG4iKS5kaXNhYmxlZD0hY2FuUmVmcmVzaHx8b3N0cm9tQnVzeTsKICAgIGlmKCF2aXNpYmxlKXsgc2V0T3N0cm9tU3RhdHVzKCJOaWNodCB2ZXJidW5kZW4iKTsgcmV0dXJuOyB9CiAgICBpZihvc3Ryb21CdXN5KXNldE9zdHJvbVN0YXR1cygiQWt0dWFsaXNpZXJ1bmcgbMOkdWZ0IOKApiIpOwogICAgZWxzZSBpZihoYXNTeW5jZWREYXRhJiYhY2FuUmVmcmVzaClzZXRPc3Ryb21TdGF0dXMoYFZvbSBhbmRlcmVuIEdlcsOkdCBzeW5jaHJvbmlzaWVydCDCtyAke2Zvcm1hdERhdGVUaW1lKG9zdHJvbUxpdmUuZ2VuZXJhdGVkQXQpfWApOwogICAgZWxzZSBpZihoYXNTeW5jZWREYXRhKXNldE9zdHJvbVN0YXR1cyhgQWt0dWFsaXNpZXJ0ICR7Zm9ybWF0RGF0ZVRpbWUob3N0cm9tTGl2ZS5nZW5lcmF0ZWRBdCl9YCk7CiAgICBlbHNlIHNldE9zdHJvbVN0YXR1cygiTm9jaCBrZWluZSBMaXZlLURhdGVuIik7CiAgICBjb25zdCByb3dzPWludGVydmFsUm93cygpOyBpZighcm93cy5sZW5ndGgpeyBbIm9zdHJvbUN1cnJlbnRQcmljZSIsIm9zdHJvbUJlc3RQcmljZSIsIm9zdHJvbVdvcnN0UHJpY2UiXS5mb3JFYWNoKGlkPT4kKGlkKS50ZXh0Q29udGVudD0i4oCTIik7IFsib3N0cm9tQ3VycmVudE1ldGEiLCJvc3Ryb21CZXN0TWV0YSIsIm9zdHJvbVdvcnN0TWV0YSJdLmZvckVhY2goaWQ9PiQoaWQpLnRleHRDb250ZW50PSJOb2NoIGtlaW5lIFByZWlzdm9yc2NoYXUiKTsgZHJhd09zdHJvbU1pbmkoW10pOyByZXR1cm47IH0KICAgIGNvbnN0IG5vdz1EYXRlLm5vdygpLHN0ZXA9aW5mZXJTdGVwKHJvd3MpOyBjb25zdCBjdXJyZW50PXJvd3MuZmluZCgocixpKT0+ci50aW1lPD1ub3cmJihyb3dzW2krMV0/LnRpbWU/P3IudGltZStzdGVwKT5ub3cpfHxyb3dzLmZpbmQocj0+ci50aW1lPm5vdyl8fHJvd3MuYXQoLTEpOyBjb25zdCBob3Vycz1OdW1iZXIoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnMpfHwzOyBjb25zdCBiZXN0PWNvbXB1dGVQcmljZVdpbmRvdyhyb3dzLGhvdXJzLCJtaW4iKSwgd29yc3Q9Y29tcHV0ZVByaWNlV2luZG93KHJvd3MsaG91cnMsIm1heCIpOwogICAgJCgib3N0cm9tQmVzdExhYmVsIikudGV4dENvbnRlbnQ9YEJlc3RlcyAke2hvdXJzfWgtRmVuc3RlcmA7ICQoIm9zdHJvbVdvcnN0TGFiZWwiKS50ZXh0Q29udGVudD1gU2NobGVjaHRlc3RlcyAke2hvdXJzfWgtRmVuc3RlcmA7CiAgICAkKCJvc3Ryb21DdXJyZW50UHJpY2UiKS50ZXh0Q29udGVudD1gJHtudW0oY3VycmVudD8ucHJpY2UsMil9IGN0L2tXaGA7ICQoIm9zdHJvbUN1cnJlbnRNZXRhIikudGV4dENvbnRlbnQ9Y3VycmVudD9mb3JtYXREYXRlVGltZShjdXJyZW50LnRpbWUpOiLigJMiOwogICAgJCgib3N0cm9tQmVzdFByaWNlIikudGV4dENvbnRlbnQ9YmVzdD9gJHtudW0oYmVzdC5hdmcsMil9IGN0L2tXaGA6IuKAkyI7ICQoIm9zdHJvbUJlc3RNZXRhIikudGV4dENvbnRlbnQ9YmVzdD9gJHtmb3JtYXREYXRlVGltZShiZXN0LnN0YXJ0KX0g4oCTICR7bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCIsbWludXRlOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZShiZXN0LmVuZCkpfWA6IuKAkyI7CiAgICAkKCJvc3Ryb21Xb3JzdFByaWNlIikudGV4dENvbnRlbnQ9d29yc3Q/YCR7bnVtKHdvcnN0LmF2ZywyKX0gY3Qva1doYDoi4oCTIjsgJCgib3N0cm9tV29yc3RNZXRhIikudGV4dENvbnRlbnQ9d29yc3Q/YCR7Zm9ybWF0RGF0ZVRpbWUod29yc3Quc3RhcnQpfSDigJMgJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHdvcnN0LmVuZCkpfWA6IuKAkyI7CiAgICBkcmF3T3N0cm9tTWluaShyb3dzLmZpbHRlcihyPT5yLnRpbWU+PW5vdy1zdGVwKS5zbGljZSgwLDQ4KSk7CiAgfQogIGZ1bmN0aW9uIGRyYXdPc3Ryb21NaW5pKHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJvc3Ryb21NaW5pQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGlmKCFyb3dzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsIktlaW5lIE9zdHJvbS1QcmVpc2RhdGVuIik7cmV0dXJuO30gY29uc3QgbWluPU1hdGgubWluKC4uLnJvd3MubWFwKHI9PnIucHJpY2UpKSxtYXg9TWF0aC5tYXgoLi4ucm93cy5tYXAocj0+ci5wcmljZSkpLHNwYW49TWF0aC5tYXgoMSxtYXgtbWluKTsgY29uc3QgcGFkPXtsOjQzLHI6OCx0OjEyLGI6MzB9LHc9d2lkdGgtcGFkLmwtcGFkLnIsaD1oZWlnaHQtcGFkLnQtcGFkLmI7CiAgICBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLmdyaWQ7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZm9udD0iMTBweCBzYW5zLXNlcmlmIjtmb3IobGV0IGk9MDtpPD0zO2krKyl7Y29uc3QgeT1wYWQudCtoKmkvMztjdHguYmVnaW5QYXRoKCk7Y3R4Lm1vdmVUbyhwYWQubCx5KTtjdHgubGluZVRvKHdpZHRoLXBhZC5yLHkpO2N0eC5zdHJva2UoKTtjdHguZmlsbFRleHQobnVtKG1heC1zcGFuKmkvMywwKSw0LHkrMyk7fSBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLnRvdGFsO2N0eC5saW5lV2lkdGg9MjtjdHguYmVnaW5QYXRoKCk7cm93cy5mb3JFYWNoKChyLGkpPT57Y29uc3QgeD1wYWQubCsocm93cy5sZW5ndGg9PT0xP3cvMjp3KmkvKHJvd3MubGVuZ3RoLTEpKSx5PXBhZC50K2gqKDEtKHIucHJpY2UtbWluKS9zcGFuKTtpP2N0eC5saW5lVG8oeCx5KTpjdHgubW92ZVRvKHgseSk7fSk7Y3R4LnN0cm9rZSgpOwogICAgY29uc3Qgc3RlcD1NYXRoLm1heCgxLE1hdGguZmxvb3Iocm93cy5sZW5ndGgvNSkpOyByb3dzLmZvckVhY2goKHIsaSk9PntpZihpJXN0ZXAmJmkhPT1yb3dzLmxlbmd0aC0xKXJldHVybjtjb25zdCB4PXBhZC5sKyhyb3dzLmxlbmd0aD09PTE/dy8yOncqaS8ocm93cy5sZW5ndGgtMSkpO2N0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7Y3R4LmZpbGxUZXh0KG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHIudGltZSkpLHgtOCxoZWlnaHQtOSk7fSk7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIHNhdmVBbmRDaGVja09zdHJvbSgpewogICAgY29uc3Qga2V5PSQoIm9zdHJvbUFwcEtleUlucHV0IikudmFsdWUudHJpbSgpOyBzZXR0aW5ncy5vc3Ryb21BcHBLZXk9a2V5OyBzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaD0kKCJvc3Ryb21BdXRvUmVmcmVzaElucHV0IikuY2hlY2tlZDsgc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnM9TnVtYmVyKCQoInByZWZlcnJlZFdpbmRvd0hvdXJzSW5wdXQiKS52YWx1ZSl8fDM7IHNhdmVTZXR0aW5ncygpOwogICAgaWYoIWtleSl7c2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiQml0dGUgQXBwLVNjaGzDvHNzZWwgZWludHJhZ2VuLiIsImVycm9yIik7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7cmV0dXJuO30KICAgIHNldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIlZlcmJpbmR1bmcgd2lyZCBnZXByw7xmdCDigKYiKTsKICAgIHRyeXsgY29uc3QgaGVhbHRoPWF3YWl0IG9zdHJvbUZldGNoKCIvYXBpL2hlYWx0aD9kZWVwPXRva2VuIik7IGlmKCFoZWFsdGguY29uZmlndXJlZCl0aHJvdyBuZXcgRXJyb3IoIkNsb3VkZmxhcmUtU2VjcmV0cyBzaW5kIG5pY2h0IHZvbGxzdMOkbmRpZyBlaW5nZXJpY2h0ZXQuIik7IHNldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIk9zdHJvbS1WZXJiaW5kdW5nIGVyZm9sZ3JlaWNoLiIsIm9rIik7IGF3YWl0IHJlZnJlc2hPc3Ryb20odHJ1ZSk7IHNjaGVkdWxlT3N0cm9tKCk7IHJlbmRlckFsbCgpOyB9CiAgICBjYXRjaChlcnJvcil7c2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIixlcnJvci5tZXNzYWdlLCJlcnJvciIpO30KICB9CiAgZnVuY3Rpb24gZGlzY29ubmVjdE9zdHJvbSgpeyBpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkmJiFjb25maXJtKCJPc3Ryb20tVmVyYmluZHVuZyB3aXJrbGljaCBlbnRmZXJuZW4/IikpcmV0dXJuOyBzZXR0aW5ncy5vc3Ryb21BcHBLZXk9IiI7c2F2ZVNldHRpbmdzKCk7c2F2ZU9zdHJvbUNhY2hlKG51bGwpO2xvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKE9TVFJPTV9DT05UUk9MX0tFWSk7c2NoZWR1bGVPc3Ryb20oKTtyZW5kZXJBbGwoKTtzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJWZXJiaW5kdW5nIGVudGZlcm50LiIpO3RvYXN0KCJPc3Ryb20gZ2V0cmVubnQiKTsgfQoKCiAgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE9zdHJvbUhpc3Rvcnkoe3NpbGVudD1mYWxzZSxvbmx5TWlzc2luZz1mYWxzZSxtYXhNb250aHM9SW5maW5pdHl9PXt9KXsKICAgIGlmKG9zdHJvbUhpc3RvcnlCdXN5KXJldHVybjsKICAgIGlmKCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe2lmKCFzaWxlbnQpdG9hc3QoIk9zdHJvbSB6dWVyc3QgdmVyYmluZGVuIik7cmV0dXJuO30KICAgIGNvbnN0IGVsaWdpYmxlPXNvcnRlZCgpLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkmJnIubW9udGg8Y3VycmVudE1vbnRoS2V5KCkpLmZpbHRlcihyPT4hb25seU1pc3Npbmd8fCFyLm9zdHJvbVByaWNlQ29tcGxldGUpOwogICAgaWYoIWVsaWdpYmxlLmxlbmd0aCl7aWYoIXNpbGVudCl0b2FzdCgiUHJlaXNoaXN0b3JpZSBpc3QgYmVyZWl0cyB2b2xsc3TDpG5kaWciKTtyZXR1cm47fQogICAgb3N0cm9tSGlzdG9yeUJ1c3k9dHJ1ZTtyZW5kZXJEYXRhKCk7CiAgICBsZXQgdXBkYXRlZD0wLHVuYXZhaWxhYmxlPTAscHJvY2Vzc2VkPTA7CiAgICBjb25zdCBtYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICB0cnl7CiAgICAgIGZvcihjb25zdCByIG9mIGVsaWdpYmxlLnNsaWNlKC1NYXRoLm1heCgxLE51bWJlcihtYXhNb250aHMpfHxlbGlnaWJsZS5sZW5ndGgpKSl7CiAgICAgICAgcHJvY2Vzc2VkKys7CiAgICAgICAgaWYoIXNpbGVudClzZXRTdGF0dXMoIm9zdHJvbUhpc3RvcnlTdGF0dXMiLGAke21vbnRoTGFiZWwoci5tb250aCxmYWxzZSl9IHdpcmQgdm9uIE9zdHJvbSBnZWxhZGVuIOKApiAoJHtwcm9jZXNzZWR9LyR7TWF0aC5taW4oZWxpZ2libGUubGVuZ3RoLG1heE1vbnRocyl9KWApOwogICAgICAgIHRyeXsKICAgICAgICAgIGNvbnN0IGRhdGE9YXdhaXQgb3N0cm9tRmV0Y2goYC9hcGkvbW9udGg/bW9udGg9JHtlbmNvZGVVUklDb21wb25lbnQoci5tb250aCl9YCk7CiAgICAgICAgICBpZighZGF0YT8uY29tcGxldGV8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKXx8IU51bWJlci5pc0Zpbml0ZShOdW1iZXIoZGF0YS50b3RhbENvc3RFdXIpKSl7dW5hdmFpbGFibGUrKztjb250aW51ZTt9CiAgICAgICAgICBjb25zdCBpdGVtPW1hcC5nZXQoci5tb250aCl8fHNhbml0aXplUmVjb3JkKHttb250aDpyLm1vbnRofSk7CiAgICAgICAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgICAgICAgICBpdGVtLnByaWNlQ3Q9TnVtYmVyKGRhdGEud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpOwogICAgICAgICAgaXRlbS5iYXNlRmVlPU51bWJlcihkYXRhLmZpeGVkQ29zdEV1cil8fDA7CiAgICAgICAgICBpdGVtLm9zdHJvbVZhcmlhYmxlQ29zdEV1cj1OdW1iZXIoZGF0YS52YXJpYWJsZUNvc3RFdXIpOwogICAgICAgICAgaXRlbS5vc3Ryb21Ub3RhbENvc3RFdXI9TnVtYmVyKGRhdGEudG90YWxDb3N0RXVyKTsKICAgICAgICAgIGl0ZW0ub3N0cm9tQ29uc3VtcHRpb25LV2g9TnVtYmVyKGRhdGEudG90YWxLV2gpOwogICAgICAgICAgaXRlbS5vc3Ryb21QcmljZUNvbXBsZXRlPXRydWU7CiAgICAgICAgICBpdGVtLnByaWNlU291cmNlPSJvc3Ryb20taG91cmx5LWNvbnN1bXB0aW9uLXdlaWdodGVkIjsKICAgICAgICAgIGl0ZW0ucHJpY2VVcGRhdGVkQXQ9c3RhbXA7CiAgICAgICAgICBpdGVtLnVwZGF0ZWRBdD1zdGFtcDsKICAgICAgICAgIG1hcC5zZXQoci5tb250aCxpdGVtKTt1cHNlcnRPc3Ryb21QcmljZVN0YXQoci5tb250aCxkYXRhLHtwYXJ0aWFsOmZhbHNlfSk7dXBkYXRlZCsrOwogICAgICAgIH1jYXRjaChlcnJvcil7dW5hdmFpbGFibGUrKzt9CiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZT0+c2V0VGltZW91dChyZXNvbHZlLDE0MCkpOwogICAgICB9CiAgICAgIGlmKHVwZGF0ZWQpc2F2ZVJlY29yZHMoWy4uLm1hcC52YWx1ZXMoKV0se3JlYXNvbjoiT3N0cm9tLVN0dW5kZW5wcmVpc2UgYWt0dWFsaXNpZXJ0In0pOwogICAgICBjb25zdCBzdGF0dXM9e3VwZGF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksdXBkYXRlZCx1bmF2YWlsYWJsZX07bG9jYWxTdG9yYWdlLnNldEl0ZW0oT1NUUk9NX0hJU1RPUllfS0VZLEpTT04uc3RyaW5naWZ5KHN0YXR1cykpOwogICAgICByZW5kZXJBbGwoKTsKICAgICAgaWYoIXNpbGVudCl0b2FzdChgJHt1cGRhdGVkfSBNb25hdChlKSBtaXQgT3N0cm9tLVN0dW5kZW5wcmVpc2VuIGFrdHVhbGlzaWVydCR7dW5hdmFpbGFibGU/YCDCtyAke3VuYXZhaWxhYmxlfSBuaWNodCB2ZXJmw7xnYmFyYDoiIn1gKTsKICAgIH1maW5hbGx5e29zdHJvbUhpc3RvcnlCdXN5PWZhbHNlO3JlbmRlckRhdGEoKTt9CiAgfQoKICBmdW5jdGlvbiBzeW5jUmFuZG9tQnl0ZXMobGVuZ3RoPTMyKXtjb25zdCBieXRlcz1uZXcgVWludDhBcnJheShsZW5ndGgpO2NyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnl0ZXMpO3JldHVybiBieXRlczt9CiAgZnVuY3Rpb24gc3luY0J5dGVzVG9CYXNlNjRVcmwoYnl0ZXMpe2xldCBiaW5hcnk9IiI7Zm9yKGxldCBpPTA7aTxieXRlcy5sZW5ndGg7aSs9ODE5MiliaW5hcnkrPVN0cmluZy5mcm9tQ2hhckNvZGUoLi4uYnl0ZXMuc3ViYXJyYXkoaSxpKzgxOTIpKTtyZXR1cm4gYnRvYShiaW5hcnkpLnJlcGxhY2VBbGwoIisiLCItIikucmVwbGFjZUFsbCgiLyIsIl8iKS5yZXBsYWNlKC89KyQvZywiIik7fQogIGZ1bmN0aW9uIHN5bmNCYXNlNjRVcmxUb0J5dGVzKHZhbHVlKXtjb25zdCByYXc9U3RyaW5nKHZhbHVlfHwiIikucmVwbGFjZUFsbCgiLSIsIisiKS5yZXBsYWNlQWxsKCJfIiwiLyIpO2NvbnN0IHBhZGRlZD1yYXcrIj0iLnJlcGVhdCgoNC1yYXcubGVuZ3RoJTQpJTQpO2NvbnN0IGJpbmFyeT1hdG9iKHBhZGRlZCk7Y29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkoYmluYXJ5Lmxlbmd0aCk7Zm9yKGxldCBpPTA7aTxiaW5hcnkubGVuZ3RoO2krKylieXRlc1tpXT1iaW5hcnkuY2hhckNvZGVBdChpKTtyZXR1cm4gYnl0ZXM7fQogIGZ1bmN0aW9uIHN5bmNSZWNvdmVyeU5vcm1hbGl6ZSh2YWx1ZSl7cmV0dXJuIFN0cmluZyh2YWx1ZXx8IiIpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW14wLTlhLWZdL2csIiIpO30KICBmdW5jdGlvbiBzeW5jUmVjb3ZlcnlGb3JtYXQodmFsdWUpe2NvbnN0IHJhdz1zeW5jUmVjb3ZlcnlOb3JtYWxpemUodmFsdWUpLnRvVXBwZXJDYXNlKCk7cmV0dXJuIHJhdy5tYXRjaCgvLnsxLDR9L2cpPy5qb2luKCItIil8fCIiO30KICBmdW5jdGlvbiBzeW5jR2VuZXJhdGVSZWNvdmVyeUtleSgpe3JldHVybiBbLi4uc3luY1JhbmRvbUJ5dGVzKDMyKV0ubWFwKGI9PmIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIjAiKSkuam9pbigiIik7fQogIGZ1bmN0aW9uIHN5bmNHZW5lcmF0ZUlkKHByZWZpeCxieXRlcz0xNil7cmV0dXJuIGAke3ByZWZpeH0tJHtzeW5jQnl0ZXNUb0Jhc2U2NFVybChzeW5jUmFuZG9tQnl0ZXMoYnl0ZXMpKX1gO30KICBmdW5jdGlvbiBsb2FkU3luY1N0YXRlKCl7CiAgICBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTWU5DX1NUQVRFX0tFWSkse30pOwogICAgcmV0dXJuIHtjb25maWd1cmVkOkJvb2xlYW4ocmF3Py5jb25maWd1cmVkKSx2YXVsdElkOlN0cmluZyhyYXc/LnZhdWx0SWR8fCIiKSxkZXZpY2VJZDpTdHJpbmcocmF3Py5kZXZpY2VJZHx8IiIpLGRldmljZU5hbWU6U3RyaW5nKHJhdz8uZGV2aWNlTmFtZXx8IiIpLGRldmljZVRva2VuOlN0cmluZyhyYXc/LmRldmljZVRva2VufHwiIikscmVjb3ZlcnlLZXk6c3luY1JlY292ZXJ5Tm9ybWFsaXplKHJhdz8ucmVjb3ZlcnlLZXl8fCIiKSxyb2xlOnJhdz8ucm9sZT09PSJhZG1pbiI/ImFkbWluIjoibWVtYmVyIixzY29wZToiZnVsbCIsc2VydmVyUmV2aXNpb246TWF0aC5tYXgoMCxOdW1iZXIocmF3Py5zZXJ2ZXJSZXZpc2lvbil8fDApLGxhc3RTeW5jQXQ6U3RyaW5nKHJhdz8ubGFzdFN5bmNBdHx8IiIpLGxhc3RFcnJvcjpTdHJpbmcocmF3Py5sYXN0RXJyb3J8fCIiKX07CiAgfQogIGZ1bmN0aW9uIHNhdmVTeW5jU3RhdGUoKXtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTWU5DX1NUQVRFX0tFWSxKU09OLnN0cmluZ2lmeShzeW5jU3RhdGUpKTt9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0Rlcml2ZUtleShyZWNvdmVyeUtleSx2YXVsdElkKXsKICAgIGNvbnN0IHJhdz1zeW5jUmVjb3ZlcnlOb3JtYWxpemUocmVjb3ZlcnlLZXkpO2lmKHJhdy5sZW5ndGghPT02NCl0aHJvdyBuZXcgRXJyb3IoIldpZWRlcmhlcnN0ZWxsdW5nc3NjaGzDvHNzZWwgaXN0IHVudm9sbHN0w6RuZGlnLiIpOwogICAgY29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkocmF3Lm1hdGNoKC8uezJ9L2cpLm1hcCh2PT5wYXJzZUludCh2LDE2KSkpO2NvbnN0IGJhc2U9YXdhaXQgY3J5cHRvLnN1YnRsZS5pbXBvcnRLZXkoInJhdyIsYnl0ZXMsIkhLREYiLGZhbHNlLFsiZGVyaXZlS2V5Il0pOwogICAgcmV0dXJuIGNyeXB0by5zdWJ0bGUuZGVyaXZlS2V5KHtuYW1lOiJIS0RGIixoYXNoOiJTSEEtMjU2IixzYWx0Om5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh2YXVsdElkKSxpbmZvOm5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSgiZWxkZWhvZi1wcml2YXRlLXN5bmMtdjEiKX0sYmFzZSx7bmFtZToiQUVTLUdDTSIsbGVuZ3RoOjI1Nn0sZmFsc2UsWyJlbmNyeXB0IiwiZGVjcnlwdCJdKTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0VuY3J5cHQocGF5bG9hZCl7Y29uc3Qga2V5PWF3YWl0IHN5bmNEZXJpdmVLZXkoc3luY1N0YXRlLnJlY292ZXJ5S2V5LHN5bmNTdGF0ZS52YXVsdElkKTtjb25zdCBpdj1zeW5jUmFuZG9tQnl0ZXMoMTIpO2NvbnN0IGFhZD1uZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoYCR7U1lOQ19FTlZFTE9QRV9TQ0hFTUF9OiR7c3luY1N0YXRlLnZhdWx0SWR9YCk7Y29uc3QgcGxhaW49bmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtjb25zdCBlbmNyeXB0ZWQ9YXdhaXQgY3J5cHRvLnN1YnRsZS5lbmNyeXB0KHtuYW1lOiJBRVMtR0NNIixpdixhZGRpdGlvbmFsRGF0YTphYWQsdGFnTGVuZ3RoOjEyOH0sa2V5LHBsYWluKTtyZXR1cm4ge3NjaGVtYTpTWU5DX0VOVkVMT1BFX1NDSEVNQSxhbGdvcml0aG06IkFFUy1HQ00tMjU2L0hLREYtU0hBLTI1NiIsaXY6c3luY0J5dGVzVG9CYXNlNjRVcmwoaXYpLGNpcGhlcnRleHQ6c3luY0J5dGVzVG9CYXNlNjRVcmwobmV3IFVpbnQ4QXJyYXkoZW5jcnlwdGVkKSksc2NvcGU6ImZ1bGwiLGNyZWF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkscGF5bG9hZEJ1aWxkOkFQUF9CVUlMRH07fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNEZWNyeXB0KGVudmVsb3BlKXtpZihlbnZlbG9wZT8uc2NoZW1hIT09U1lOQ19FTlZFTE9QRV9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJVbmJla2FubnRlcyBTeW5jLVBha2V0LiIpO2NvbnN0IGtleT1hd2FpdCBzeW5jRGVyaXZlS2V5KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSxzeW5jU3RhdGUudmF1bHRJZCk7Y29uc3QgYWFkPW5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShgJHtTWU5DX0VOVkVMT1BFX1NDSEVNQX06JHtzeW5jU3RhdGUudmF1bHRJZH1gKTtsZXQgcGxhaW47dHJ5e3BsYWluPWF3YWl0IGNyeXB0by5zdWJ0bGUuZGVjcnlwdCh7bmFtZToiQUVTLUdDTSIsaXY6c3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuaXYpLGFkZGl0aW9uYWxEYXRhOmFhZCx0YWdMZW5ndGg6MTI4fSxrZXksc3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuY2lwaGVydGV4dCkpO31jYXRjaHt0aHJvdyBuZXcgRXJyb3IoIlN5bmMtUGFrZXQga29ubnRlIG5pY2h0IGVudHNjaGzDvHNzZWx0IHdlcmRlbi4iKTt9Y29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShwbGFpbikpO2lmKHBheWxvYWQ/LnNjaGVtYSE9PVNZTkNfUEFZTE9BRF9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJTeW5jLVBha2V0IHN0YW1tdCBhdXMgZWluZXIgbmljaHQga29tcGF0aWJsZW4gRWxkZWhvZi1WZXJzaW9uLiIpO3JldHVybiBwYXlsb2FkO30KICBhc3luYyBmdW5jdGlvbiBzeW5jQXBpKHBhdGgsYm9keSl7Y29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2goYC9hcGkvc3luYy8ke3BhdGh9YCx7bWV0aG9kOiJQT1NUIixoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiIsImFjY2VwdCI6ImFwcGxpY2F0aW9uL2pzb24ifSxib2R5OkpTT04uc3RyaW5naWZ5KGJvZHkpLGNhY2hlOiJuby1zdG9yZSJ9KTtsZXQgcGF5bG9hZD17fTt0cnl7cGF5bG9hZD1hd2FpdCByZXNwb25zZS5qc29uKCk7fWNhdGNoe31pZighcmVzcG9uc2Uub2spe2NvbnN0IGVycm9yPW5ldyBFcnJvcihwYXlsb2FkLmVycm9yfHxgU3luYy1GZWhsZXIgJHtyZXNwb25zZS5zdGF0dXN9YCk7ZXJyb3Iuc3RhdHVzPXJlc3BvbnNlLnN0YXR1cztlcnJvci5wYXlsb2FkPXBheWxvYWQ7dGhyb3cgZXJyb3I7fXJldHVybiBwYXlsb2FkO30KICBmdW5jdGlvbiBzeW5jQXV0aChleHRyYT17fSl7cmV0dXJuIHt2YXVsdElkOnN5bmNTdGF0ZS52YXVsdElkLGRldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxkZXZpY2VUb2tlbjpzeW5jU3RhdGUuZGV2aWNlVG9rZW4sLi4uZXh0cmF9O30KICBmdW5jdGlvbiBzeW5jSXRlbVRpbWUoaXRlbSl7Zm9yKGNvbnN0IGtleSBvZiBbInVwZGF0ZWRBdCIsInByaWNlVXBkYXRlZEF0IiwiaGVhdFB1bXBVcGRhdGVkQXQiLCJjbG9zZWRBdCJdKXtjb25zdCB0PURhdGUucGFyc2UoaXRlbT8uW2tleV18fCIiKTtpZihOdW1iZXIuaXNGaW5pdGUodCkpcmV0dXJuIHQ7fXJldHVybiAwO30KICBmdW5jdGlvbiBzeW5jTWVyZ2VCeUtleShsb2NhbCxyZW1vdGUsa2V5RmllbGQpe2NvbnN0IG1hcD1uZXcgTWFwKCk7Zm9yKGNvbnN0IGl0ZW0gb2YgQXJyYXkuaXNBcnJheShsb2NhbCk/bG9jYWw6W10pbWFwLnNldChTdHJpbmcoaXRlbT8uW2tleUZpZWxkXXx8IiIpLGl0ZW0pO2Zvcihjb25zdCByZW1vdGVJdGVtIG9mIEFycmF5LmlzQXJyYXkocmVtb3RlKT9yZW1vdGU6W10pe2NvbnN0IGtleT1TdHJpbmcocmVtb3RlSXRlbT8uW2tleUZpZWxkXXx8IiIpO2lmKCFrZXkpY29udGludWU7Y29uc3QgbG9jYWxJdGVtPW1hcC5nZXQoa2V5KTtpZighbG9jYWxJdGVtfHxzeW5jSXRlbVRpbWUocmVtb3RlSXRlbSk+PXN5bmNJdGVtVGltZShsb2NhbEl0ZW0pKW1hcC5zZXQoa2V5LHJlbW90ZUl0ZW0pO31yZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV07fQogIGZ1bmN0aW9uIHN5bmNDdXJyZW50UGF5bG9hZCgpe3JldHVybiB7c2NoZW1hOlNZTkNfUEFZTE9BRF9TQ0hFTUEscGF5bG9hZFZlcnNpb246IjYuMi4xIixhcHA6IkVsZGVob2YiLHNjb3BlOiJmdWxsIixyZWNvcmRzOnNhbml0aXplUmVjb3JkcyhyZWNvcmRzKSx2YWlsbGFudE1vbnRoczpBcnJheS5pc0FycmF5KHZhaWxsYW50TW9udGhzKT92YWlsbGFudE1vbnRoczpbXSxtZXRlclJlYWRpbmdzOnNhbml0aXplTWV0ZXJSZWFkaW5ncyhtZXRlclJlYWRpbmdzKSxtZXRlclJlYWRpbmdzVXBkYXRlZEF0OmxvY2FsU3RvcmFnZS5nZXRJdGVtKE1FVEVSX01FVEFfS0VZKXx8IiIsb3N0cm9tTGl2ZTpvc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKG9zdHJvbVByaWNlU3RhdHMpLGV4cG9ydGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHNvdXJjZURldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxzb3VyY2VEZXZpY2VOYW1lOnN5bmNTdGF0ZS5kZXZpY2VOYW1lfTt9CiAgZnVuY3Rpb24gc3luY01lcmdlUGF5bG9hZChsb2NhbCxyZW1vdGUpewogICAgY29uc3QgbG9jYWxNZXRlclRpbWU9RGF0ZS5wYXJzZShsb2NhbD8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIpfHwwLHJlbW90ZU1ldGVyVGltZT1EYXRlLnBhcnNlKHJlbW90ZT8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIpfHwwOwogICAgbGV0IG1lcmdlZE1ldGVycztpZihyZW1vdGVNZXRlclRpbWU+bG9jYWxNZXRlclRpbWUpbWVyZ2VkTWV0ZXJzPXJlbW90ZS5tZXRlclJlYWRpbmdzfHxbXTtlbHNlIGlmKGxvY2FsTWV0ZXJUaW1lPnJlbW90ZU1ldGVyVGltZSltZXJnZWRNZXRlcnM9bG9jYWwubWV0ZXJSZWFkaW5nc3x8W107ZWxzZSBtZXJnZWRNZXRlcnM9KHJlbW90ZT8ubWV0ZXJSZWFkaW5ncz8ubGVuZ3RofHwwKT49KGxvY2FsPy5tZXRlclJlYWRpbmdzPy5sZW5ndGh8fDApP3JlbW90ZS5tZXRlclJlYWRpbmdzfHxbXTpsb2NhbC5tZXRlclJlYWRpbmdzfHxbXTsKICAgIGNvbnN0IGxvY2FsTGl2ZT1EYXRlLnBhcnNlKGxvY2FsPy5vc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpfHwwLHJlbW90ZUxpdmU9RGF0ZS5wYXJzZShyZW1vdGU/Lm9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0fHwiIil8fDA7CiAgICByZXR1cm4ge3NjaGVtYTpTWU5DX1BBWUxPQURfU0NIRU1BLHBheWxvYWRWZXJzaW9uOiI2LjIuMSIsYXBwOiJFbGRlaG9mIixzY29wZToiZnVsbCIscmVjb3JkczpzYW5pdGl6ZVJlY29yZHMoc3luY01lcmdlQnlLZXkobG9jYWw/LnJlY29yZHMscmVtb3RlPy5yZWNvcmRzLCJtb250aCIpKSx2YWlsbGFudE1vbnRoczpzeW5jTWVyZ2VCeUtleShsb2NhbD8udmFpbGxhbnRNb250aHMscmVtb3RlPy52YWlsbGFudE1vbnRocywibW9udGgiKSxtZXRlclJlYWRpbmdzOnNhbml0aXplTWV0ZXJSZWFkaW5ncyhtZXJnZWRNZXRlcnMpLG1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6cmVtb3RlTWV0ZXJUaW1lPmxvY2FsTWV0ZXJUaW1lP3JlbW90ZS5tZXRlclJlYWRpbmdzVXBkYXRlZEF0OmxvY2FsLm1ldGVyUmVhZGluZ3NVcGRhdGVkQXQsb3N0cm9tTGl2ZTpyZW1vdGVMaXZlPj1sb2NhbExpdmU/cmVtb3RlPy5vc3Ryb21MaXZlfHxudWxsOmxvY2FsPy5vc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHN5bmNNZXJnZUJ5S2V5KGxvY2FsPy5vc3Ryb21QcmljZVN0YXRzLHJlbW90ZT8ub3N0cm9tUHJpY2VTdGF0cywibW9udGgiKSksZXhwb3J0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksc291cmNlRGV2aWNlSWQ6c3luY1N0YXRlLmRldmljZUlkLHNvdXJjZURldmljZU5hbWU6c3luY1N0YXRlLmRldmljZU5hbWV9OwogIH0KICBmdW5jdGlvbiBzeW5jQ29tcGFyYWJsZShwYXlsb2FkKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3JlY29yZHM6c2FuaXRpemVSZWNvcmRzKHBheWxvYWQ/LnJlY29yZHN8fFtdKSx2YWlsbGFudE1vbnRoczpwYXlsb2FkPy52YWlsbGFudE1vbnRoc3x8W10sbWV0ZXJSZWFkaW5nczpzYW5pdGl6ZU1ldGVyUmVhZGluZ3MocGF5bG9hZD8ubWV0ZXJSZWFkaW5nc3x8W10pLG1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6cGF5bG9hZD8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIsb3N0cm9tTGl2ZTpwYXlsb2FkPy5vc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHBheWxvYWQ/Lm9zdHJvbVByaWNlU3RhdHN8fFtdKX0pO30KICBmdW5jdGlvbiBzeW5jQXBwbHlQYXlsb2FkKHBheWxvYWQpe3N5bmNBcHBseWluZz10cnVlO3RyeXtzYXZlUmVjb3JkcyhwYXlsb2FkLnJlY29yZHN8fFtdLHtyZWFzb246IkdlcsOkdGUtU3luYyIsYWxsb3dFbXB0eTp0cnVlfSk7dmFpbGxhbnRNb250aHM9QXJyYXkuaXNBcnJheShwYXlsb2FkLnZhaWxsYW50TW9udGhzKT9wYXlsb2FkLnZhaWxsYW50TW9udGhzOltdO3NhdmVWYWlsbGFudE1vbnRocygpO3NhdmVNZXRlclJlYWRpbmdzKHBheWxvYWQubWV0ZXJSZWFkaW5nc3x8W10se3RvdWNoOmZhbHNlfSk7aWYocGF5bG9hZC5tZXRlclJlYWRpbmdzVXBkYXRlZEF0KWxvY2FsU3RvcmFnZS5zZXRJdGVtKE1FVEVSX01FVEFfS0VZLHBheWxvYWQubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdCk7c2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQub3N0cm9tTGl2ZXx8bnVsbCk7c2F2ZU9zdHJvbVByaWNlU3RhdHMocGF5bG9hZC5vc3Ryb21QcmljZVN0YXRzfHxbXSk7fWZpbmFsbHl7c3luY0FwcGx5aW5nPWZhbHNlO31yZW5kZXJBbGwoKTt9CiAgZnVuY3Rpb24gc2NoZWR1bGVDbG91ZFN5bmMoZGVsYXk9OTAwKXtjbGVhclRpbWVvdXQoc3luY0RlYm91bmNlVGltZXIpO2lmKCFzeW5jU3RhdGUuY29uZmlndXJlZHx8c3luY0FwcGx5aW5nKXJldHVybjtzeW5jRGVib3VuY2VUaW1lcj1zZXRUaW1lb3V0KCgpPT57aWYoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlIT09ImhpZGRlbiImJm5hdmlnYXRvci5vbkxpbmUhPT1mYWxzZSlzeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pO30sZGVsYXkpO30KICBmdW5jdGlvbiBzY2hlZHVsZVN5bmNQb2xsKCl7Y2xlYXJJbnRlcnZhbChzeW5jUG9sbFRpbWVyKTtzeW5jUG9sbFRpbWVyPW51bGw7aWYoIXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjtzeW5jUG9sbFRpbWVyPXNldEludGVydmFsKCgpPT57aWYoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlPT09InZpc2libGUiJiZuYXZpZ2F0b3Iub25MaW5lIT09ZmFsc2Upc3luY05vdyh7c2lsZW50OnRydWV9KTt9LDYwKjEwMDApO30KICBhc3luYyBmdW5jdGlvbiBjcmVhdGVTeW5jVmF1bHQoKXtpZihzeW5jQnVzeSlyZXR1cm47Y29uc3QgZGV2aWNlTmFtZT1TdHJpbmcoJCgic3luY0NyZWF0ZURldmljZU5hbWUiKS52YWx1ZXx8IiIpLnRyaW0oKTtpZihkZXZpY2VOYW1lLmxlbmd0aDwyKXt0b2FzdCgiR2Vyw6R0ZW5hbWVuIGVpbmdlYmVuIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtzeW5jU3RhdGU9e2NvbmZpZ3VyZWQ6dHJ1ZSx2YXVsdElkOnN5bmNHZW5lcmF0ZUlkKCJ2YXVsdCIsMTgpLGRldmljZUlkOnN5bmNHZW5lcmF0ZUlkKCJkZXZpY2UiLDE2KSxkZXZpY2VOYW1lLGRldmljZVRva2VuOnN5bmNHZW5lcmF0ZUlkKCJ0b2tlbiIsMzIpLHJlY292ZXJ5S2V5OnN5bmNHZW5lcmF0ZVJlY292ZXJ5S2V5KCkscm9sZToiYWRtaW4iLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtjb25zdCBzbmFwc2hvdD1zeW5jQ3VycmVudFBheWxvYWQoKTtjb25zdCBlbnZlbG9wZT1hd2FpdCBzeW5jRW5jcnlwdChzbmFwc2hvdCk7Y29uc3QgcmVzdWx0PWF3YWl0IHN5bmNBcGkoInZhdWx0L2NyZWF0ZSIse3ZhdWx0SWQ6c3luY1N0YXRlLnZhdWx0SWQsZGV2aWNlSWQ6c3luY1N0YXRlLmRldmljZUlkLGRldmljZU5hbWUsZGV2aWNlVG9rZW46c3luY1N0YXRlLmRldmljZVRva2VuLHNjb3BlOiJmdWxsIixlbnZlbG9wZX0pO3N5bmNTdGF0ZS5zZXJ2ZXJSZXZpc2lvbj1yZXN1bHQucmV2aXNpb247c3luY1N0YXRlLmxhc3RTeW5jQXQ9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO3NhdmVTeW5jU3RhdGUoKTtzY2hlZHVsZVN5bmNQb2xsKCk7cmVuZGVyQWxsKCk7dG9hc3QoIkdlcsOkdGUtU3luYyBlaW5nZXJpY2h0ZXQiKTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZT1sb2FkU3luY1N0YXRlKCk7c3luY1N0YXRlLmxhc3RFcnJvcj1lcnJvci5tZXNzYWdlO3NhdmVTeW5jU3RhdGUoKTthbGVydChgR2Vyw6R0ZS1TeW5jIGtvbm50ZSBuaWNodCBlaW5nZXJpY2h0ZXQgd2VyZGVuOiAke2Vycm9yLm1lc3NhZ2V9YCk7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBhc3luYyBmdW5jdGlvbiBjcmVhdGVTeW5jUGFpcmluZygpe2lmKHN5bmNCdXN5fHwhc3luY1N0YXRlLmNvbmZpZ3VyZWQpcmV0dXJuO2lmKHN5bmNTdGF0ZS5yb2xlIT09ImFkbWluIil7dG9hc3QoIk51ciBkYXMgZXJzdGUgVmVyd2FsdHVuZ3NnZXLDpHQga2FubiBuZXVlIEdlcsOkdGUga29wcGVsbiIpO3JldHVybjt9c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7Y29uc3QgcmVzdWx0PWF3YWl0IHN5bmNBcGkoInBhaXIvY3JlYXRlIixzeW5jQXV0aCh7c2NvcGU6ImZ1bGwifSkpOyQoInN5bmNQYWlyVmF1bHQiKS50ZXh0Q29udGVudD1zeW5jU3RhdGUudmF1bHRJZDskKCJzeW5jUGFpckNvZGUiKS50ZXh0Q29udGVudD1yZXN1bHQuY29kZTskKCJzeW5jUGFpclJlY292ZXJ5IikudGV4dENvbnRlbnQ9c3luY1JlY292ZXJ5Rm9ybWF0KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSk7JCgic3luY1BhaXJFeHBpcnkiKS50ZXh0Q29udGVudD1gQ29kZSBnw7xsdGlnIGJpcyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUocmVzdWx0LmV4cGlyZXNBdCkpfWA7JCgic3luY1BhaXJSZXN1bHQiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTt9Y2F0Y2goZXJyb3Ipe3RvYXN0KGVycm9yLm1lc3NhZ2UpO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gam9pblN5bmNWYXVsdCgpe2lmKHN5bmNCdXN5KXJldHVybjtjb25zdCB2YXVsdElkPVN0cmluZygkKCJzeW5jSm9pblZhdWx0SWQiKS52YWx1ZXx8IiIpLnRyaW0oKSxjb2RlPVN0cmluZygkKCJzeW5jSm9pbkNvZGUiKS52YWx1ZXx8IiIpLnRyaW0oKSxyZWNvdmVyeUtleT1zeW5jUmVjb3ZlcnlOb3JtYWxpemUoJCgic3luY0pvaW5SZWNvdmVyeSIpLnZhbHVlKSxkZXZpY2VOYW1lPVN0cmluZygkKCJzeW5jSm9pbkRldmljZU5hbWUiKS52YWx1ZXx8IiIpLnRyaW0oKTtpZighdmF1bHRJZHx8IWNvZGV8fHJlY292ZXJ5S2V5Lmxlbmd0aCE9PTY0fHxkZXZpY2VOYW1lLmxlbmd0aDwyKXt0b2FzdCgiS29wcGx1bmdzZGF0ZW4gdm9sbHN0w6RuZGlnIGVpbmdlYmVuIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3RyeXtjb25zdCBkZXZpY2VJZD1zeW5jR2VuZXJhdGVJZCgiZGV2aWNlIiwxNiksZGV2aWNlVG9rZW49c3luY0dlbmVyYXRlSWQoInRva2VuIiwzMik7Y29uc3QgY2xhaW09YXdhaXQgc3luY0FwaSgicGFpci9jbGFpbSIse3ZhdWx0SWQsY29kZSxkZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VufSk7c3luY1N0YXRlPXtjb25maWd1cmVkOnRydWUsdmF1bHRJZCxkZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VuLHJlY292ZXJ5S2V5LHJvbGU6Y2xhaW0ucm9sZXx8Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOjAsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6IiJ9O3NhdmVTeW5jU3RhdGUoKTtjb25zdCByZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSk7Y29uc3QgcmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUpO2NvbnN0IG1lcmdlZD1zeW5jTWVyZ2VQYXlsb2FkKHN5bmNDdXJyZW50UGF5bG9hZCgpLHJlbW90ZVBheWxvYWQpO3N5bmNBcHBseVBheWxvYWQobWVyZ2VkKTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cmVtb3RlLnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7aWYoc3luY0NvbXBhcmFibGUobWVyZ2VkKSE9PXN5bmNDb21wYXJhYmxlKHJlbW90ZVBheWxvYWQpKXtjb25zdCBlbnZlbG9wZT1hd2FpdCBzeW5jRW5jcnlwdChtZXJnZWQpO2NvbnN0IHB1c2hlZD1hd2FpdCBzeW5jQXBpKCJzbmFwc2hvdC9wdXNoIixzeW5jQXV0aCh7YmFzZVJldmlzaW9uOnJlbW90ZS5yZXZpc2lvbixlbnZlbG9wZX0pKTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cHVzaGVkLnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7fXNjaGVkdWxlU3luY1BvbGwoKTtyZW5kZXJBbGwoKTt0b2FzdCgiR2Vyw6R0IGdla29wcGVsdCB1bmQgYWt0dWFsaXNpZXJ0Iik7fWNhdGNoKGVycm9yKXtzeW5jU3RhdGU9e2NvbmZpZ3VyZWQ6ZmFsc2UsdmF1bHRJZDoiIixkZXZpY2VJZDoiIixkZXZpY2VOYW1lOiIiLGRldmljZVRva2VuOiIiLHJlY292ZXJ5S2V5OiIiLHJvbGU6Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOjAsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6ZXJyb3IubWVzc2FnZX07c2F2ZVN5bmNTdGF0ZSgpO2FsZXJ0KGBLb3BwbHVuZyBmZWhsZ2VzY2hsYWdlbjogJHtlcnJvci5tZXNzYWdlfWApO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gc3luY05vdyh7c2lsZW50PWZhbHNlLHJldHJ5PXRydWV9PXt9KXtpZihzeW5jQnVzeXx8IXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybiBmYWxzZTtzeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtjb25zdCByZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSk7Y29uc3QgcmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUpO2NvbnN0IGxvY2FsUGF5bG9hZD1zeW5jQ3VycmVudFBheWxvYWQoKTtjb25zdCBtZXJnZWQ9c3luY01lcmdlUGF5bG9hZChsb2NhbFBheWxvYWQscmVtb3RlUGF5bG9hZCk7c3luY0FwcGx5UGF5bG9hZChtZXJnZWQpO2xldCByZXZpc2lvbj1yZW1vdGUucmV2aXNpb247aWYoc3luY0NvbXBhcmFibGUobWVyZ2VkKSE9PXN5bmNDb21wYXJhYmxlKHJlbW90ZVBheWxvYWQpKXt0cnl7Y29uc3QgZW52ZWxvcGU9YXdhaXQgc3luY0VuY3J5cHQobWVyZ2VkKTtjb25zdCBwdXNoZWQ9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVzaCIsc3luY0F1dGgoe2Jhc2VSZXZpc2lvbjpyZW1vdGUucmV2aXNpb24sZW52ZWxvcGV9KSk7cmV2aXNpb249cHVzaGVkLnJldmlzaW9uO31jYXRjaChlcnJvcil7aWYoZXJyb3Iuc3RhdHVzPT09NDA5JiZyZXRyeSl7c3luY0J1c3k9ZmFsc2U7cmV0dXJuIGF3YWl0IHN5bmNOb3coe3NpbGVudCxyZXRyeTpmYWxzZX0pO310aHJvdyBlcnJvcjt9fXN5bmNTdGF0ZS5zZXJ2ZXJSZXZpc2lvbj1yZXZpc2lvbjtzeW5jU3RhdGUubGFzdFN5bmNBdD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7c3luY1N0YXRlLmxhc3RFcnJvcj0iIjtzYXZlU3luY1N0YXRlKCk7aWYoIXNpbGVudCl0b2FzdCgiQWxsZSBHZXLDpHRlIGF1ZiBha3R1ZWxsZW0gU3RhbmQiKTtyZXR1cm4gdHJ1ZTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZS5sYXN0RXJyb3I9ZXJyb3IubWVzc2FnZTtzYXZlU3luY1N0YXRlKCk7aWYoIXNpbGVudCl0b2FzdChgU3luYzogJHtlcnJvci5tZXNzYWdlfWApO3JldHVybiBmYWxzZTt9ZmluYWxseXtzeW5jQnVzeT1mYWxzZTtyZW5kZXJTeW5jUGFuZWwoKTt9fQogIGZ1bmN0aW9uIGRpc2Nvbm5lY3RTeW5jKCl7aWYoIWNvbmZpcm0oIkRpZXNlcyBHZXLDpHQgbG9rYWwgdm9tIEVsZGVob2YtU3luYyB0cmVubmVuPyBEaWUgRGF0ZW4gYXVmIGRlbSBHZXLDpHQgYmxlaWJlbiBlcmhhbHRlbi4iKSlyZXR1cm47c3luY1N0YXRlPXtjb25maWd1cmVkOmZhbHNlLHZhdWx0SWQ6IiIsZGV2aWNlSWQ6IiIsZGV2aWNlTmFtZToiIixkZXZpY2VUb2tlbjoiIixyZWNvdmVyeUtleToiIixyb2xlOiJtZW1iZXIiLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtzYXZlU3luY1N0YXRlKCk7c2NoZWR1bGVTeW5jUG9sbCgpO3JlbmRlclN5bmNQYW5lbCgpO3RvYXN0KCJHZXLDpHQgdm9tIFN5bmMgZ2V0cmVubnQiKTt9CiAgZnVuY3Rpb24gcmVuZGVyU3luY1BhbmVsKCl7aWYoISQoInN5bmNQYW5lbCIpKXJldHVybjskKCJzeW5jU2V0dXBCb3giKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHN5bmNTdGF0ZS5jb25maWd1cmVkKTskKCJzeW5jQWN0aXZlQm94IikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc3luY1N0YXRlLmNvbmZpZ3VyZWQpO2NvbnN0IGJhZGdlPSQoInN5bmNCYWRnZSIpO2JhZGdlLmNsYXNzTmFtZT1gc3luYy1iYWRnZSAke3N5bmNCdXN5PyJidXN5IjpzeW5jU3RhdGUubGFzdEVycm9yPyJlcnJvciI6c3luY1N0YXRlLmNvbmZpZ3VyZWQ/Im9rIjoiIn1gO2JhZGdlLnRleHRDb250ZW50PXN5bmNCdXN5PyJzeW5jaHJvbmlzaWVydCDigKYiOnN5bmNTdGF0ZS5sYXN0RXJyb3I/IkZlaGxlciI6c3luY1N0YXRlLmNvbmZpZ3VyZWQ/InZlcmJ1bmRlbiI6Im5pY2h0IGVpbmdlcmljaHRldCI7aWYoIXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjskKCJzeW5jRGV2aWNlVGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5kZXZpY2VOYW1lfHwiZGllc2VzIEdlcsOkdCI7JCgic3luY1JvbGVUZXh0IikudGV4dENvbnRlbnQ9c3luY1N0YXRlLnJvbGU9PT0iYWRtaW4iPyJWZXJ3YWx0dW5nc2dlcsOkdCI6Imdla29wcGVsdGVzIEdlcsOkdCI7JCgic3luY1JldmlzaW9uVGV4dCIpLnRleHRDb250ZW50PVN0cmluZyhzeW5jU3RhdGUuc2VydmVyUmV2aXNpb258fDApOyQoInN5bmNMYXN0VGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5sYXN0U3luY0F0P2B6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUoc3luY1N0YXRlLmxhc3RTeW5jQXQpfWA6Im5vY2ggbmllIjskKCJzeW5jU3RhdHVzIikudGV4dENvbnRlbnQ9c3luY1N0YXRlLmxhc3RFcnJvcj9gTGV0enRlciBGZWhsZXI6ICR7c3luY1N0YXRlLmxhc3RFcnJvcn1gOiLDhG5kZXJ1bmdlbiB3ZXJkZW4gYXV0b21hdGlzY2ggYWJnZWdsaWNoZW4uIjskKCJzeW5jU3RhdHVzIikuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke3N5bmNTdGF0ZS5sYXN0RXJyb3I/ImVycm9yIjoib2sifWA7JCgic3luY1BhaXJCdG4iKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHN5bmNTdGF0ZS5yb2xlIT09ImFkbWluIik7fQoKICBmdW5jdGlvbiBzYXZlQ29zdFNldHRpbmdzKCl7IHNldHRpbmdzLmZhbGxiYWNrUHJpY2U9TWF0aC5tYXgoMCxOdW1iZXIoJCgiZmFsbGJhY2tQcmljZUlucHV0IikudmFsdWUpfHwwKTtzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZT1NYXRoLm1heCgwLE51bWJlcigkKCJkZWZhdWx0QmFzZUZlZUlucHV0IikudmFsdWUpfHwwKTtzYXZlU2V0dGluZ3MoKTtzY2hlZHVsZUNsb3VkU3luYygpO3JlbmRlckFsbCgpO3RvYXN0KCJLb3N0ZW4tRWluc3RlbGx1bmdlbiBnZXNwZWljaGVydCIpOyB9CgogIGZ1bmN0aW9uIHJlbmRlckFsbCgpeyB1cGRhdGVSZWNvdmVyeUJhbm5lcigpO3JlbmRlckRhc2hib2FyZCgpO3JlbmRlclJlY29yZHMoKTtyZW5kZXJBbmFseXNpcygpO3JlbmRlckRhdGEoKTsgfQogIGZ1bmN0aW9uIHJlc2l6ZUNoYXJ0cygpeyBjbGVhclRpbWVvdXQocmVzaXplVGltZXIpO3Jlc2l6ZVRpbWVyPXNldFRpbWVvdXQoKCk9PnsgaWYoY3VycmVudFZpZXc9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7IGlmKGN1cnJlbnRWaWV3PT09ImFuYWx5c2lzVmlldyIpcmVuZGVyQW5hbHlzaXMoKTsgfSwxMDApOyB9CgogIGZ1bmN0aW9uIGJpbmQoKXsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixldmVudD0+ewogICAgICBjb25zdCBuYXY9ZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLW5hdl0iKTsgaWYobmF2KXtzd2l0Y2hWaWV3KG5hdi5kYXRhc2V0Lm5hdik7cmV0dXJuO30KICAgICAgY29uc3QgZWRpdD1ldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtZWRpdC1tb250aF0iKTsgaWYoZWRpdCl7b3BlblJlY29yZE1vZGFsKGVkaXQuZGF0YXNldC5lZGl0TW9udGgpO3JldHVybjt9CiAgICAgIGlmKGV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWxdIikpe2Nsb3NlUmVjb3JkTW9kYWwoKTtyZXR1cm47fQogICAgICBpZihldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtY2xvc2UtbWV0ZXItbW9kYWxdIikpe2Nsb3NlTWV0ZXJNb2RhbCgpO3JldHVybjt9CiAgICB9KTsKICAgICQoImRhc2hib2FyZEFkZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZFJlY29yZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZE1ldGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLG9wZW5NZXRlck1vZGFsKTsKICAgICQoImVkaXRMYXRlc3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pm9wZW5SZWNvcmRNb2RhbCgkKCJlZGl0TGF0ZXN0QnRuIikuZGF0YXNldC5tb250aCkpOwogICAgJCgicmVjb3JkRm9ybSIpLmFkZEV2ZW50TGlzdGVuZXIoInN1Ym1pdCIsc2F2ZUVkaXRlZFJlY29yZCk7IFsicmVjb3JkVG90YWwiLCJyZWNvcmRIZWF0UHVtcCIsInJlY29yZEFubmV4Il0uZm9yRWFjaChpZD0+JChpZCkuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLHVwZGF0ZURlcml2ZWRQcmV2aWV3KSk7CiAgICAkKCJtZXRlckZvcm0iKS5hZGRFdmVudExpc3RlbmVyKCJzdWJtaXQiLHNhdmVNZXRlclJlYWRpbmdGcm9tRm9ybSk7IFsibWV0ZXJEYXRlIiwibWV0ZXJUb3RhbCIsIm1ldGVyQW5uZXgiXS5mb3JFYWNoKGlkPT4kKGlkKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsdXBkYXRlTWV0ZXJQcmV2aWV3KSk7CiAgICAkKCJ1bmRvTGF0ZXN0TWV0ZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsdW5kb0xhdGVzdE1ldGVyUmVhZGluZyk7CiAgICAkKCJyZWNvcmRZZWFyRmlsdGVyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJSZWNvcmRzKTsgJCgiYW5hbHlzaXNZZWFyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJBbmFseXNpcyk7CiAgICAkKCJyZXN0b3JlU2hhZG93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHJlc3RvcmVTaGFkb3cpOyAkKCJleHBvcnRCYWNrdXBCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXhwb3J0QmFja3VwKTsgJCgiZXhwb3J0Q3N2QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV4cG9ydENzdik7ICQoImltcG9ydEJhY2t1cElucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+e2NvbnN0IGY9JCgiaW1wb3J0QmFja3VwSW5wdXQiKS5maWxlcz8uWzBdO2lmKGYpaW1wb3J0QmFja3VwKGYpO30pOwogICAgJCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+aW1wb3J0VmFpbGxhbnRDc3ZGaWxlcygkKCJ2YWlsbGFudENzdkZpbGVzSW5wdXQiKS5maWxlcykpOwogICAgJCgic2F2ZU9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQW5kQ2hlY2tPc3Ryb20pOyAkKCJkaXNjb25uZWN0T3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGRpc2Nvbm5lY3RPc3Ryb20pOyAkKCJyZWZyZXNoT3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5yZWZyZXNoT3N0cm9tKHRydWUpKTsgJCgicmVmcmVzaE9zdHJvbUhpc3RvcnlCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PnJlZnJlc2hPc3Ryb21IaXN0b3J5KCkpOyAkKCJyZWZyZXNoT3N0cm9tUHJpY2VTdGF0c0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+cmVmcmVzaE9zdHJvbVByaWNlU3RhdHMoTnVtYmVyKCQoImFuYWx5c2lzWWVhciIpLnZhbHVlKXx8bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpKSk7ICQoImdvT3N0cm9tU2V0dGluZ3NCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pntzd2l0Y2hWaWV3KCJkYXRhVmlldyIpO3NldFRpbWVvdXQoKCk9PiQoIm9zdHJvbVNldHRpbmdzUGFuZWwiKS5zY3JvbGxJbnRvVmlldyh7YmVoYXZpb3I6InNtb290aCIsYmxvY2s6InN0YXJ0In0pLDEwMCk7fSk7CiAgICAkKCJzeW5jQ3JlYXRlQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGNyZWF0ZVN5bmNWYXVsdCk7ICQoInN5bmNKb2luQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGpvaW5TeW5jVmF1bHQpOyAkKCJzeW5jTm93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5zeW5jTm93KHtzaWxlbnQ6ZmFsc2V9KSk7ICQoInN5bmNQYWlyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGNyZWF0ZVN5bmNQYWlyaW5nKTsgJCgic3luY0Rpc2Nvbm5lY3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZGlzY29ubmVjdFN5bmMpOwogICAgJCgic2F2ZUNvc3RTZXR0aW5nc0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQ29zdFNldHRpbmdzKTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJyZXNpemUiLHJlc2l6ZUNoYXJ0cyk7IGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoInZpc2liaWxpdHljaGFuZ2UiLCgpPT57aWYoZG9jdW1lbnQuaGlkZGVuKXJldHVybjtpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe2NvbnN0IGFnZT1EYXRlLm5vdygpLURhdGUucGFyc2Uob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKTtpZighTnVtYmVyLmlzRmluaXRlKGFnZSl8fGFnZT4xMCo2MGUzKXJlZnJlc2hPc3Ryb20oZmFsc2UpO31pZihzeW5jU3RhdGUuY29uZmlndXJlZClzeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pO30pOwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsZXZlbnQ9PntpZihldmVudC5rZXkhPT0iRXNjYXBlIilyZXR1cm47aWYoISQoInJlY29yZE1vZGFsIikuY2xhc3NMaXN0LmNvbnRhaW5zKCJoaWRkZW4iKSljbG9zZVJlY29yZE1vZGFsKCk7ZWxzZSBpZighJCgibWV0ZXJNb2RhbCIpLmNsYXNzTGlzdC5jb250YWlucygiaGlkZGVuIikpY2xvc2VNZXRlck1vZGFsKCk7fSk7CiAgfQoKICBmdW5jdGlvbiBpbml0KCl7CiAgICBhcHBseUhpc3RvcmljYWxTZWVkKCk7ZW5zdXJlTWV0ZXJCYXNlbGluZSgpOwogICAgYmluZCgpO3JlbmRlckFsbCgpO3NjaGVkdWxlT3N0cm9tKCk7c2NoZWR1bGVTeW5jUG9sbCgpOwogICAgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXsgY29uc3QgYWdlPURhdGUubm93KCktRGF0ZS5wYXJzZShvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpOyBpZighb3N0cm9tTGl2ZXx8IU51bWJlci5pc0Zpbml0ZShhZ2UpfHxhZ2U+MTAqNjBlMylyZWZyZXNoT3N0cm9tKGZhbHNlKTsgc2V0VGltZW91dCgoKT0+cmVmcmVzaE9zdHJvbUhpc3Rvcnkoe3NpbGVudDp0cnVlLG9ubHlNaXNzaW5nOnRydWUsbWF4TW9udGhzOjJ9KSw0MjAwKTsgfQogICAgaWYoc3luY1N0YXRlLmNvbmZpZ3VyZWQpc2V0VGltZW91dCgoKT0+c3luY05vdyh7c2lsZW50OnRydWV9KSw2NTApOwogICAgaWYoInNlcnZpY2VXb3JrZXIiIGluIG5hdmlnYXRvcil3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigibG9hZCIsKCk9Pm5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLnJlZ2lzdGVyKCJzdy5qcz92PTYuMi4xIikuY2F0Y2goKCk9Pnt9KSk7CiAgICBjb25zb2xlLmluZm8oYEVsZGVob2YgJHtBUFBfQlVJTER9YCk7CiAgfQogIGluaXQoKTsKfSkoKTsK","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/sw.js":{"body":"Y29uc3QgQ0FDSEU9ImVsZGVob2YtdjYtMi0xLW9zdHJvbS1wcmljZS1zdGF0cy0yMDI2MTAwNSI7CmNvbnN0IENPUkU9WyIuLyIsIi4vP3Y9Ni4yLjEiLCIuL2luZGV4Lmh0bWwiLCIuL3N0eWxlcy5jc3M/dj02LjIuMSIsIi4vYXBwLmpzP3Y9Ni4yLjEiLCIuL21hbmlmZXN0LndlYm1hbmlmZXN0IiwiLi9pY29uLTE5Mi5wbmciLCIuL2ljb24tNTEyLnBuZyJdOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImluc3RhbGwiLGV2ZW50PT57ZXZlbnQud2FpdFVudGlsKGNhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMuYWRkQWxsKENPUkUpKS50aGVuKCgpPT5zZWxmLnNraXBXYWl0aW5nKCkpKX0pOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImFjdGl2YXRlIixldmVudD0+e2V2ZW50LndhaXRVbnRpbChjYWNoZXMua2V5cygpLnRoZW4oa2V5cz0+UHJvbWlzZS5hbGwoa2V5cy5maWx0ZXIoaz0+ayE9PUNBQ0hFKS5tYXAoaz0+Y2FjaGVzLmRlbGV0ZShrKSkpKS50aGVuKCgpPT5zZWxmLmNsaWVudHMuY2xhaW0oKSkpfSk7CnNlbGYuYWRkRXZlbnRMaXN0ZW5lcigiZmV0Y2giLGV2ZW50PT57CiAgY29uc3QgdXJsPW5ldyBVUkwoZXZlbnQucmVxdWVzdC51cmwpOwogIGlmKGV2ZW50LnJlcXVlc3QubWV0aG9kIT09IkdFVCJ8fHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCIvYXBpLyIpKXJldHVybjsKICBldmVudC5yZXNwb25kV2l0aChmZXRjaChldmVudC5yZXF1ZXN0KS50aGVuKHJlc3BvbnNlPT57Y29uc3QgY29weT1yZXNwb25zZS5jbG9uZSgpO2NhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMucHV0KGV2ZW50LnJlcXVlc3QsY29weSkpO3JldHVybiByZXNwb25zZTt9KS5jYXRjaCgoKT0+Y2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4oY2FjaGVkPT5jYWNoZWR8fGNhY2hlcy5tYXRjaCgiLi9pbmRleC5odG1sIikpKSk7Cn0pOwo=","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/manifest.webmanifest":{"body":"ewogICJuYW1lIjogIkVsZGVob2YgNi4yLjEg4oCTIFZlcmJyYXVjaHNidWNoIiwKICAic2hvcnRfbmFtZSI6ICJFbGRlaG9mIiwKICAiZGVzY3JpcHRpb24iOiAiU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4g4oCTIG1pdCBrb21wYWt0ZXIgT3N0cm9tLVByZWlzw7xiZXJzaWNodC4iLAogICJzdGFydF91cmwiOiAiLi8/dj02LjIuMSIsCiAgInNjb3BlIjogIi4vIiwKICAiZGlzcGxheSI6ICJzdGFuZGFsb25lIiwKICAib3JpZW50YXRpb24iOiAicG9ydHJhaXQtcHJpbWFyeSIsCiAgImJhY2tncm91bmRfY29sb3IiOiAiIzA2MTAxYyIsCiAgInRoZW1lX2NvbG9yIjogIiMwNzExMWYiLAogICJpY29ucyI6IFsKICAgIHsic3JjIjoiaWNvbi0xOTIucG5nIiwic2l6ZXMiOiIxOTJ4MTkyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifSwKICAgIHsic3JjIjoiaWNvbi01MTIucG5nIiwic2l6ZXMiOiI1MTJ4NTEyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifQogIF0KfQo=","type":"application/manifest+json; charset=utf-8","cache":"no-cache"},"/icon-192.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFk0lEQVR42u3du24TQRiG4fVoBShpkKJ0hi6iTEqKKAURJbdASZcqN5AbSJWOkkuAEoUiSkFLSW/RWC6RKFxQWFrlZO96ZnbmP7xfGeWwh8ffzOx6ncnOwVFDbGU5XxT7W4HDbS/t/h6AiI4AiBICEKGBiNISAhCGAEQYwojSEgIQARCpV0IAIgAi9UoIQARApF4JAYgAiNQrIQARABEAEaWjGIAIgEi9EgIQSeOobotPLqe2T8nN+UzR1k7kPxdmXkwVTLmeHZMLaJ2b27OZYTHHV9MykiwDekzHNpqtPOWSZBPQXTpu0QyRlIVRFkNSAEEnQlIiIyOAoFOLkQVAnR7opDCKM6QbEHQkVFG6oTqA0COkitIBBfQYSHcky190Ld1Aqz2EzqhVNLyHlDUQespU0fAeSr8zH9Dj3JAOQOixaiigB0OiAaHHtqFQQA+pm81nIXEeHYq9FEitEtLaQAxeHgaygB4MKVjGE6sZBRD146eEaCAiDBD146qEaCCSdCkoMyDqx1sJ0UBEDCCT9fPp+g0lRAMl6TFmiEl0he7B0NoJeN7xy/Cwtfri59PfNvbx5HKa5fnozA1kYAK0uWwMVFHec8QQtrUPhjMApcrAEIBSTWAoJyDtV4DiNNz9qT9fD9VNg7Kse1rnL6DEIjG2NGMIK6pHaf0ASJYe5kDoScrF3xeeRQb00GoAqnaOu/pxa6iFzkh/yMnSLKAnY/04rKKAHhZ6KZ9TFtAzRv346aGAHnoIQKXP3MD68WCohQ5LMxqoqJ5t68d2FQX0sIUAKnduUurHpKGAHudbm/hh9QE9hevHWA+10GFp5reBSurJWz9mXgMBPeyLR0CFj/h49VPXUPq/e2rRUx3Zxe6/br/UzYcCeurWT6dH6VjWQqdmad3Xo3FpFtBTffaj+tUS0COqftTtdUBPlfrp1aPFUECPwO5RdAQCegrXz1Z65BtqoaNoFihwaRbQI7x+hL+uAnpkTn20HB9xQ9iQlpb8rudEPdzKIGN1D5Noy+d7Q2kZ1kMDiZ5xA4gYrx9rQ9jV2+/Dv/ns5/ux62fv9FuZbaCBSuuJ+P5t06unwDYASOvsZ4ge5kCEAIj6AZCouNIDoMz1400PgLKSsn7JB0Cjz34ARKif7cLN1HsZcmVvcf0BPTRQpJ4nJ84GLigDqJCeB/XTLbvcGgIQAVBUIu6Er6ufktsAIBEg0s/ck3oKbwOrsPqlElc/G7rHBguGsBHj8H4FgLLVD3oARABE/QCIqQ+AHNUPegBE9wCo3uyHAIj6AVDx+kEPgOgeABEAEQARAiACIAIgAiBCsgM6vppyQFVkdaZ+fPwlBdDN+azk/qv+R+vG9oshjLgEZK+ElO5R4Iivkvg4TuKP6309THYOjnL9rpPLadM0t2ezwvuQ8X+vxD3inqKnPJ2MM+jGxoOFGc/B893XjKfbDWHL+YKZIEmaAy3niyyMVot5rgZJTt7x694kmioiqaswDJHUZXzicMYo5mr8atZdB6KKSBKglCqihPzUT9N7JZoqIkmA4qqIEnJSP83we2FxVYQhOXqqNVBcFRV+hxDpzRj100TcjR/OiIHM9uAVCSiijTBkVU+T+H6gXkYMZFanPnkADWHEQGZy6pMTUC8jDJkcvFaZPHv5aozf2+7vPfhKrfcrokdHA/UWEj1kT8+IDbSukOihArPmYnrKAboraWUIRgb0NOUf61nOF90eMpxp11Ohgbq8+3JID6mmUxkQjAzoqQ/oriEYRdCpq0cEIBgppSMLEIyGuxFCRyKgx4ycY3q8UJVDRy6gdYw8YFp3aUOaGwWAeiV5iFg3mgC58iRfjHpARFT4jEQCIAIgAiACIEIARABEAEQARAiACIAIgAiACAEQARABEAEQIQAiACIAIgAibvMfGKe/xgpKwHYAAAAASUVORK5CYII=","type":"image/png","cache":"public, max-age=31536000, immutable"},"/icon-512.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAPpUlEQVR42u3dvW5UVxcG4OORFUWkiYToSIkooaRAFEEucwsp6VxxA9wAlTvKXEJSIlIgCtqU9CiN5TJSChcpiCw09gwz4/Oz93qfp8ynLzFnznnftc62zdGdB48HgIouzy9chC1WLgGAAgAo5fjeXRdBAQCgAABLAAoA0AEKAAAFAGAJUAAAOkABAKAAACwBCgAABQBgCVAAACgAAEuAAgDQAQoAAAUAYAlQAAAoAABLgAIAQAEAWAIUAAAKAMASoAAAUAAAlgAFAKADFAAACgAgfglQAAA2AABLgAIAQAEAoAAAqot6C6QAAGwAACQtAQoAwAYAQNISoAAAbAAAJC0BCgDABgBA0hKgAABsAAAoAACG6m+BFACADQCApCVAAQDYAABIWgIUAIANAAAFAMDXSr4FUgAANgAAFAAAa+q9BVIAADYAAJKWAAUAYAMAQAEAcKNKb4EUAEBqmbkEIZ69vu8isKP3Lz+7CAmO7jx47CrIelAMe7k8v1AAiHv0gQJQAAh9lIECUADIfZSBDlAACH00gQJQACyd+x9OneCxk6dnI99+JZtAAdBi9At6mm2FYk3QewcogAq5L/HprhJqNIECYJnoF/oUKIPea0ABMF/0C31KNkHXNdB1BygAuQ9NlEGnNaAAmCT65T5qQAEogLj0F/2EN0FfNdBvByiAhqJf7qMJeqwBBYDoh9AaUACIfpiqBhrvAAXA3ukv+qFMDXTaAQpA9IMaUABMn/6iH25fAw12gAIQ/aIfcmugxw5QAJOnv+iHhA5QANJf+sOsNdBOBygA0S/6IbQGeiyAlRtL+kP7tj9TLfzNqcf37toA0tNf9MNSq8Die0B3S4ACMPiDDlAASH/ovwMWrAEFkJj+oh+sAj12gENg6Q+92vL0tXAsrACkP6ADGuUV0IHpL/qhHe28C+rrFZACkP5QvAbm7ABnANIfWMCmZ3POd0F9/TiYApD+oANCKQDpDzpAASD9QQcoAOkv/UEHKADpL/1BB+yho3NgBSD9QQfYAKS/9IeYDkABuG8g9Fm2BCiAjfeB9AcdoACkP5CVALfXyznwymcPxC4B4TngFZDxHzzdCsD47/6AyA6IXQJCC0D6gw7QAYkF4NU/IBkGZwDGf/C8T6GLbwSKKwAvf4DBi6DAApD+gA7I3QAAiCsA4z9gCUgsAOkP6IDcDQCAuAIw/gPzLwHtfyfoyucNYAMIGv8BZlgCFIDxH5AMCsD4D8gQBbDUJ2f8BywBERsAgCUgrgCM/4AlwAYAsMwS0PiPAgQVgPEfkBX1C8A3/wBSxQZg/AckRkwBGP8B2WIDMP4DciOmAIz/gISxARj/AemRXQAA1C8A738AOWMDSNngABmiAIz/gLSxARj/gWaSpOVfB+QQmGgv3j10EYhVpAC8/+Hg9NcBxGZO2Q3A+x92n/11AJl5cuyjJTn61/7hm+efXB9yOANA+u/6v4ICaM71l3He/3BwvusAbnQ9VQocA9gAkP46ABsASH8dQJLuD4F9AygTRbljYXbJn/cvO37hXHADcADAiIO8VYDC2eIVENJfBxBKASD9dQAKoEMOAJgtr3UA9VKo2k8COwAQ/VP/yx0LJ/tw+vnpmb8QBsLS3ypAPQoA6a8DUAAg/XUACgCkvw6gvKM7Dx53+qX7HXA0EsGOhdNcPwfe/vPAl+cXNgCoOYBbBeiUAkD6z/H1/P37I58aCgBqTtz2ABQA5Obspq/N+E+b/J3AiP7xv0jHwtgAICv9b/xqjf8ogJH5NXDS39eMRLIB/M8PAUj/Br9y439JZdLGKyCkP4RSAEj/qbz653sfIi3zXUCIfrABgPSfcvzXaigAyJ39dQAKAIrn45a3/zoABQC5yagDojT7u6AHh8AIxDnH/7U/st8YgQ0A6e/PDgoACRgw/usAFADSX/a5DigApF7k+K8DWJZDYER/Q5fFsTA2AKR/0PivHVEASH9cJRQAci1y/NcBKACkP64Yc3AIjCBra/xfu3SOhbEBIP1dQ/rT8i8CUgBIrkbHfx2AAkD643qiAJBWkeO/DmA6DoERUp1dXsfC2ACQ/kHjv5ZFASD9cbVRAMijyPFfB6AAkP648q1r/IcABofACKAex/+1j8CxMDYApL/PAhQAEidg/PeJoACQNfhcUABImcjx36fDYRwCI1wKfkyOhbEBIP2Dxn+fV1Pa/x5QBYA08alhAwA5UmX899mhAJAg+ATZxiEwgqPm+L/2UToWxgaA9PeZggJAUgSM/z7ZRXTxLUAKABnh88UGANKh9PjvU+Y6h8AIhdCP27EwNgCkf9D473NHASAF8OlPpZcTYAXg+ff8h47/7gEUgPQHd0Iuh8AeeHLH/7VbwrGwDQDpj3sDBYAn3PjvDmEfHZ0AKwDPNrhPbAB4qokf/90taRwCe5hh423jWNgGgPQ3/rt/UAB4enEXsUFfJ8CDV0CeW2Yb/1teL1798O/2e8m7IBsA0p+Kzbc1/d1RCgDpb/zPTX/3VVVeAYl+2O8G8zroRt0dANgApD/Gf3daLgUg/UmtvYPS3/2mAJD+xv/c9HfXKQCkP7np796rwSGw6Df+S//b3oSOhW0ASH/cjSgAPG/G/4Dx3z2pAJD+pKe/O1MBIP2N/7np7/7skUNg0Y/0H/9GdSxsA0D6G/+z0t8dqwDwLIH7VgHgKTL+543/7l4FgOeH6PR3D7fPIbDoN/5L/zluZsfCNgCkP1np765WAHhOjP/R6e/eVgB4QnCHu8MVAJ4N43/Y+O8+b5BDYI8E0n+ZG96xsA0A6W/8z0p/d74CwDNAdPq7/1vgFdDCJt2CPV0h4//U6e9djQ0AAAUAxv+Y8R8FAEh/FAAY/6U/JTgExoDcZRVJf2wAkLiISH8UAAAKAIz/oACgcp1IfxQABI7/0h8FAGZ/UACQMf5LfxQAAAoAjP9wO34SmG87e/J2hv/K6ccTl/q6u8//cIWxAVA5/ef8D3U0/o+Y/sWuMAqAaqEsoaZLf1cYBUDrYVEgoUYZ/6dIfx2AAqD1mJBQrjAKAIz/oAAghvRHAUDi+C/9UQBg9gcFABnjv/RHAQCgAMD4DwoACpP+KABIHP+lPwoAzP6gACBj/Jf+KAAAFADEjP/+ki8UAETWhvRHAUDg+C/9UQBg9gcFADHjPygAMP6DAoCM8V/6owDA7A8KADLGf+lPs45dAoo5e/J22gJ494v0xwYAcel/sU/6z/D1gAKA4ezJ29bS9suve9MBKADo3l7j/9e/7FMHoABgwvG/wdm/5a8QFADSf/zxf9Mv+tcBKACozF/zggKAUvb95h9QAGD8BwUA1cd/6Y8CALM/KAA4yOnHk77G/+7Sv6krjAJARsTN/q4wCgAd0Pf47wqjANABidl0+5c/rjAKgPQOOP140lo2fXP8H+vVf+wVZnH+PgCMjcvM/q4wNgBo0fbx3zd9ogDA7A8KAGLGf1AAYPwHBQAZ47/0RwGA2R8UAGSM/9IfBQBmf1AAEDP+gwIA4z8oAMgY/6U/CgDM/qAAIGP8l/4oADD7gwKAmPEfFAAY/0EBQMb4L/1RAGD2BwUAGeO/9EcBgNkfFADEjP+gAMD4DwoAMsZ/6Y8CALM/KADIGP+lPygAzP6gACBm/AcUAMZ/UACQMf5Lf1AAmP1BAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAK45v3Lz2v/5OnZfR8nMIPrafPnr38pAAAUAAAKAAAFAIACAEABAKAAbsV3gq558/yTi4C7SM4ULIDrPwoAML9Ofwhg8AoIIJYCsL+D+0cBAKAAMMSBO0cBNM2vhPMk456ZU5lfA2cDAKS/DQCPdM9OP574Ot0qKAA82LhJ2NXRnQePe/8zPHu9/lbuw6mfEdvmxbuH9f5QZ0/eGv+l/6SKHQDYAEx5dbScsNIfBUBbT3u9B77NnG0//UveDOyi5iugwVugPVV6KdTOu6DGo1/o7+XGbzHv/RVQhQIYHAMAsxdA7+k/DMPq8vzCRwsQaDUMgw4ACC2AAh3gd0IA0yn5/mf4+ruA7AEAiRtAyQ6wBACSZNcC+NIBndaAvyESmEeN9z/Dph8E8zoIoLyNPwlcowO8BQJkyN4FMHT4OshbIGBqZd7/DLv8LiCvgwDjf9wGUKMDvAUCjP+HF8DQz+sgb4EARi6ArlcBSwAgN25bAF10gCUAmEKx9z/DYX8hTI8/LGYJACTGCAXQ/ipgCQCM/xMWQHergCUAkBWjFUDLq4AlADD+T14AHa0ClgBASoxcAG2uApYAwPg/UwF0sQpYAgD5MEkBtLYKWAIA4/+sBdD4KmAJACTDhAXQTg3cuAToAOCbmVB7/J+8AK5qwO0FkFgAi68ClgDA+L9YASxeA06DAem/ZAFc1UDLHzxAiNUi/9VFVgEvggDj//IFsGANAEj/5Qtg/hqwBAA0VAAz14AOAIz/bRXAVQ00dTcA0l8BlFoFfEsoSH9aLIB5asCLICB8/G+3AGaoAR0Axv/k9G+9AObZBnQASH8FEFcDmw4DdACEpH+4VV9f7ug14EAYktM/efwfhuHoux9/6verP753d5R/z7PXN9wcH051A0h/G0D1hcCBMKSR/t0XwLg1oAMgZPyX/nUKYJQacCAMIenPlb7PALY47HjgxsOAwXkAFEp/43/BDWCUhcAeANLfBhC9ENgDQPrbAEIXAnsASH8bQPRCYA+AGtEv/RXAIU2gA0D6K4DcJtjUAWoApH/vVi7BF5sOCbb8siBHAiD9bQD1dwJ7AEh/BZDbBDoAeol+6a8Axvfzb4+2/K9qAAz+CiC3BnQASH8FoAOAWaNf+iuAJjpADYD0VwA6ABD9CkANANJfAaR1gBqAKaJf+isAHQAGfxSAGgCDPwqg5Q5QAyD6FYAaUAOwa/RLfwVQrQPUAIh+BaAG1ACiX/orADUAcl/0K4DMGtAEiH7RrwDUgBogK/dFvwJQA5oA0Y8CUAOagNKhL/oVgBp4dMD/SxnQe+6LfgXArWpAGdBd6Mt9BcAkTaAPaDDuRb8CYO4aUAwsm/VyXwHQYhPAPOS+AkAZIPdRAGgChD4KAGWA0EcBoBKQ+CgAtAKCHgUAwKRWLgGAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgAABQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAEv6D8v4I+AK37xrAAAAAElFTkSuQmCC","type":"image/png","cache":"public, max-age=31536000, immutable"}};

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
