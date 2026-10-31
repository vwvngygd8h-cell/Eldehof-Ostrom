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

const EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjIuMSDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPGxpbmsgcmVsPSJpY29uIiBocmVmPSJpY29uLTE5Mi5wbmciPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0ic3R5bGVzLmNzcz92PTYuMi4xIj4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwLXNoZWxsIj4KICA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPgogICAgPGRpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPjxzcGFuIGNsYXNzPSJicmFuZC1tYXJrIj7ijII8L3NwYW4+PHNwYW4+RWxkZWhvZjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3VidGl0bGUiPlZlcmJyYXVjaHNidWNoPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJidWlsZC1waWxsIj42LjIuMTwvc3Bhbj4KICA8L2hlYWRlcj4KCiAgPG1haW4+CiAgICA8ZGl2IGlkPSJyZWNvdmVyeUJhbm5lciIgY2xhc3M9ImJhbm5lciB3YXJuaW5nIGhpZGRlbiIgcm9sZT0ic3RhdHVzIj4KICAgICAgPGRpdj48c3Ryb25nPkxva2FsZSBTaWNoZXJoZWl0c2tvcGllIGdlZnVuZGVuPC9zdHJvbmc+PHNwYW4+RGVyIG5vcm1hbGUgTW9uYXRzZGF0ZW5zcGVpY2hlciBpc3QgbGVlciwgYWJlciBlaW5lIGZyw7xoZXJlIGxva2FsZSBLb3BpZSBpc3Qgdm9yaGFuZGVuLjwvc3Bhbj48L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0icmVzdG9yZVNoYWRvd0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldpZWRlcmhlcnN0ZWxsZW48L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IGFjdGl2ZSIgaWQ9ImRhc2hib2FyZFZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGFzaGJvYXJkVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPsOcQkVSU0lDSFQ8L3NwYW4+PGgxIGlkPSJkYXNoYm9hcmRUaXRsZSI+VmVyYnJhdWNoIGF1ZiBlaW5lbiBCbGljazwvaDE+PHA+TnVyIGRhcyBXZXNlbnRsaWNoZTogWsOkaGxlcnN0w6RuZGUsIFfDpHJtZXB1bXBlIHVuZCBPc3Ryb20tUHJlaXNlLjwvcD48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBpZD0iZGFzaGJvYXJkQWRkQnRuIiB0eXBlPSJidXR0b24iPisgWsOkaGxlcnN0w6RuZGU8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgbGF0ZXN0LXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5MRVRaVEVSIE1PTkFUPC9zcGFuPjxoMiBpZD0ibGF0ZXN0TW9udGhUaXRsZSI+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZTwvaDI+PC9kaXY+PGJ1dHRvbiBpZD0iZWRpdExhdGVzdEJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IGhpZGRlbiIgdHlwZT0iYnV0dG9uIj5CZWFyYmVpdGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQiIGlkPSJsYXRlc3RNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0iY29tcGFyaXNvbi1saW5lIiBpZD0ibGF0ZXN0Q29tcGFyaXNvbiI+PC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgb3N0cm9tLXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj4KICAgICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0PC9oMj48c21hbGwgaWQ9Im9zdHJvbVN0YXR1cyI+Tm9jaCBuaWNodCBnZWxhZGVuPC9zbWFsbD48L2Rpdj4KICAgICAgICAgIDxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5Ba3R1YWxpc2llcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0ib3N0cm9tU2V0dXBIaW50IiBjbGFzcz0iZW1wdHktc3RhdGUgaGlkZGVuIj48c3Ryb25nPk9zdHJvbSBpc3Qgbm9jaCBuaWNodCBlaW5nZXJpY2h0ZXQuPC9zdHJvbmc+PHNwYW4+RGVuIEVsZGVob2YtQXBwLVNjaGzDvHNzZWwgZmluZGVzdCBkdSB1bnRlciBEYXRlbiDihpIgT3N0cm9tLjwvc3Bhbj48YnV0dG9uIGlkPSJnb09zdHJvbVNldHRpbmdzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+RWlucmljaHRlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9Im9zdHJvbURhc2hib2FyZCIgY2xhc3M9Im9zdHJvbS1ncmlkIj4KICAgICAgICAgIDxhcnRpY2xlIGNsYXNzPSJwcmljZS1jYXJkIGN1cnJlbnQiPjxzcGFuPkFrdHVlbGxlciBQcmVpczwvc3Bhbj48c3Ryb25nIGlkPSJvc3Ryb21DdXJyZW50UHJpY2UiPuKAkzwvc3Ryb25nPjxzbWFsbCBpZD0ib3N0cm9tQ3VycmVudE1ldGEiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgPGFydGljbGUgY2xhc3M9InByaWNlLWNhcmQgYmVzdCI+PHNwYW4gaWQ9Im9zdHJvbUJlc3RMYWJlbCI+QmVzdGVzIFplaXRmZW5zdGVyPC9zcGFuPjxzdHJvbmcgaWQ9Im9zdHJvbUJlc3RQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21CZXN0TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8YXJ0aWNsZSBjbGFzcz0icHJpY2UtY2FyZCB3b3JzdCI+PHNwYW4gaWQ9Im9zdHJvbVdvcnN0TGFiZWwiPlNjaGxlY2h0ZXN0ZXMgWmVpdGZlbnN0ZXI8L3NwYW4+PHN0cm9uZyBpZD0ib3N0cm9tV29yc3RQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21Xb3JzdE1ldGEiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgcHJpY2UtY2hhcnQtd3JhcCI+PGNhbnZhcyBpZD0ib3N0cm9tTWluaUNoYXJ0IiBhcmlhLWxhYmVsPSJPc3Ryb20gUHJlaXN2ZXJsYXVmIj48L2NhbnZhcz48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGRhc2hib2FyZC1jaGFydC1wYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+VkVSTEFVRjwvc3Bhbj48aDI+R2VzYW10dmVyYnJhdWNoPC9oMj48L2Rpdj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgZGF0YS1uYXY9ImFuYWx5c2lzVmlldyIgdHlwZT0iYnV0dG9uIj5BdXN3ZXJ0dW5nIMO2ZmZuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC13cmFwIj48Y2FudmFzIGlkPSJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IiBhcmlhLWxhYmVsPSJHZXNhbXR2ZXJicmF1Y2ggZGVyIGxldHp0ZW4gTW9uYXRlIj48L2NhbnZhcz48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iY29uc3VtcHRpb25WaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImNvbnN1bXB0aW9uVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlZFUkJSQVVDSDwvc3Bhbj48aDEgaWQ9ImNvbnN1bXB0aW9uVGl0bGUiPk1vbmF0c3dlcnRlPC9oMT48cD5HZXNhbXQtIHVuZCBBbHRlbnRlaWwtVmVyYnJhdWNoIGVudHN0ZWhlbiBhdXMgZGVuIFrDpGhsZXJzdMOkbmRlbi4gV8Okcm1lcHVtcGUga29tbXQgYXVzIGRlciBteVZBSUxMQU5ULUNTVjsgU2NobGVlL0tsdXMgd2lyZCBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJhZGRSZWNvcmRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdG9vbGJhciI+PHN0cm9uZyBpZD0icmVjb3JkQ291bnQiPjAgTW9uYXRlPC9zdHJvbmc+PHNlbGVjdCBpZD0icmVjb3JkWWVhckZpbHRlciIgYXJpYS1sYWJlbD0iSmFociBmaWx0ZXJuIj48b3B0aW9uIHZhbHVlPSJhbGwiPkFsbGUgSmFocmU8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJyZWNvcmRMaXN0IiBjbGFzcz0icmVjb3JkLWxpc3QiPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJhbmFseXNpc1ZpZXciIGFyaWEtbGFiZWxsZWRieT0iYW5hbHlzaXNUaXRsZSI+CiAgICAgIDxkaXYgY2xhc3M9InBhZ2UtaGVhZCI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+QVVTV0VSVFVORzwvc3Bhbj48aDEgaWQ9ImFuYWx5c2lzVGl0bGUiPlZlcmJyYXVjaCB2ZXJzdGVoZW48L2gxPjxwPkphaHJlc3dlcnRlLCBBdWZ0ZWlsdW5nLCBLb3N0ZW4gdW5kIFfDpHJtZXB1bXBlbi1FZmZpemllbnouPC9wPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGZpbHRlci1wYW5lbCI+CiAgICAgICAgPGxhYmVsPkRldGFpbGphaHI8c2VsZWN0IGlkPSJhbmFseXNpc1llYXIiPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0iYW5hbHlzaXMtYWxsLXllYXJzLWhpbnQiPjxzdHJvbmc+TWVocmphaHJlc3ZlcmdsZWljaDwvc3Ryb25nPjxzcGFuPkFsbGUgdm9yaGFuZGVuZW4gSmFocmUgd2VyZGVuIGdlbWVpbnNhbSBkYXJnZXN0ZWxsdC4gVmVyZ2FuZ2VuZSBKYWhyZSBnZXN0cmljaGVsdCwgZGFzIGFrdHVlbGxlIEphaHIgZHVyY2hnZXpvZ2VuLjwvc3Bhbj48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0ibWV0cmljLWdyaWQgYW5hbHlzaXMtbWV0cmljcyIgaWQ9ImFuYWx5c2lzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkFVRlRFSUxVTkc8L3NwYW4+PGgyPlfDpHJtZXB1bXBlIMK3IEFsdGVudGVpbCDCtyBTY2hsZWUvS2x1czwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ibGVnZW5kIj48c3BhbiBjbGFzcz0iaGVhdCI+V8Okcm1lcHVtcGU8L3NwYW4+PHNwYW4gY2xhc3M9ImFubmV4Ij5BbHRlbnRlaWw8L3NwYW4+PHNwYW4gY2xhc3M9InJlc3QiPlNjaGxlZS9LbHVzPC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImFsbG9jYXRpb25DaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1FSFJKQUhSRVNWRVJHTEVJQ0g8L3NwYW4+PGgyPkdlc2FtdHZlcmJyYXVjaCBuYWNoIE1vbmF0ZW48L2gyPjwvZGl2PjwvZGl2PjxkaXYgaWQ9InllYXJDb21wYXJpc29uTGVnZW5kIiBjbGFzcz0ieWVhci1jb21wYXJpc29uLWxlZ2VuZCI+PC9kaXY+PGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBsYXJnZSI+PGNhbnZhcyBpZD0idG90YWxDaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJvc3Ryb21QcmljZVN0YXRzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTS1QUkVJU0U8L3NwYW4+PGgyPsOYIGtXaC1QcmVpcyDCtyBNb25hdCDCtyBRdWFydGFsIMK3IEphaHI8L2gyPjwvZGl2PjxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21QcmljZVN0YXRzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+T3N0cm9tLVByZWlzZSBha3R1YWxpc2llcmVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EZXIgQXJiZWl0c3ByZWlzIHdpcmQgYXVzIGRlbiB2b24gT3N0cm9tIGdlbGllZmVydGVuIFN0dW5kZW5wcmVpc2VuIHVuZCBkZWluZW0gdGF0c8OkY2hsaWNoZW4gT3N0cm9tLVZlcmJyYXVjaCB2ZXJicmF1Y2hzZ2V3aWNodGV0IGJlcmVjaG5ldC4gUXVhcnRhbHMtIHVuZCBKYWhyZXN3ZXJ0ZSBzaW5kIGRhaGVyIGtlaW4gZWluZmFjaGVyIE1pdHRlbHdlcnQgZGVyIE1vbmF0ZS48L3A+CiAgICAgICAgPHNlY3Rpb24gY2xhc3M9Im1ldHJpYy1ncmlkIGFuYWx5c2lzLW1ldHJpY3MiIGlkPSJvc3Ryb21QcmljZVN0YXRzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9Im9zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0IiBhcmlhLWxhYmVsPSJEdXJjaHNjaG5pdHRsaWNoZXIgT3N0cm9tLUFyYmVpdHNwcmVpcyBwcm8gTW9uYXQiPjwvY2FudmFzPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk1vbmF0PC90aD48dGg+w5ggQXJiZWl0c3ByZWlzPC90aD48dGg+RWZmZWt0aXYgaW5rbC4gRml4a29zdGVuPC90aD48dGg+T3N0cm9tLVZlcmJyYXVjaDwvdGg+PHRoPlN0YXR1czwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0ib3N0cm9tUHJpY2VTdGF0c1RhYmxlIj48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgICAgPHAgaWQ9Im9zdHJvbVByaWNlU3RhdHNTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+PC9wPgogICAgICA8L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5Nb25hdGxpY2hlIFN0cm9ta29zdGVuPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJjb3N0Q2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0iY29wUGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlfDhFJNRVBVTVBFPC9zcGFuPjxoMj5BcmJlaXRzemFobDwvaDI+PC9kaXY+PC9kaXY+PHAgY2xhc3M9Im11dGVkIj5XaXJkIG51ciBhdXMgTW9uYXRlbiBtaXQgZG9rdW1lbnRpZXJ0ZXIgZXJ6ZXVndGVyIFfDpHJtZSBiZXJlY2huZXQuPC9wPjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImNvcENoYXJ0Ij48L2NhbnZhcz48L2Rpdj48L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+TU9OQVRFPC9zcGFuPjxoMj5KYWhyZXPDvGJlcnNpY2h0PC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPkdlc2FtdDwvdGg+PHRoPldQPC90aD48dGg+QWx0ZW50ZWlsPC90aD48dGg+U2NobGVlL0tsdXM8L3RoPjx0aD5Lb3N0ZW48L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImFuYWx5c2lzVGFibGUiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj48L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJkYXRhVmlldyIgYXJpYS1sYWJlbGxlZGJ5PSJkYXRhVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkRBVEVOPC9zcGFuPjxoMSBpZD0iZGF0YVRpdGxlIj5CYWNrdXAgJiBFaW5zdGVsbHVuZ2VuPC9oMT48cD5aw6RobGVyc3TDpG5kZSwgbXlWQUlMTEFOVC1JbXBvcnQsIFNpY2hlcnVuZyB1bmQgT3N0cm9tLjwvcD48L2Rpdj48L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+REFURU5RVUFMSVTDhFQ8L3NwYW4+PGgyPk1vbmF0c3dlcnRlIHByw7xmZW48L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIGNvbXBhY3QtbWV0cmljcyIgaWQ9InF1YWxpdHlNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJxdWFsaXR5SXNzdWVzIiBjbGFzcz0iaXNzdWUtbGlzdCI+PC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KCgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJtZXRlclBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDI+R2VzYW10ICYgQWx0ZW50ZWlsPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJhZGRNZXRlckJ0biIgY2xhc3M9InByaW1hcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj4rIEVpbnRyYWdlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RHUgdHLDpGdzdCBudXIgZGllIGJlaWRlbiBha3R1ZWxsZW4gWsOkaGxlcnN0w6RuZGUgZWluLiBFbGRlaG9mIGJlcmVjaG5ldCBkYXJhdXMgYXV0b21hdGlzY2ggZGVuIE1vbmF0c3ZlcmJyYXVjaC4gQXVzZ2FuZ3NwdW5rdCBpc3QgZGVyIDAxLjEwLjIwMjYgbWl0IEdlc2FtdCAzNC4yNTUga1doIHVuZCBBbHRlbnRlaWwgOS4wNDUga1doLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBtZXRlci1sYXRlc3QiIGlkPSJtZXRlckxhdGVzdCI+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibWV0ZXJIaXN0b3J5IiBjbGFzcz0ibWV0ZXItaGlzdG9yeSI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyBtZXRlci1hY3Rpb25zIj48YnV0dG9uIGlkPSJ1bmRvTGF0ZXN0TWV0ZXJCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+TGV0enRlbiBaw6RobGVyc3RhbmQgenVyw7xja25laG1lbjwvYnV0dG9uPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJ2YWlsbGFudEltcG9ydFBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5Xw4RSTUVQVU1QRTwvc3Bhbj48aDI+bXlWQUlMTEFOVC1EYXRlbiBpbXBvcnRpZXJlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5Xw6RobGUgZGllIGV4cG9ydGllcnRlbiBDU1YtRGF0ZWllbiB2b24gYXJvVEhFUk0gdW5kIHVuaVRPV0VSLiBEYXJhdXMgw7xiZXJuaW1tdCBFbGRlaG9mIGRlbiBXw6RybWVwdW1wZW52ZXJicmF1Y2ggdW5kIGRpZSBXw6RybWVtZW5nZW4uIEdlc2FtdCB1bmQgQWx0ZW50ZWlsIGtvbW1lbiBhdXNzY2hsaWXDn2xpY2ggYXVzIGRlaW5lbiBaw6RobGVyc3TDpG5kZW4uPC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBwcmltYXJ5Ij5DU1YtRGF0ZWllbiBhdXN3w6RobGVuPGlucHV0IGlkPSJ2YWlsbGFudENzdkZpbGVzSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iLmNzdix0ZXh0L2Nzdix0ZXh0L3BsYWluIiBtdWx0aXBsZSBoaWRkZW4+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0idmFpbGxhbnRJbXBvcnRTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+Tm9jaCBrZWluZSBEYXRlaWVuIGF1c2dld8OkaGx0LjwvcD4KICAgICAgPC9zZWN0aW9uPgoKCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9InN5bmNQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+R0VSw4RURS1TWU5DPC9zcGFuPjxoMj5BdWYgYWxsZW4gR2Vyw6R0ZW4gYWt0dWVsbDwvaDI+PC9kaXY+PHNwYW4gaWQ9InN5bmNCYWRnZSIgY2xhc3M9InN5bmMtYmFkZ2UiPm5pY2h0IGVpbmdlcmljaHRldDwvc3Bhbj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkVsZGVob2Ygc3luY2hyb25pc2llcnQgTW9uYXRzd2VydGUsIFrDpGhsZXJzdMOkbmRlLCBpbXBvcnRpZXJ0ZSBWYWlsbGFudC1XZXJ0ZSB1bmQgYmVyZWNobmV0ZSBPc3Ryb20tS29zdGVuIHZlcnNjaGzDvHNzZWx0IMO8YmVyIGRlbiBiZXN0ZWhlbmRlbiBDbG91ZGZsYXJlLVRyZXNvci4gTmFjaCBlaW5lciDDhG5kZXJ1bmcgd2lyZCBhdXRvbWF0aXNjaCBob2NoZ2VsYWRlbjsgYmVpbSDDlmZmbmVuIG9kZXIgWnVyw7xja2tlaHJlbiBpbiBkaWUgQXBwIHdpcmQgYXV0b21hdGlzY2ggZGVyIG5ldWVzdGUgU3RhbmQgZ2VsYWRlbi48L3A+CiAgICAgICAgPGRpdiBpZD0ic3luY1NldHVwQm94Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5EaWVzZXMgR2Vyw6R0IGJlbmVubmVuPGlucHV0IGlkPSJzeW5jQ3JlYXRlRGV2aWNlTmFtZSIgdHlwZT0idGV4dCIgbWF4bGVuZ3RoPSI2MCIgcGxhY2Vob2xkZXI9InouIEIuIGlQYWQgS8O8Y2hlIj48L2xhYmVsPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzeW5jQ3JlYXRlQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5HZXLDpHRlLVN5bmMgZWlucmljaHRlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRldGFpbHMgY2xhc3M9InN5bmMtam9pbi1ib3giPjxzdW1tYXJ5PkRpZXNlcyBHZXLDpHQgbWl0IGJlc3RlaGVuZGVtIEVsZGVob2Yga29wcGVsbjwvc3VtbWFyeT4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+VHJlc29yLUlEPGlucHV0IGlkPSJzeW5jSm9pblZhdWx0SWQiIHR5cGU9InRleHQiIGF1dG9jb21wbGV0ZT0ib2ZmIj48L2xhYmVsPgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPktvcHBsdW5nc2NvZGU8aW5wdXQgaWQ9InN5bmNKb2luQ29kZSIgdHlwZT0idGV4dCIgYXV0b2NvbXBsZXRlPSJvbmUtdGltZS1jb2RlIiBwbGFjZWhvbGRlcj0iWFhYWC1YWFhYLVhYWFgiPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+V2llZGVyaGVyc3RlbGx1bmdzc2NobMO8c3NlbDx0ZXh0YXJlYSBpZD0ic3luY0pvaW5SZWNvdmVyeSIgcm93cz0iMyIgYXV0b2NvbXBsZXRlPSJvZmYiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5EaWVzZXMgR2Vyw6R0IGJlbmVubmVuPGlucHV0IGlkPSJzeW5jSm9pbkRldmljZU5hbWUiIHR5cGU9InRleHQiIG1heGxlbmd0aD0iNjAiIHBsYWNlaG9sZGVyPSJ6LiBCLiBpUGhvbmUiPjwvbGFiZWw+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8YnV0dG9uIGlkPSJzeW5jSm9pbkJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+R2Vyw6R0IGtvcHBlbG48L2J1dHRvbj4KICAgICAgICAgIDwvZGV0YWlscz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJzeW5jQWN0aXZlQm94IiBjbGFzcz0iaGlkZGVuIj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIHN5bmMtbWV0cmljcyI+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPkdlcsOkdDwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jRGV2aWNlVGV4dCI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJzeW5jUm9sZVRleHQiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgICA8YXJ0aWNsZT48c3Bhbj5UcmVzb3ItVmVyc2lvbjwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jUmV2aXNpb25UZXh0Ij4wPC9zdHJvbmc+PHNtYWxsIGlkPSJzeW5jTGFzdFRleHQiPm5vY2ggbmllPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICAgIDxhcnRpY2xlPjxzcGFuPkF1dG9tYXRpazwvc3Bhbj48c3Ryb25nPmFrdGl2PC9zdHJvbmc+PHNtYWxsPmJlaSBBcHAtU3RhcnQsIFLDvGNra2VociB1bmQgbmFjaCDDhG5kZXJ1bmdlbjwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzeW5jTm93QnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5KZXR6dCBzeW5jaHJvbmlzaWVyZW48L2J1dHRvbj48YnV0dG9uIGlkPSJzeW5jUGFpckJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5OZXVlcyBHZXLDpHQga29wcGVsbjwvYnV0dG9uPjxidXR0b24gaWQ9InN5bmNEaXNjb25uZWN0QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkRpZXNlcyBHZXLDpHQgdHJlbm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRpdiBpZD0ic3luY1BhaXJSZXN1bHQiIGNsYXNzPSJzeW5jLXBhaXItcmVzdWx0IGhpZGRlbiI+PHN0cm9uZz5Lb3BwbHVuZ3NkYXRlbiBmw7xyIGRhcyBuZXVlIEdlcsOkdDwvc3Ryb25nPjxzcGFuPlRyZXNvci1JRDwvc3Bhbj48Y29kZSBpZD0ic3luY1BhaXJWYXVsdCI+4oCTPC9jb2RlPjxzcGFuPkNvZGUgKDEwIE1pbnV0ZW4pPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpckNvZGUiPuKAkzwvY29kZT48c3Bhbj5XaWVkZXJoZXJzdGVsbHVuZ3NzY2hsw7xzc2VsPC9zcGFuPjxjb2RlIGlkPSJzeW5jUGFpclJlY292ZXJ5Ij7igJM8L2NvZGU+PHNtYWxsIGlkPSJzeW5jUGFpckV4cGlyeSI+PC9zbWFsbD48L2Rpdj4KICAgICAgICAgIDxwIGlkPSJzeW5jU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgICA8L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5TSUNIRVJVTkc8L3NwYW4+PGgyPlByaXZhdGVzIEJhY2t1cDwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EYXMgcHJpdmF0ZSBCYWNrdXAgZW50aMOkbHQgZGVpbmUgVmVyYnJhdWNoc2RhdGVuIHVuZCDigJMgc29mZXJuIGdlc3BlaWNoZXJ0IOKAkyBhdWNoIGRlbiBPc3Ryb20tQXBwLVNjaGzDvHNzZWwuIE5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbi48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRCYWNrdXBCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkJhY2t1cCBleHBvcnRpZXJlbjwvYnV0dG9uPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBzZWNvbmRhcnkiPkJhY2t1cCBpbXBvcnRpZXJlbjxpbnB1dCBpZD0iaW1wb3J0QmFja3VwSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iYXBwbGljYXRpb24vanNvbiwuanNvbiIgaGlkZGVuPjwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRDc3ZCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+Q1NWIGV4cG9ydGllcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPHAgaWQ9ImJhY2t1cFN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im9zdHJvbVNldHRpbmdzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0IHZlcmJpbmRlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+RWxkZWhvZi1BcHAtU2NobMO8c3NlbDxpbnB1dCBpZD0ib3N0cm9tQXBwS2V5SW5wdXQiIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9Im9mZiIgcGxhY2Vob2xkZXI9IkFwcC1TY2hsw7xzc2VsIj48L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+WmVpdGZlbnN0ZXI8c2VsZWN0IGlkPSJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0Ij48b3B0aW9uIHZhbHVlPSIxIj4xIFN0dW5kZTwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjIiPjIgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjMiPjMgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjQiPjQgU3R1bmRlbjwvb3B0aW9uPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InN3aXRjaC1yb3ciPjxpbnB1dCBpZD0ib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIgdHlwZT0iY2hlY2tib3giPjxzcGFuPkF1dG9tYXRpc2NoIGFsbGUgMTAgTWludXRlbiBha3R1YWxpc2llcmVuPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+PGJ1dHRvbiBpZD0ic2F2ZU9zdHJvbUJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuICYgcHLDvGZlbjwvYnV0dG9uPjxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21IaXN0b3J5QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkhpc3RvcmlzY2hlIFByZWlzZSBsYWRlbjwvYnV0dG9uPjxidXR0b24gaWQ9ImRpc2Nvbm5lY3RPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+VmVyYmluZHVuZyBlbnRmZXJuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBpZD0ib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgICAgPHAgaWQ9Im9zdHJvbUhpc3RvcnlTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+SGlzdG9yaXNjaGUgUHJlaXNlIG5vY2ggbmljaHQgZ2VwcsO8ZnQuPC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPktPU1RFTjwvc3Bhbj48aDI+RmFsbGJhY2stV2VydGU8L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QXJiZWl0c3ByZWlzIOKCrC9rV2g8aW5wdXQgaWQ9ImZhbGxiYWNrUHJpY2VJbnB1dCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+TW9uYXRsaWNoZSBGaXhrb3N0ZW4g4oKsPGlucHV0IGlkPSJkZWZhdWx0QmFzZUZlZUlucHV0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMSI+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJzYXZlQ29zdFNldHRpbmdzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPlNwZWljaGVybjwvYnV0dG9uPgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CiAgPC9tYWluPgoKICA8bmF2IGNsYXNzPSJib3R0b20tbmF2IiBhcmlhLWxhYmVsPSJIYXVwdG5hdmlnYXRpb24iPgogICAgPGJ1dHRvbiBjbGFzcz0iYWN0aXZlIiBkYXRhLW5hdj0iZGFzaGJvYXJkVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7ijII8L3NwYW4+w5xiZXJzaWNodDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iY29uc3VtcHRpb25WaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKWpDwvc3Bhbj5WZXJicmF1Y2g8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS1uYXY9ImFuYWx5c2lzVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7ilqU8L3NwYW4+QXVzd2VydHVuZzwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iZGF0YVZpZXciIHR5cGU9ImJ1dHRvbiI+PHNwYW4+4pqZPC9zcGFuPkRhdGVuPC9idXR0b24+CiAgPC9uYXY+CjwvZGl2PgoKPGRpdiBpZD0icmVjb3JkTW9kYWwiIGNsYXNzPSJtb2RhbCBoaWRkZW4iIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbGxlZGJ5PSJyZWNvcmRNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWw+PC9kaXY+CiAgPGZvcm0gY2xhc3M9Im1vZGFsLWNhcmQiIGlkPSJyZWNvcmRGb3JtIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk1PTkFUIEJFQVJCRUlURU48L3NwYW4+PGgyIGlkPSJyZWNvcmRNb2RhbFRpdGxlIj5Nb25hdCBiZWFyYmVpdGVuPC9oMj48L2Rpdj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imljb24tYnV0dG9uIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPGlucHV0IGlkPSJlZGl0aW5nTW9udGhPcmlnaW5hbCIgdHlwZT0iaGlkZGVuIj4KICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPk1vbmF0PGlucHV0IGlkPSJyZWNvcmRNb250aCIgdHlwZT0ibW9udGgiIHJlYWRvbmx5PjwvbGFiZWw+CiAgICAgIDxzcGFuPjwvc3Bhbj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+R2VzYW10dmVyYnJhdWNoIGtXaDxpbnB1dCBpZD0icmVjb3JkVG90YWwiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIj48L2xhYmVsPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BbHRlbnRlaWwga1doPGlucHV0IGlkPSJyZWNvcmRBbm5leCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPlfDpHJtZXB1bXBlIGtXaDxpbnB1dCBpZD0icmVjb3JkSGVhdFB1bXAiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIj48L2xhYmVsPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj7DmCBTdHJvbXByZWlzIGN0L2tXaDxpbnB1dCBpZD0icmVjb3JkUHJpY2VDdCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkZpeGtvc3RlbiDigqw8aW5wdXQgaWQ9InJlY29yZEJhc2VGZWUiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9ImRlcml2ZWRQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5TY2hsZWUvS2x1czog4oCTPC9kaXY+CiAgICA8cCBpZD0icmVjb3JkU291cmNlSGludCIgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+PC9wPgogICAgPGRldGFpbHMgY2xhc3M9ImRldGFpbHMtY2FyZCI+PHN1bW1hcnk+V8Okcm1lcHVtcGVuLURldGFpbHMgKG9wdGlvbmFsKTwvc3VtbWFyeT48ZGl2IGNsYXNzPSJmb3JtLWdyaWQgZGV0YWlsLWdyaWQiPjxsYWJlbCBjbGFzcz0iZmllbGQiPkVyemV1Z3RlIFfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRHZW5lcmF0ZWQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48bGFiZWwgY2xhc3M9ImZpZWxkIj5IZWl6c3Ryb20ga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0aW5nRWxlY3RyaWNpdHkiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48bGFiZWwgY2xhc3M9ImZpZWxkIj5XYXJtd2Fzc2Vyc3Ryb20ga1doPGlucHV0IGlkPSJyZWNvcmREaHdFbGVjdHJpY2l0eSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPkhlaXp3w6RybWUga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0aW5nSGVhdCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPldhcm13YXNzZXJ3w6RybWUga1doPGlucHV0IGlkPSJyZWNvcmREaHdIZWF0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PC9kaXY+PC9kZXRhaWxzPgogICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+Tm90aXo8dGV4dGFyZWEgaWQ9InJlY29yZE5vdGUiIHJvd3M9IjMiIG1heGxlbmd0aD0iODAwIj48L3RleHRhcmVhPjwvbGFiZWw+CiAgICA8cCBpZD0icmVjb3JkVmFsaWRhdGlvbiIgY2xhc3M9InZhbGlkYXRpb24tdGV4dCI+PC9wPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+PHNwYW4gY2xhc3M9InNwYWNlciI+PC9zcGFuPjxidXR0b24gY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbD5BYmJyZWNoZW48L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJzdWJtaXQiPsOEbmRlcnVuZ2VuIHNwZWljaGVybjwvYnV0dG9uPjwvZGl2PgogIDwvZm9ybT4KPC9kaXY+Cgo8ZGl2IGlkPSJtZXRlck1vZGFsIiBjbGFzcz0ibW9kYWwgaGlkZGVuIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWxsZWRieT0ibWV0ZXJNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbD48L2Rpdj4KICA8Zm9ybSBjbGFzcz0ibW9kYWwtY2FyZCIgaWQ9Im1ldGVyRm9ybSI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDIgaWQ9Im1ldGVyTW9kYWxUaXRsZSI+TmV1ZSBBYmxlc3VuZzwvaDI+PC9kaXY+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJpY29uLWJ1dHRvbiIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPHAgaWQ9Im1ldGVyUHJldmlvdXMiIGNsYXNzPSJtZXRlci1wcmV2aW91cyI+PC9wPgogICAgPHAgaWQ9Im1ldGVyVGFyZ2V0TW9udGgiIGNsYXNzPSJtdXRlZCI+PC9wPgogICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QWJsZXNlZGF0dW08aW5wdXQgaWQ9Im1ldGVyRGF0ZSIgdHlwZT0iZGF0ZSIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgPHNwYW4+PC9zcGFuPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5HZXNhbXQtWsOkaGxlcnN0YW5kIGtXaDxpbnB1dCBpZD0ibWV0ZXJUb3RhbCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiIHJlcXVpcmVkPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkFsdGVudGVpbC1aw6RobGVyc3RhbmQga1doPGlucHV0IGlkPSJtZXRlckFubmV4IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0ibWV0ZXJQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5Nb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXV0b21hdGlzY2ggYmVyZWNobmV0LjwvZGl2PgogICAgPHAgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+RGllIFfDpHJtZXB1bXBlIHdpcmQgbmljaHQgaGllciBlaW5nZXRyYWdlbi4gU2llIGtvbW10IGF1c3NjaGxpZcOfbGljaCBhdXMgZGVtIG15VkFJTExBTlQtQ1NWLUltcG9ydC48L3A+CiAgICA8cCBpZD0ibWV0ZXJWYWxpZGF0aW9uIiBjbGFzcz0idmFsaWRhdGlvbi10ZXh0Ij48L3A+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj48c3BhbiBjbGFzcz0ic3BhY2VyIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iIGRhdGEtY2xvc2UtbWV0ZXItbW9kYWw+QWJicmVjaGVuPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgdHlwZT0ic3VibWl0Ij5aw6RobGVyc3TDpG5kZSBzcGVpY2hlcm48L2J1dHRvbj48L2Rpdj4KICA8L2Zvcm0+CjwvZGl2PgoKPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJ0b2FzdCBoaWRkZW4iIHJvbGU9InN0YXR1cyIgYXJpYS1saXZlPSJwb2xpdGUiPjwvZGl2Pgo8c2NyaXB0IHNyYz0iYXBwLmpzP3Y9Ni4yLjEtc3luY2ZpeC0yMDI2MTAzMSI+PC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=","type":"text/html; charset=utf-8","cache":"no-cache"},"/styles.css":{"body":"OnJvb3R7CiAgY29sb3Itc2NoZW1lOmRhcms7CiAgLS1iZzojMDYxMDFjOwogIC0tcGFuZWw6IzBjMWEyYTsKICAtLXBhbmVsMjojMTAyMjM1OwogIC0tbGluZTpyZ2JhKDE3MSwxOTgsMjIwLC4xNCk7CiAgLS10ZXh0OiNmNGY4ZmI7CiAgLS1tdXRlZDojOTRhOGJhOwogIC0tZ3JlZW46IzcyZGM1NzsKICAtLW9yYW5nZTojZmY5ZjQzOwogIC0tYmx1ZTojNGQ5Y2ZmOwogIC0teWVsbG93OiNmMmQxNWY7CiAgLS1yZWQ6I2ZmNmI2YjsKICAtLXNoYWRvdzowIDE4cHggNTVweCByZ2JhKDAsMCwwLC4yNCk7CiAgLS1yYWRpdXM6MjBweDsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbHtiYWNrZ3JvdW5kOnZhcigtLWJnKTttaW4taGVpZ2h0OjEwMCU7Zm9udC1mYW1pbHk6SW50ZXIsLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixzYW5zLXNlcmlmOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQpib2R5e21hcmdpbjowO2JhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCB0b3AgcmlnaHQscmdiYSg2MCwxMjAsMTcwLC4xMCksdHJhbnNwYXJlbnQgMzUlKSx2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7bWluLWhlaWdodDoxMDB2aH0KYnV0dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXR9CmJ1dHRvbntjdXJzb3I6cG9pbnRlcn0KYnV0dG9uOmRpc2FibGVke29wYWNpdHk6LjQ4O2N1cnNvcjpub3QtYWxsb3dlZH0KLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQouYXBwLXNoZWxse21heC13aWR0aDoxMTgwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjAgMjJweCAxMTJweH0KLnRvcGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6Y2FsYygxNnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKSAwIDE4cHg7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MzA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQodG8gYm90dG9tLHJnYmEoNiwxNiwyOCwuOTgpLHJnYmEoNiwxNiwyOCwuODYpLHJnYmEoNiwxNiwyOCwwKSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCl9Ci5icmFuZHtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0Ojg1MDtsZXR0ZXItc3BhY2luZzotLjAzZW19LmJyYW5kLW1hcmt7ZGlzcGxheTppbmxpbmUtZ3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6MzZweDtoZWlnaHQ6MzZweDtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxZTYzMzMsIzJmOGU0OSk7Ym94LXNoYWRvdzowIDZweCAyNHB4IHJnYmEoNTMsMTkwLDkxLC4xOCl9Ci5zdWJ0aXRsZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWxlZnQ6NDZweDttYXJnaW4tdG9wOi00cHh9LmJ1aWxkLXBpbGx7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4xMik7Y29sb3I6I2I5ZjVhYTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTE0LDIyMCw4NywuMjIpO3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLXJhZGl1czo5OTlweH0KbWFpbntkaXNwbGF5OmJsb2NrfS52aWV3e2Rpc3BsYXk6bm9uZTthbmltYXRpb246ZmFkZSAuMThzIGVhc2V9LnZpZXcuYWN0aXZle2Rpc3BsYXk6YmxvY2t9QGtleWZyYW1lcyBmYWRle2Zyb217b3BhY2l0eTouNTt0cmFuc2Zvcm06dHJhbnNsYXRlWSg0cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5wYWdlLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDoyMnB4O21hcmdpbjoxOHB4IDAgMjRweH0ucGFnZS1oZWFkIGgxe2ZvbnQtc2l6ZTpjbGFtcCgyOHB4LDV2dyw0NHB4KTttYXJnaW46M3B4IDAgN3B4O2xpbmUtaGVpZ2h0OjEuMDU7bGV0dGVyLXNwYWNpbmc6LS4wNGVtfS5wYWdlLWhlYWQgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7bWF4LXdpZHRoOjY4MHB4O2xpbmUtaGVpZ2h0OjEuNX0uZXllYnJvd3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xNmVtO2ZvbnQtd2VpZ2h0Ojg1MDtjb2xvcjojN2Y5ZGI0O21hcmdpbi1ib3R0b206NXB4fQoucGFuZWx7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHJnYmEoMTUsMzEsNDgsLjk2KSxyZ2JhKDEwLDI0LDM5LC45OCkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjE4cHg7Ym94LXNoYWRvdzp2YXIoLS1zaGFkb3cpfQoucGFuZWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE4cHh9LnBhbmVsLWhlYWQgaDJ7bWFyZ2luOjJweCAwIDJweDtmb250LXNpemU6MjFweDtsZXR0ZXItc3BhY2luZzotLjAyNWVtfS5wYW5lbC1oZWFkIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0KLnByaW1hcnksLnNlY29uZGFyeSwuZGFuZ2VyLC5maWxlLWJ1dHRvbnthcHBlYXJhbmNlOm5vbmU7Ym9yZGVyLXJhZGl1czoxM3B4O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnQ7cGFkZGluZzoxMXB4IDE1cHg7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLXRleHQpO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjhweDt0ZXh0LWRlY29yYXRpb246bm9uZTttaW4taGVpZ2h0OjQ0cHh9LnByaW1hcnl7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyZjhlNDksIzFmNmMzOCk7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMjgpO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDQ0LDE2MSw3NywuMTgpfS5wcmltYXJ5OmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMDYpfS5zZWNvbmRhcnksLmZpbGUtYnV0dG9ue2JhY2tncm91bmQ6IzEyMjYzYTtib3JkZXItY29sb3I6cmdiYSgxNzAsMjAwLDIyNCwuMTQpO2NvbG9yOiNkY2U5ZjN9LnNlY29uZGFyeTpob3ZlciwuZmlsZS1idXR0b246aG92ZXJ7YmFja2dyb3VuZDojMTczMDQ5fS5kYW5nZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xMCk7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjI1KTtjb2xvcjojZmZhYWE5fS5jb21wYWN0e21pbi1oZWlnaHQ6MzZweDtwYWRkaW5nOjhweCAxMXB4O2ZvbnQtc2l6ZToxM3B4fS5pY29uLWJ1dHRvbntib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjOWQ3ZTI7Zm9udC1zaXplOjMwcHg7bGluZS1oZWlnaHQ6MTtwYWRkaW5nOjAgNnB4fQoubWV0cmljLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNSxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxNnB4O21pbi13aWR0aDowfS5tZXRyaWMtZ3JpZCBhcnRpY2xlIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbTo3cHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZTpjbGFtcCgxOXB4LDN2dywyNnB4KTtsaW5lLWhlaWdodDoxLjE7ZGlzcGxheTpibG9jazt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Lm1ldHJpYy1ncmlkIGFydGljbGUgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojN2Y5NmFhO2ZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NnB4O2xpbmUtaGVpZ2h0OjEuMzV9LmNvbXBhcmlzb24tbGluZXttYXJnaW46MTVweCAwIDA7Y29sb3I6I2I4YzhkNTtmb250LXNpemU6MTNweH0uY29tcGFyaXNvbi1saW5lLnBvc2l0aXZle2NvbG9yOiNmZmIxYTh9LmNvbXBhcmlzb24tbGluZS5uZWdhdGl2ZXtjb2xvcjojYTVlNjlhfS5jb21wYXJpc29uLWxpbmUubmV1dHJhbHtjb2xvcjojYjhjOGQ1fQoub3N0cm9tLXBhbmVse292ZXJmbG93OmhpZGRlbn0ub3N0cm9tLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ucHJpY2UtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMGIxYjJiO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MThweH0ucHJpY2UtY2FyZDpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowIGF1dG8gMCAwO3dpZHRoOjRweDtiYWNrZ3JvdW5kOiM2ZDg1OTl9LnByaWNlLWNhcmQuYmVzdDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ncmVlbil9LnByaWNlLWNhcmQud29yc3Q6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tcmVkKX0ucHJpY2UtY2FyZC5jdXJyZW50OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLWJsdWUpfS5wcmljZS1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9LnByaWNlLWNhcmQgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjI3cHg7bWFyZ2luOjhweCAwIDRweH0ucHJpY2UtY2FyZCBzbWFsbHtjb2xvcjojOWNiMGMwfS5lbXB0eS1zdGF0ZXtib3JkZXI6MXB4IGRhc2hlZCByZ2JhKDE3MCwyMDAsMjI0LC4yKTtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjAyKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6OXB4IDE0cHg7YWxpZ24taXRlbXM6Y2VudGVyfS5lbXB0eS1zdGF0ZSBzdHJvbmd7d2lkdGg6MTAwJX0uZW1wdHktc3RhdGUgc3Bhbntjb2xvcjp2YXIoLS1tdXRlZCk7ZmxleDoxO21pbi13aWR0aDoyMDBweH0ucHJpY2UtY2hhcnQtd3JhcHttYXJnaW4tdG9wOjE2cHh9Ci5jaGFydC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDoyNjBweDt3aWR0aDoxMDAlO21pbi13aWR0aDowfS5jaGFydC13cmFwLmxhcmdle2hlaWdodDozNDBweH0uY2hhcnQtd3JhcCBjYW52YXN7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtkaXNwbGF5OmJsb2NrfS5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjI2MHB4fS5sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNXB4O21hcmdpbjotNnB4IDAgMTRweDtjb2xvcjojYjhjNmQyO2ZvbnQtc2l6ZToxMnB4fS5sZWdlbmQgc3BhbjpiZWZvcmV7Y29udGVudDoiIjtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjNweDttYXJnaW4tcmlnaHQ6NnB4fS5sZWdlbmQgLmhlYXQ6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tb3JhbmdlKX0ubGVnZW5kIC5hbm5leDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ibHVlKX0ubGVnZW5kIC5yZXN0OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyl9Ci5yZWNvcmQtdG9vbGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MTRweH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0LC5maWx0ZXItcGFuZWwgc2VsZWN0e2JhY2tncm91bmQ6IzBiMWEyYTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEwcHggMTJweH0ucmVjb3JkLWxpc3R7ZGlzcGxheTpncmlkO2dhcDoxMHB4fS5yZWNvcmQtcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6bWlubWF4KDE1MHB4LDEuM2ZyKSByZXBlYXQoNCxtaW5tYXgoOTBweCwuODVmcikpIGF1dG87Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGExOTI4O2JvcmRlci1yYWRpdXM6MTVweDtwYWRkaW5nOjEzcHggMTRweH0ucmVjb3JkLXJvdzpob3ZlcntiYWNrZ3JvdW5kOiMwZTIwMzJ9LnJlY29yZC1tb250aCBzdHJvbmd7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTVweH0ucmVjb3JkLW1vbnRoIHNtYWxse2Rpc3BsYXk6YmxvY2s7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6M3B4fS5yZWNvcmQtdmFsdWUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOiM3Zjk2YWE7Zm9udC1zaXplOjEwcHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wOGVtfS5yZWNvcmQtdmFsdWUgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kfS5yZWNvcmQtcm93LmludmFsaWR7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjMpfQouZmlsdGVyLXBhbmVse2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczplbmR9LmZpbHRlci1wYW5lbCBsYWJlbHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWluLXdpZHRoOjE1MHB4fS5hbmFseXNpcy1tZXRyaWNze21hcmdpbi1ib3R0b206MThweH0uYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDUsbWlubWF4KDAsMWZyKSl9Ci50YWJsZS1zY3JvbGx7b3ZlcmZsb3c6YXV0bztib3JkZXItcmFkaXVzOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzIwcHh9dGgsdGR7cGFkZGluZzoxMnB4IDEzcHg7dGV4dC1hbGlnbjpyaWdodDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmb250LXNpemU6MTNweH10aDpmaXJzdC1jaGlsZCx0ZDpmaXJzdC1jaGlsZHt0ZXh0LWFsaWduOmxlZnR9dGh7Zm9udC1zaXplOjExcHg7Y29sb3I6Izg4YTBiNTtsZXR0ZXItc3BhY2luZzouMDVlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7YmFja2dyb3VuZDojMGExOTI4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MH10Ym9keSB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLmNvbXBhY3QtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSl9Lmlzc3VlLWxpc3R7ZGlzcGxheTpncmlkO2dhcDo4cHg7bWFyZ2luLXRvcDoxNHB4fS5pc3N1ZXtkaXNwbGF5OmZsZXg7Z2FwOjEycHg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTJweCAxM3B4O2JvcmRlci1yYWRpdXM6MTNweDtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0uaXNzdWUud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yMil9Lmlzc3VlLmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4yNSl9Lmlzc3VlIGRpdnttaW4td2lkdGg6MH0uaXNzdWUgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEzcHh9Lmlzc3VlIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6M3B4fS5tdXRlZHtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS41NX0uYWN0aW9uLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5zdGF0dXMtdGV4dHttaW4taGVpZ2h0OjEuNGVtO21hcmdpbjoxMnB4IDAgMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHh9LnN0YXR1cy10ZXh0Lm9re2NvbG9yOiNhNWU2OWF9LnN0YXR1cy10ZXh0LmVycm9ye2NvbG9yOiNmZmFhYTl9LnNldHRpbmdzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTNweDttYXJnaW46MTRweCAwfS5maWVsZHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjojOWRiMGMwO2ZvbnQtc2l6ZToxMnB4fS5maWVsZCBpbnB1dCwuZmllbGQgc2VsZWN0LC5maWVsZCB0ZXh0YXJlYXt3aWR0aDoxMDAlO2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTcxLDE5OCwyMjAsLjE2KTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEycHg7b3V0bGluZTpub25lfS5maWVsZCBpbnB1dDpmb2N1cywuZmllbGQgc2VsZWN0OmZvY3VzLC5maWVsZCB0ZXh0YXJlYTpmb2N1c3tib3JkZXItY29sb3I6cmdiYSg3NywxNTYsMjU1LC41NSk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NywxNTYsMjU1LC4wOCl9LnN3aXRjaC1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjExcHggMTNweDtjb2xvcjojYzdkNWRmfS5zd2l0Y2gtcm93IGlucHV0e3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7YWNjZW50LWNvbG9yOiMzYzlhNTN9Ci5iYW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTZweDttYXJnaW46MTJweCAwIDE4cHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxNXB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGQyMDMyfS5iYW5uZXIud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yOCk7YmFja2dyb3VuZDpyZ2JhKDI0MiwyMDksOTUsLjA2KX0uYmFubmVyIHN0cm9uZywuYmFubmVyIHNwYW57ZGlzcGxheTpibG9ja30uYmFubmVyIHNwYW57Y29sb3I6I2IzYzBjYTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjNweH0KLmJvdHRvbS1uYXZ7cG9zaXRpb246Zml4ZWQ7ei1pbmRleDo0MDtsZWZ0OjUwJTtib3R0b206bWF4KDEycHgsZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7d2lkdGg6bWluKDYyMHB4LGNhbGMoMTAwJSAtIDI0cHgpKTtiYWNrZ3JvdW5kOnJnYmEoOCwyMCwzMywuOTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTYpO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjdweDtib3gtc2hhZG93OjAgMTZweCA1MHB4IHJnYmEoMCwwLDAsLjQyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxNnB4KX0uYm90dG9tLW5hdiBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojODU5OWFhO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjlweCA4cHg7ZGlzcGxheTpncmlkO2dhcDozcHg7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MDttaW4td2lkdGg6MH0uYm90dG9tLW5hdiBidXR0b24gc3Bhbntmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfS5ib3R0b20tbmF2IGJ1dHRvbi5hY3RpdmV7YmFja2dyb3VuZDojMTUzMTQ3O2NvbG9yOiNmNGY4ZmJ9Ci5tb2RhbHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7cGFkZGluZzoxOHB4fS5tb2RhbC1iYWNrZHJvcHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNzIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDVweCl9Lm1vZGFsLWNhcmR7cG9zaXRpb246cmVsYXRpdmU7d2lkdGg6bWluKDc2MHB4LDEwMCUpO21heC1oZWlnaHQ6Y2FsYygxMDB2aCAtIDM2cHgpO292ZXJmbG93OmF1dG87YmFja2dyb3VuZDojMGIxYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTgpO2JvcmRlci1yYWRpdXM6MjJweDtwYWRkaW5nOjIycHg7Ym94LXNoYWRvdzowIDMwcHggOTBweCByZ2JhKDAsMCwwLC41NSl9Lm1vZGFsLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxOHB4fS5tb2RhbC1oZWFkIGgye21hcmdpbjoycHggMCAwfS5mb3JtLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0uZGVyaXZlZC1wcmV2aWV3e21hcmdpbjoxNHB4IDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTJweCAxNHB4O2ZvbnQtd2VpZ2h0OjgwMH0uZGVyaXZlZC1wcmV2aWV3LmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zNSk7Y29sb3I6I2ZmYWFhOX0uZGV0YWlscy1jYXJke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbjoxMnB4IDA7YmFja2dyb3VuZDojMDgxNzI1fS5kZXRhaWxzLWNhcmQgc3VtbWFyeXtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjEycHggMTRweDtjb2xvcjojYzdkNWRmO2ZvbnQtd2VpZ2h0OjcwMH0uZGV0YWlscy1jYXJkIC5kZXRhaWwtZ3JpZHtwYWRkaW5nOjAgMTRweCAxNHB4fS52YWxpZGF0aW9uLXRleHR7bWluLWhlaWdodDoxLjJlbTtjb2xvcjojZmZhYWE5O2ZvbnQtc2l6ZToxMnB4fS5tb2RhbC1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OXB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjE2cHh9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntmbGV4OjF9Ci50b2FzdHtwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjE1MDtsZWZ0OjUwJTtib3R0b206MTAwcHg7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7YmFja2dyb3VuZDojMTkzNjRkO2NvbG9yOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIwMCwyMjAsMjM2LC4xNik7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTFweCAxNXB4O2JveC1zaGFkb3c6MCAxNnB4IDUwcHggcmdiYSgwLDAsMCwuNCk7bWF4LXdpZHRoOm1pbig5MHZ3LDU2MHB4KTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpey5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9LnJlY29yZC1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxNTBweCwxLjJmcikgcmVwZWF0KDIsbWlubWF4KDk1cHgsLjhmcikpIGF1dG99LnJlY29yZC1yb3cgLnJlY29yZC12YWx1ZTpudGgtb2YtdHlwZSg0KSwucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVlOm50aC1vZi10eXBlKDUpe2Rpc3BsYXk6bm9uZX0ub3N0cm9tLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnByaWNlLWNhcmQuY3VycmVudHtncmlkLWNvbHVtbjoxLy0xfS5jb21wYWN0LW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfX0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmFwcC1zaGVsbHtwYWRkaW5nOjAgMTJweCAxMDRweH0udG9wYmFye3BhZGRpbmctbGVmdDo0cHg7cGFkZGluZy1yaWdodDo0cHh9LmJyYW5ke2ZvbnQtc2l6ZToyMXB4fS5icmFuZC1tYXJre3dpZHRoOjMzcHg7aGVpZ2h0OjMzcHh9LnN1YnRpdGxle21hcmdpbi1sZWZ0OjQzcHh9LnBhZ2UtaGVhZHthbGlnbi1pdGVtczpzdHJldGNoO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjttYXJnaW4tdG9wOjlweH0ucGFnZS1oZWFkIC5wcmltYXJ5e3dpZHRoOjEwMCV9LnBhZ2UtaGVhZCBoMXtmb250LXNpemU6MzFweH0ucGFuZWx7cGFkZGluZzoxNnB4O2JvcmRlci1yYWRpdXM6MTdweDttYXJnaW4tYm90dG9tOjEzcHh9LnBhbmVsLWhlYWR7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5wYW5lbC1oZWFkIGgye2ZvbnQtc2l6ZToxOHB4fS5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsbWlubWF4KDAsMWZyKSk7Z2FwOjlweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtwYWRkaW5nOjEzcHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZToyMHB4fS5vc3Ryb20tZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5wcmljZS1jYXJkLmN1cnJlbnR7Z3JpZC1jb2x1bW46YXV0b30ucHJpY2UtY2FyZHtwYWRkaW5nOjE1cHh9LnByaWNlLWNhcmQgc3Ryb25ne2ZvbnQtc2l6ZToyNHB4fS5jaGFydC13cmFwLC5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjIyNXB4fS5jaGFydC13cmFwLmxhcmdle2hlaWdodDoyNzBweH0ucmVjb3JkLXRvb2xiYXJ7YWxpZ24taXRlbXM6c3RyZXRjaH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0e21heC13aWR0aDoxNDVweH0ucmVjb3JkLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjlweH0ucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVle2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9LnJlY29yZC1yb3cgLmVkaXQtcmVjb3Jke2dyaWQtY29sdW1uOjI7Z3JpZC1yb3c6MX0ucmVjb3JkLW1vbnRoIHNtYWxse21heC13aWR0aDoyMzBweH0uZmlsdGVyLXBhbmVse2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtwYWRkaW5nOjE0cHh9LmZpbHRlci1wYW5lbCBsYWJlbHttaW4td2lkdGg6MH0uc2V0dGluZ3MtZ3JpZCwuZm9ybS1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmRldGFpbHMtY2FyZCAuZGV0YWlsLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uYWN0aW9uLXJvdz4qe2ZsZXg6MSAxIDE1MHB4fS5ib3R0b20tbmF2e3dpZHRoOmNhbGMoMTAwJSAtIDE2cHgpO2JvdHRvbTptYXgoOHB4LGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7Ym9yZGVyLXJhZGl1czoxN3B4fS5ib3R0b20tbmF2IGJ1dHRvbntmb250LXNpemU6MTBweDtwYWRkaW5nOjhweCAzcHh9LmJvdHRvbS1uYXYgYnV0dG9uIHNwYW57Zm9udC1zaXplOjE4cHh9Lm1vZGFse3BhZGRpbmc6OHB4fS5tb2RhbC1jYXJke3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE4cHg7bWF4LWhlaWdodDpjYWxjKDEwMHZoIC0gMTZweCl9Lm1vZGFsLWFjdGlvbnN7ZmxleC13cmFwOndyYXB9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntkaXNwbGF5Om5vbmV9Lm1vZGFsLWFjdGlvbnMgYnV0dG9ue2ZsZXg6MSAxIDEyMHB4fS5iYW5uZXJ7YWxpZ24taXRlbXM6c3RyZXRjaDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59LmJhbm5lciBidXR0b257YWxpZ24tc2VsZjpmbGV4LXN0YXJ0fX0KQG1lZGlhKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsqe3Njcm9sbC1iZWhhdmlvcjphdXRvIWltcG9ydGFudDthbmltYXRpb246bm9uZSFpbXBvcnRhbnQ7dHJhbnNpdGlvbjpub25lIWltcG9ydGFudH19CgovKiBFbGRlaG9mIDYuMC4xIOKAkyBsb2thbGVyIG15VkFJTExBTlQtSW1wb3J0ICovCiN2YWlsbGFudEltcG9ydFBhbmVsIC5hY3Rpb24tcm93e21hcmdpbi10b3A6MTRweH0KI3ZhaWxsYW50SW1wb3J0U3RhdHVzLm9re2NvbG9yOiNhNWU2OWF9CiN2YWlsbGFudEltcG9ydFN0YXR1cy5lcnJvcntjb2xvcjojZmZhYWE5fQoKLyogRWxkZWhvZiA2LjEuMCDigJMgWsOkaGxlcnN0w6RuZGUgYWxzIGVpbnppZ2UgbWFudWVsbGUgVmVyYnJhdWNoc2VpbmdhYmUgKi8KLnJlY29yZC1zdGF0dXMtYmFkZ2V7anVzdGlmeS1zZWxmOmVuZDtmb250LXNpemU6MTFweDtjb2xvcjojOWRiMGMwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzo2cHggOHB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDojMDgxNzI1fQoubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfQoubWV0ZXItaGlzdG9yeXtkaXNwbGF5OmdyaWQ7Z2FwOjdweDttYXJnaW46MTRweCAwfS5tZXRlci1oaXN0b3J5LXJvd3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxMDBweCwxZnIpIHJlcGVhdCgyLG1pbm1heCgxMTBweCwxZnIpKSBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjEwcHggMTJweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiMwODE3MjU7Zm9udC1zaXplOjEycHh9Lm1ldGVyLWhpc3Rvcnktcm93IHNwYW4sLm1ldGVyLWhpc3Rvcnktcm93IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0ubWV0ZXItaGlzdG9yeS1yb3cgc3Ryb25ne2ZvbnQtc2l6ZToxMnB4fS5tZXRlci1hY3Rpb25ze21hcmdpbi10b3A6MTJweH0ubWV0ZXItcHJldmlvdXN7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1O2NvbG9yOiNiOWM3ZDI7bGluZS1oZWlnaHQ6MS41fS5jb21wYWN0LW5vdGV7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfS5tZXRlci1sYXRlc3QubWV0cmljLWdyaWQgYXJ0aWNsZTpmaXJzdC1jaGlsZHtncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0ubWV0ZXItaGlzdG9yeS1yb3cgc3BhbntncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvdyBzbWFsbHtkaXNwbGF5Om5vbmV9LnJlY29yZC1zdGF0dXMtYmFkZ2V7Zm9udC1zaXplOjEwcHh9fQoKLyogRWxkZWhvZiA2LjEuMSDigJMgTW9uYXRzd2VydGUgd2llZGVyIGJlYXJiZWl0YmFyICovCi5maWVsZCBpbnB1dFtyZWFkb25seV17b3BhY2l0eTouNzI7Y3Vyc29yOmRlZmF1bHQ7YmFja2dyb3VuZDojMGIxNzIyfS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kO3doaXRlLXNwYWNlOm5vd3JhcH0KCi8qIEVsZGVob2YgNi4yLjAgKi8KLmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e2Rpc3BsYXk6Z3JpZDtnYXA6NXB4O2ZsZXg6MTttaW4td2lkdGg6MjQwcHg7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDojMGIxYTJhfS5hbmFseXNpcy1hbGwteWVhcnMtaGludCBzdHJvbmd7Zm9udC1zaXplOjEzcHh9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50IHNwYW57Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2xpbmUtaGVpZ2h0OjEuNH0ueWVhci1jb21wYXJpc29uLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHggMTZweDttYXJnaW46LTRweCAwIDEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgc3BhbntkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2NvbG9yOiNiOGM2ZDI7Zm9udC1zaXplOjEycHh9LnllYXItY29tcGFyaXNvbi1sZWdlbmQgaXtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDoyOHB4O2hlaWdodDowO2JvcmRlci10b3A6M3B4IHNvbGlkIGN1cnJlbnRDb2xvcn0ueWVhci1jb21wYXJpc29uLWxlZ2VuZCAucGFzdCBpe2JvcmRlci10b3Atc3R5bGU6ZGFzaGVkfS5zeW5jLWJhZGdle2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGIxYTJhO2NvbG9yOnZhcigtLW11dGVkKTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6ODAwfS5zeW5jLWJhZGdlLm9re2NvbG9yOiNhNWU2OWE7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMyl9LnN5bmMtYmFkZ2UuYnVzeXtjb2xvcjojOWZkMGZmO2JvcmRlci1jb2xvcjpyZ2JhKDc3LDE1NiwyNTUsLjM1KX0uc3luYy1iYWRnZS5lcnJvcntjb2xvcjojZmZhYWE5O2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zKX0uc3luYy1tZXRyaWNzLm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfS5zeW5jLWpvaW4tYm94e21hcmdpbi10b3A6MTRweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nLXRvcDoxMnB4fS5zeW5jLWpvaW4tYm94IHN1bW1hcnl7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6I2RjZTlmMztmb250LXdlaWdodDo4MDB9LnN5bmMtcGFpci1yZXN1bHR7ZGlzcGxheTpncmlkO2dhcDo3cHg7bWFyZ2luLXRvcDoxNHB4O3BhZGRpbmc6MTRweDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzcsMTU2LDI1NSwuMjgpO2JhY2tncm91bmQ6IzBhMWQzMDtib3JkZXItcmFkaXVzOjE0cHh9LnN5bmMtcGFpci1yZXN1bHQgc3Bhbiwuc3luYy1wYWlyLXJlc3VsdCBzbWFsbHtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjExcHh9LnN5bmMtcGFpci1yZXN1bHQgY29kZXtkaXNwbGF5OmJsb2NrO3dvcmQtYnJlYWs6YnJlYWstYWxsO2NvbG9yOiNkYmVlZmY7YmFja2dyb3VuZDojMDcxNDIxO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6OHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH1AbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsuZmlsdGVyLXBhbmVse2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmFuYWx5c2lzLWFsbC15ZWFycy1oaW50e21pbi13aWR0aDowfS5zeW5jLW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnN5bmMtbWV0cmljcy5tZXRyaWMtZ3JpZCBhcnRpY2xlOmxhc3QtY2hpbGR7Z3JpZC1jb2x1bW46MS8tMX19CgoucHJpY2UtcnVubmluZ3tkaXNwbGF5OmlubGluZS1ibG9jazttYXJnaW4tbGVmdDo1cHg7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDpyZ2JhKDc3LDE1NiwyNTUsLjEyKTtjb2xvcjojOWZkMGZmO2ZvbnQtc2l6ZTo5cHg7Zm9udC13ZWlnaHQ6ODAwO3ZlcnRpY2FsLWFsaWduOm1pZGRsZX0ucHJpY2Utc3RhdHMtbm90ZXtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9Cg==","type":"text/css; charset=utf-8","cache":"no-cache"},"/app.js":{"body":"KCgpID0+IHsKICAidXNlIHN0cmljdCI7CgogIGNvbnN0IEFQUF9CVUlMRCA9ICI2LjIuMS1PU1RST00tUFJFSVNTVEFUSVNUSUstMjAyNjEwMDUiOwogIGNvbnN0IERBVEFfS0VZID0gImVsZGVob2YtdjMtcmVjb3JkcyI7CiAgY29uc3QgU0VUVElOR1NfS0VZID0gImVsZGVob2YtdjMtc2V0dGluZ3MiOwogIGNvbnN0IFZBSUxMQU5UX01PTlRIU19LRVkgPSAiZWxkZWhvZi12My12YWlsbGFudC1tb250aHMtdjM4MCI7CiAgY29uc3QgT1NUUk9NX0NBQ0hFX0tFWSA9ICJlbGRlaG9mLXYzLW9zdHJvbS1saXZlLWNhY2hlIjsKICBjb25zdCBPU1RST01fQ09OVFJPTF9LRVkgPSAiZWxkZWhvZi12NS1vc3Ryb20tY29udHJvbC12NTQxIjsKICBjb25zdCBTSEFET1dfS0VZID0gImVsZGVob2YtdjYtcmVjb3Jkcy1zaGFkb3ciOwogIGNvbnN0IFNIQURPV19NRVRBX0tFWSA9ICJlbGRlaG9mLXY2LXJlY29yZHMtc2hhZG93LW1ldGEiOwogIGNvbnN0IExBU1RfQkFDS1VQX0tFWSA9ICJlbGRlaG9mLXY2LWxhc3QtYmFja3VwLWF0IjsKICBjb25zdCBNRVRFUl9LRVkgPSAiZWxkZWhvZi12Ni1tZXRlci1yZWFkaW5ncy12NjEwIjsKICBjb25zdCBNRVRFUl9NRVRBX0tFWSA9ICJlbGRlaG9mLXY2LW1ldGVyLXJlYWRpbmdzLXVwZGF0ZWQtdjYyMCI7CiAgY29uc3QgSElTVE9SWV9TRUVEX0tFWSA9ICJlbGRlaG9mLXY2LWhpc3Rvcnktc2VlZC12NjEwIjsKICBjb25zdCBTWU5DX1NUQVRFX0tFWSA9ICJlbGRlaG9mLXY2LXN5bmMtc3RhdGUtdjYyMCI7CiAgY29uc3QgU1lOQ19TRUNSRVRfTEVHQUNZX0tFWSA9ICJlbGRlaG9mLXY2LXN5bmMtc2VjcmV0LXY2MjAiOwogIGNvbnN0IFNZTkNfUEFZTE9BRF9TQ0hFTUEgPSAiZWxkZWhvZi1zeW5jLXBheWxvYWQtdjYyMCI7CiAgY29uc3QgU1lOQ19FTlZFTE9QRV9TQ0hFTUEgPSAiZWxkZWhvZi1lbmNyeXB0ZWQtc3luYy12MSI7CiAgY29uc3QgT1NUUk9NX0hJU1RPUllfS0VZID0gImVsZGVob2YtdjYtb3N0cm9tLWhpc3Rvcnktc3RhdHVzLXY2MjAiOwogIGNvbnN0IE9TVFJPTV9QUklDRV9TVEFUU19LRVkgPSAiZWxkZWhvZi12Ni1vc3Ryb20tcHJpY2Utc3RhdHMtdjYyMSI7CiAgY29uc3QgTU9OVEhTID0gWyJKYW4iLCJGZWIiLCJNw6RyIiwiQXByIiwiTWFpIiwiSnVuIiwiSnVsIiwiQXVnIiwiU2VwIiwiT2t0IiwiTm92IiwiRGV6Il07CiAgY29uc3QgQ09MT1JTID0geyB0b3RhbDoiIzcyZGM1NyIsIGhlYXQ6IiNmZjlmNDMiLCBhbm5leDoiIzRkOWNmZiIsIHJlc3Q6IiNmMmQxNWYiLCBjb21wYXJlOiIjOWM3ZGZmIiwgY29zdDoiIzVmYzdjMiIsIGdyaWQ6InJnYmEoMTcxLDE5OCwyMjAsLjE0KSIsIHRleHQ6IiM5NGE4YmEiIH07CiAgY29uc3QgWUVBUl9DT0xPUlMgPSBbIiM3MmRjNTciLCIjNGQ5Y2ZmIiwiIzljN2RmZiIsIiNmZjlmNDMiLCIjZjJkMTVmIiwiIzVmYzdjMiIsIiNmZjdiOGEiXTsKICBjb25zdCBISVNUT1JJQ0FMX1NFRUQgPSB7ImhlYXRQdW1wIjp7IjIwMjMtMTIiOjE1NTAsIjIwMjQtMDEiOjE5ODAsIjIwMjQtMDIiOjExMTMsIjIwMjQtMDMiOjkwNywiMjAyNC0wNCI6NTM1LCIyMDI0LTA1IjoxNTYsIjIwMjQtMDYiOjExMCwiMjAyNC0wNyI6MTEwLCIyMDI0LTA4IjoxMDgsIjIwMjQtMDkiOjE5OCwiMjAyNC0xMCI6NDkwLCIyMDI0LTExIjoxMDAzLCIyMDI0LTEyIjoxMzA1LCIyMDI1LTAxIjoxNjk0LCIyMDI1LTAyIjoxNDc4LCIyMDI1LTAzIjoxMDA1LCIyMDI1LTA0Ijo0OTgsIjIwMjUtMDUiOjM2NywiMjAyNS0wNiI6MTM3LCIyMDI1LTA3IjoxMDYsIjIwMjUtMDgiOjEyOCwiMjAyNS0wOSI6MTg1LCIyMDI1LTEwIjo2MDcsIjIwMjUtMTEiOjEwNDAsIjIwMjUtMTIiOjEyNjUsIjIwMjYtMDEiOjE4NTUsIjIwMjYtMDIiOjE0ODgsIjIwMjYtMDMiOjg5NSwiMjAyNi0wNCI6NjU2LCIyMDI2LTA1IjozMDAsIjIwMjYtMDYiOjEyNiwiMjAyNi0wNyI6MTI4LCIyMDI2LTA4IjoxMjEsIjIwMjYtMDkiOjEzN30sImFubmV4Ijp7IjIwMjQtMDEiOjIxMCwiMjAyNC0wMiI6MjEwLCIyMDI0LTAzIjoyMTksIjIwMjQtMDQiOjIwMCwiMjAyNC0wNSI6MjIyLCIyMDI0LTA2IjoxNjQsIjIwMjQtMDciOjIxOSwiMjAyNC0wOCI6MjAxLCIyMDI0LTA5IjoxOTIsIjIwMjQtMTAiOjIzNywiMjAyNC0xMSI6MjI3LCIyMDI0LTEyIjoyNjYsIjIwMjUtMDEiOjI2MSwiMjAyNS0wMiI6MjM1LCIyMDI1LTAzIjoyMjEsIjIwMjUtMDQiOjIzOCwiMjAyNS0wNSI6MjIxLCIyMDI1LTA2IjoyMzcsIjIwMjUtMDciOjI0MCwiMjAyNS0wOCI6MjMyLCIyMDI1LTA5IjozMDgsIjIwMjUtMTAiOjIyMCwiMjAyNS0xMSI6MjM3LCIyMDI1LTEyIjoyNzMsIjIwMjYtMDEiOjI0MCwiMjAyNi0wMiI6MjI1LCIyMDI2LTAzIjoyNzAsIjIwMjYtMDQiOjIxNSwiMjAyNi0wNSI6MjIwLCIyMDI2LTA2IjoyNTAsIjIwMjYtMDciOjIxMCwiMjAyNi0wOCI6MjQwLCIyMDI2LTA5IjoyNjV9LCJ0b3RhbCI6eyIyMDI0LTAxIjoyNDUwLCIyMDI0LTAyIjoxNjE1LCIyMDI0LTAzIjoxMzIwLCIyMDI0LTA0Ijo5MzMsIjIwMjQtMDUiOjczMSwiMjAyNC0wNiI6NTg3LCIyMDI0LTA3Ijo2MjAsIjIwMjQtMDgiOjU0MCwiMjAyNC0wOSI6NjEyLCIyMDI0LTEwIjoxMDE5LCIyMDI0LTExIjoxNTIxLCIyMDI0LTEyIjoxODU3LCIyMDI1LTAxIjoyMjgyLCIyMDI1LTAyIjoyMDIzLCIyMDI1LTAzIjoxNDE0LCIyMDI1LTA0Ijo5NjAsIjIwMjUtMDUiOjkzMywiMjAyNS0wNiI6NzUxLCIyMDI1LTA3Ijo2ODAsIjIwMjUtMDgiOjY3NiwiMjAyNS0wOSI6ODE0LCIyMDI1LTEwIjoxMTA1LCIyMDI1LTExIjoxNjE1LCIyMDI1LTEyIjoxODUwLCIyMDI2LTAxIjoyNDUwLCIyMDI2LTAyIjoyMDYwLCIyMDI2LTAzIjoxNTk3LCIyMDI2LTA0IjoxMDUxLCIyMDI2LTA1Ijo3NjcsIjIwMjYtMDYiOjY2MiwiMjAyNi0wNyI6NjA4LCIyMDI2LTA4Ijo2ODUsIjIwMjYtMDkiOjY1NX19OwogIGNvbnN0IEJBU0VMSU5FX01FVEVSX1JFQURJTkcgPSB7ZGF0ZToiMjAyNi0xMC0wMSIsdG90YWw6MzQyNTUsYW5uZXg6OTA0NSxub3RlOiJTdGFydHdlcnQgZsO8ciBkaWUgYXV0b21hdGlzY2hlIEJlcmVjaG51bmcgYWIgT2t0b2JlciAyMDI2In07CiAgY29uc3QgJCA9IGlkID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKCiAgbGV0IHNldHRpbmdzID0gbG9hZFNldHRpbmdzKCk7CiAgbGV0IHJlY29yZHMgPSBsb2FkUmVjb3JkcygpOwogIGxldCB2YWlsbGFudE1vbnRocyA9IGxvYWRWYWlsbGFudE1vbnRocygpOwogIGxldCBvc3Ryb21MaXZlID0gbG9hZE9zdHJvbUNhY2hlKCk7CiAgbGV0IG9zdHJvbUJ1c3kgPSBmYWxzZTsKICBsZXQgb3N0cm9tVGltZXIgPSBudWxsOwogIGxldCB0b2FzdFRpbWVyID0gbnVsbDsKICBsZXQgcmVzaXplVGltZXIgPSBudWxsOwogIGxldCBjdXJyZW50VmlldyA9ICJkYXNoYm9hcmRWaWV3IjsKICBsZXQgbWV0ZXJSZWFkaW5ncyA9IGxvYWRNZXRlclJlYWRpbmdzKCk7CiAgbGV0IHN5bmNTdGF0ZSA9IGxvYWRTeW5jU3RhdGUoKTsKICBsZXQgc3luY0J1c3kgPSBmYWxzZTsKICBsZXQgc3luY0FwcGx5aW5nID0gZmFsc2U7CiAgbGV0IHN5bmNEZWJvdW5jZVRpbWVyID0gbnVsbDsKICBsZXQgc3luY1BvbGxUaW1lciA9IG51bGw7CiAgbGV0IG9zdHJvbUhpc3RvcnlCdXN5ID0gZmFsc2U7CiAgbGV0IG9zdHJvbVByaWNlU3RhdHMgPSBsb2FkT3N0cm9tUHJpY2VTdGF0cygpOwogIGxldCBvc3Ryb21QcmljZVN0YXRzQnVzeSA9IGZhbHNlOwoKICBmdW5jdGlvbiBzYWZlSnNvblBhcnNlKHZhbHVlLCBmYWxsYmFjaz1udWxsKXsgdHJ5e3JldHVybiBKU09OLnBhcnNlKHZhbHVlKTt9Y2F0Y2h7cmV0dXJuIGZhbGxiYWNrO30gfQogIGZ1bmN0aW9uIG51bGxhYmxlTnVtYmVyKHZhbHVlKXsgaWYodmFsdWU9PT0iInx8dmFsdWU9PT1udWxsfHx2YWx1ZT09PXVuZGVmaW5lZClyZXR1cm4gbnVsbDsgY29uc3Qgbj1OdW1iZXIodmFsdWUpOyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pP246bnVsbDsgfQogIGZ1bmN0aW9uIHNvcnRlZChpdGVtcz1yZWNvcmRzKXsgcmV0dXJuIFsuLi5pdGVtc10uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsgfQogIGZ1bmN0aW9uIGN1cnJlbnRNb250aEtleSgpeyBjb25zdCBkPW5ldyBEYXRlKCk7IHJldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9YDsgfQogIGZ1bmN0aW9uIG1vbnRoTGFiZWwobW9udGgsbG9uZz10cnVlKXsgY29uc3QgW3ksbV09U3RyaW5nKG1vbnRoKS5zcGxpdCgiLSIpLm1hcChOdW1iZXIpOyBpZigheXx8IW0pcmV0dXJuIG1vbnRoOyByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIixsb25nP3ttb250aDoibG9uZyIseWVhcjoibnVtZXJpYyJ9Onttb250aDoic2hvcnQiLHllYXI6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHksbS0xLDEpKTsgfQogIGZ1bmN0aW9uIG51bSh2YWx1ZSxkaWdpdHM9MCl7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHZhbHVlKSk/bmV3IEludGwuTnVtYmVyRm9ybWF0KCJkZS1ERSIse21pbmltdW1GcmFjdGlvbkRpZ2l0czpkaWdpdHMsbWF4aW11bUZyYWN0aW9uRGlnaXRzOmRpZ2l0c30pLmZvcm1hdChOdW1iZXIodmFsdWUpKToi4oCTIjsgfQogIGZ1bmN0aW9uIGV1cm8odmFsdWUpeyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcih2YWx1ZSkpP25ldyBJbnRsLk51bWJlckZvcm1hdCgiZGUtREUiLHtzdHlsZToiY3VycmVuY3kiLGN1cnJlbmN5OiJFVVIifSkuZm9ybWF0KE51bWJlcih2YWx1ZSkpOiLigJMiOyB9CiAgZnVuY3Rpb24gcGN0KHZhbHVlKXsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIodmFsdWUpKT9gJHt2YWx1ZT4wPyIrIjoiIn0ke251bSh2YWx1ZSwxKX0gJWA6IuKAkyI7IH0KICBmdW5jdGlvbiBlc2NhcGVIdG1sKHZhbHVlKXsgcmV0dXJuIFN0cmluZyh2YWx1ZT8/IiIpLnJlcGxhY2UoL1smPD4iJ10vZyxjaD0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsIlwiIjoiJnF1b3Q7IiwiJyI6IiYjMzk7In1bY2hdKSk7IH0KICBmdW5jdGlvbiBjc3ZDZWxsKHZhbHVlKXsgY29uc3Qgcz1TdHJpbmcodmFsdWU/PyIiKTsgcmV0dXJuIGAiJHtzLnJlcGxhY2UoLyIvZywnIiInKX0iYDsgfQogIGZ1bmN0aW9uIGRhdGVTdGFtcCgpeyBjb25zdCBkPW5ldyBEYXRlKCk7IHJldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKGQuZ2V0RGF0ZSgpKS5wYWRTdGFydCgyLCIwIil9YDsgfQoKICBmdW5jdGlvbiBzYW5pdGl6ZVJlY29yZChyYXcpewogICAgY29uc3QgbW9udGg9U3RyaW5nKHJhdz8ubW9udGh8fCIiKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChtb250aCkpcmV0dXJuIG51bGw7CiAgICByZXR1cm4gewogICAgICBtb250aCwKICAgICAgaGVhdFB1bXA6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRQdW1wKSwKICAgICAgYW5uZXg6bnVsbGFibGVOdW1iZXIocmF3LmFubmV4KSwKICAgICAgdG90YWw6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsKSwKICAgICAgcHJpY2VDdDpudWxsYWJsZU51bWJlcihyYXcucHJpY2VDdCA/PyByYXcuYXZlcmFnZVByaWNlQ3QpLAogICAgICBiYXNlRmVlOm51bGxhYmxlTnVtYmVyKHJhdy5iYXNlRmVlKSwKICAgICAgbm90ZTpTdHJpbmcocmF3Lm5vdGV8fCIiKS50cmltKCkuc2xpY2UoMCw4MDApLAogICAgICBoZWF0R2VuZXJhdGVkOm51bGxhYmxlTnVtYmVyKHJhdy5oZWF0R2VuZXJhdGVkKSwKICAgICAgaGVhdGluZ0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKHJhdy5oZWF0aW5nRWxlY3RyaWNpdHkpLAogICAgICBkaHdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcihyYXcuZGh3RWxlY3RyaWNpdHkpLAogICAgICBoZWF0aW5nSGVhdDpudWxsYWJsZU51bWJlcihyYXcuaGVhdGluZ0hlYXQpLAogICAgICBkaHdIZWF0Om51bGxhYmxlTnVtYmVyKHJhdy5kaHdIZWF0KSwKICAgICAgaGVhdFB1bXBTb3VyY2U6U3RyaW5nKHJhdy5oZWF0UHVtcFNvdXJjZXx8IiIpLnNsaWNlKDAsNjApLAogICAgICBoZWF0UHVtcFVwZGF0ZWRBdDpyYXcuaGVhdFB1bXBVcGRhdGVkQXQ/U3RyaW5nKHJhdy5oZWF0UHVtcFVwZGF0ZWRBdCk6bnVsbCwKICAgICAgbWV0ZXJSZWFkaW5nRGF0ZTpyYXcubWV0ZXJSZWFkaW5nRGF0ZT9TdHJpbmcocmF3Lm1ldGVyUmVhZGluZ0RhdGUpOm51bGwsCiAgICAgIHByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZTpyYXcucHJldmlvdXNNZXRlclJlYWRpbmdEYXRlP1N0cmluZyhyYXcucHJldmlvdXNNZXRlclJlYWRpbmdEYXRlKTpudWxsLAogICAgICB0b3RhbE1ldGVyUmVhZGluZzpudWxsYWJsZU51bWJlcihyYXcudG90YWxNZXRlclJlYWRpbmcpLAogICAgICBhbm5leE1ldGVyUmVhZGluZzpudWxsYWJsZU51bWJlcihyYXcuYW5uZXhNZXRlclJlYWRpbmcpLAogICAgICBtZXRlclNvdXJjZTpTdHJpbmcocmF3Lm1ldGVyU291cmNlfHwiIikuc2xpY2UoMCw2MCksCiAgICAgIHByaWNlU291cmNlOlN0cmluZyhyYXcucHJpY2VTb3VyY2V8fCIiKS5zbGljZSgwLDgwKSwKICAgICAgcHJpY2VVcGRhdGVkQXQ6cmF3LnByaWNlVXBkYXRlZEF0P1N0cmluZyhyYXcucHJpY2VVcGRhdGVkQXQpOm51bGwsCiAgICAgIG9zdHJvbVZhcmlhYmxlQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tVmFyaWFibGVDb3N0RXVyKSwKICAgICAgb3N0cm9tVG90YWxDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy5vc3Ryb21Ub3RhbENvc3RFdXIpLAogICAgICBvc3Ryb21Db25zdW1wdGlvbktXaDpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tQ29uc3VtcHRpb25LV2gpLAogICAgICBvc3Ryb21QcmljZUNvbXBsZXRlOkJvb2xlYW4ocmF3Lm9zdHJvbVByaWNlQ29tcGxldGUpLAogICAgICB1cGRhdGVkQXQ6cmF3LnVwZGF0ZWRBdD9TdHJpbmcocmF3LnVwZGF0ZWRBdCk6bnVsbCwKICAgICAgY2xvc2VkOkJvb2xlYW4ocmF3LmNsb3NlZCksCiAgICAgIGNsb3NlZEF0OnJhdy5jbG9zZWRBdD9TdHJpbmcocmF3LmNsb3NlZEF0KTpudWxsCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZVJlY29yZHMoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10peyBjb25zdCByPXNhbml0aXplUmVjb3JkKHJhdyk7IGlmKHIpbWFwLnNldChyLm1vbnRoLHIpOyB9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gZGVyaXZlZChyKXsgaWYoIVtyPy5oZWF0UHVtcCxyPy5hbm5leCxyPy50b3RhbF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSlyZXR1cm4gbnVsbDsgcmV0dXJuIHIudG90YWwtci5oZWF0UHVtcC1yLmFubmV4OyB9CiAgZnVuY3Rpb24gY29tcGxldGUocil7IGNvbnN0IHJlc3Q9ZGVyaXZlZChyKTsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdD49MDsgfQogIGZ1bmN0aW9uIHJlY29yZENvc3Qocil7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUocj8ub3N0cm9tVG90YWxDb3N0RXVyKSYmcj8ub3N0cm9tUHJpY2VDb21wbGV0ZSlyZXR1cm4gTnVtYmVyKHIub3N0cm9tVG90YWxDb3N0RXVyKTsKICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUocj8udG90YWwpKXJldHVybiBudWxsOwogICAgY29uc3QgcHJpY2U9TnVtYmVyLmlzRmluaXRlKHIucHJpY2VDdCk/ci5wcmljZUN0LzEwMDpOdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMik7CiAgICBjb25zdCBiYXNlPU51bWJlci5pc0Zpbml0ZShyLmJhc2VGZWUpP3IuYmFzZUZlZTpOdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApOwogICAgcmV0dXJuIHIudG90YWwqcHJpY2UrYmFzZTsKICB9CiAgZnVuY3Rpb24gcmVjb3JkQ29wKHIpeyByZXR1cm4gTnVtYmVyKHI/LmhlYXRQdW1wKT4wJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHI/LmhlYXRHZW5lcmF0ZWQpKT9OdW1iZXIoci5oZWF0R2VuZXJhdGVkKS9OdW1iZXIoci5oZWF0UHVtcCk6bnVsbDsgfQoKICBmdW5jdGlvbiByYXdTZXR0aW5ncygpeyBjb25zdCB2PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU0VUVElOR1NfS0VZKSx7fSk7IHJldHVybiB2JiZ0eXBlb2Ygdj09PSJvYmplY3QiJiYhQXJyYXkuaXNBcnJheSh2KT92Ont9OyB9CiAgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCl7CiAgICBjb25zdCByYXc9cmF3U2V0dGluZ3MoKTsKICAgIHJldHVybiB7CiAgICAgIC4uLnJhdywKICAgICAgZmFsbGJhY2tQcmljZTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5mYWxsYmFja1ByaWNlKSk/TnVtYmVyKHJhdy5mYWxsYmFja1ByaWNlKTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5wcmljZSkpP051bWJlcihyYXcucHJpY2UpOjAuMzIsCiAgICAgIGRlZmF1bHRCYXNlRmVlOk51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3LmRlZmF1bHRCYXNlRmVlKSk/TnVtYmVyKHJhdy5kZWZhdWx0QmFzZUZlZSk6MCwKICAgICAgb3N0cm9tQXBwS2V5OlN0cmluZyhyYXcub3N0cm9tQXBwS2V5fHwiIiksCiAgICAgIG9zdHJvbUF1dG9SZWZyZXNoOnJhdy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlLAogICAgICBwcmVmZXJyZWRXaW5kb3dIb3VyczpbMSwyLDMsNF0uaW5jbHVkZXMoTnVtYmVyKHJhdy5wcmVmZXJyZWRXaW5kb3dIb3VycykpP051bWJlcihyYXcucHJlZmVycmVkV2luZG93SG91cnMpOjMKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncygpewogICAgY29uc3QgcHJldmlvdXM9cmF3U2V0dGluZ3MoKTsKICAgIGNvbnN0IG1lcmdlZD17Li4ucHJldmlvdXMsCiAgICAgIGZhbGxiYWNrUHJpY2U6TnVtYmVyKHNldHRpbmdzLmZhbGxiYWNrUHJpY2UpfHwwLAogICAgICBkZWZhdWx0QmFzZUZlZTpOdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWUpfHwwLAogICAgICBvc3Ryb21BcHBLZXk6U3RyaW5nKHNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiIpLAogICAgICBvc3Ryb21BdXRvUmVmcmVzaDpzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlLAogICAgICBwcmVmZXJyZWRXaW5kb3dIb3VyczpbMSwyLDMsNF0uaW5jbHVkZXMoTnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKSk/TnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKTozCiAgICB9OwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0VUVElOR1NfS0VZLEpTT04uc3RyaW5naWZ5KG1lcmdlZCkpOwogICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLm1lcmdlZH07CiAgfQoKICBmdW5jdGlvbiByZWFkUHJpbWFyeVJlY29yZHMoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oREFUQV9LRVkpLG51bGwpOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3Nhbml0aXplUmVjb3JkcyhyYXcpOm51bGw7IH0KICBmdW5jdGlvbiByZWFkU2hhZG93UmVjb3JkcygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTSEFET1dfS0VZKSxudWxsKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9zYW5pdGl6ZVJlY29yZHMocmF3KTpbXTsgfQogIGZ1bmN0aW9uIGxvYWRSZWNvcmRzKCl7CiAgICBjb25zdCBwcmltYXJ5PXJlYWRQcmltYXJ5UmVjb3JkcygpOwogICAgaWYocHJpbWFyeSE9PW51bGwpcmV0dXJuIHByaW1hcnk7CiAgICBmb3IoY29uc3Qga2V5IG9mIFsiZWxkZWhvZi12MS1kYXRhIiwiZW5lcmhhdXMtdjEtZGF0YSJdKXsKICAgICAgY29uc3QgbGVnYWN5PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSxudWxsKTsKICAgICAgaWYoQXJyYXkuaXNBcnJheShsZWdhY3kpKXsKICAgICAgICBjb25zdCBtaWdyYXRlZD1zYW5pdGl6ZVJlY29yZHMobGVnYWN5KTsKICAgICAgICBpZihtaWdyYXRlZC5sZW5ndGgpbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkobWlncmF0ZWQpKTsKICAgICAgICByZXR1cm4gbWlncmF0ZWQ7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBbXTsKICB9CiAgZnVuY3Rpb24gc2F2ZVJlY29yZHMobmV4dCx7cmVhc29uPSLDhG5kZXJ1bmciLGFsbG93RW1wdHk9ZmFsc2V9PXt9KXsKICAgIGNvbnN0IGNsZWFuPXNhbml0aXplUmVjb3JkcyhuZXh0KTsKICAgIGNvbnN0IHByZXZpb3VzPXJlYWRQcmltYXJ5UmVjb3JkcygpfHxbXTsKICAgIGlmKCFhbGxvd0VtcHR5ICYmIHByZXZpb3VzLmxlbmd0aD4wICYmIGNsZWFuLmxlbmd0aD09PTApdGhyb3cgbmV3IEVycm9yKCJMZWVyZXIgTW9uYXRzYmVzdGFuZCB3aXJkIGF1cyBTaWNoZXJoZWl0c2dyw7xuZGVuIG5pY2h0IGF1dG9tYXRpc2NoIGdlc3BlaWNoZXJ0LiIpOwogICAgaWYocHJldmlvdXMubGVuZ3RoKXsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0hBRE9XX0tFWSxKU09OLnN0cmluZ2lmeShwcmV2aW91cykpOwogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTSEFET1dfTUVUQV9LRVksSlNPTi5zdHJpbmdpZnkoe3NhdmVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHJlYXNvbixyZWNvcmRzOnByZXZpb3VzLmxlbmd0aH0pKTsKICAgIH0KICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKERBVEFfS0VZLEpTT04uc3RyaW5naWZ5KGNsZWFuKSk7CiAgICByZWNvcmRzPWNsZWFuOwogICAgdXBkYXRlUmVjb3ZlcnlCYW5uZXIoKTsKICAgIGlmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoKTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVNZXRlclJlYWRpbmcocmF3KXsKICAgIGNvbnN0IGRhdGU9U3RyaW5nKHJhdz8uZGF0ZXx8IiIpOwogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIocmF3Py50b3RhbCksYW5uZXg9bnVsbGFibGVOdW1iZXIocmF3Py5hbm5leCk7CiAgICBpZighL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoZGF0ZSl8fCFOdW1iZXIuaXNGaW5pdGUodG90YWwpfHwhTnVtYmVyLmlzRmluaXRlKGFubmV4KXx8dG90YWw8MHx8YW5uZXg8MClyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7ZGF0ZSx0b3RhbCxhbm5leCxub3RlOlN0cmluZyhyYXc/Lm5vdGV8fCIiKS5zbGljZSgwLDE4MCksdXBkYXRlZEF0OnJhdz8udXBkYXRlZEF0P1N0cmluZyhyYXcudXBkYXRlZEF0KTpudWxsfTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVNZXRlclJlYWRpbmdzKGl0ZW1zKXsKICAgIGNvbnN0IG1hcD1uZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgcmF3IG9mIEFycmF5LmlzQXJyYXkoaXRlbXMpP2l0ZW1zOltdKXtjb25zdCByPXNhbml0aXplTWV0ZXJSZWFkaW5nKHJhdyk7aWYociltYXAuc2V0KHIuZGF0ZSxyKTt9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5kYXRlLmxvY2FsZUNvbXBhcmUoYi5kYXRlKSk7CiAgfQogIGZ1bmN0aW9uIGxvYWRNZXRlclJlYWRpbmdzKCl7cmV0dXJuIHNhbml0aXplTWV0ZXJSZWFkaW5ncyhzYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE1FVEVSX0tFWSksW10pKTt9CiAgZnVuY3Rpb24gc2F2ZU1ldGVyUmVhZGluZ3MobmV4dCx7dG91Y2g9dHJ1ZSx0aW1lc3RhbXA9bnVsbH09e30pe21ldGVyUmVhZGluZ3M9c2FuaXRpemVNZXRlclJlYWRpbmdzKG5leHQpO2xvY2FsU3RvcmFnZS5zZXRJdGVtKE1FVEVSX0tFWSxKU09OLnN0cmluZ2lmeShtZXRlclJlYWRpbmdzKSk7aWYodG91Y2gpbG9jYWxTdG9yYWdlLnNldEl0ZW0oTUVURVJfTUVUQV9LRVksdGltZXN0YW1wfHxuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO2lmKCFzeW5jQXBwbHlpbmcpc2NoZWR1bGVDbG91ZFN5bmMoKTt9CiAgZnVuY3Rpb24gbGF0ZXN0TWV0ZXJSZWFkaW5nKCl7cmV0dXJuIG1ldGVyUmVhZGluZ3MuYXQoLTEpfHxudWxsO30KICBmdW5jdGlvbiBkYXRlTGFiZWwodmFsdWUpe2NvbnN0IGQ9bmV3IERhdGUoYCR7dmFsdWV9VDEyOjAwOjAwYCk7cmV0dXJuIE51bWJlci5pc05hTihkLnZhbHVlT2YoKSk/dmFsdWU6bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7ZGF5OiIyLWRpZ2l0Iixtb250aDoiMi1kaWdpdCIseWVhcjoibnVtZXJpYyJ9KS5mb3JtYXQoZCk7fQogIGZ1bmN0aW9uIG5leHRNb250aEZpcnN0KGRhdGUpe2NvbnN0IFt5LG1dPVN0cmluZyhkYXRlKS5zcGxpdCgiLSIpLm1hcChOdW1iZXIpO2NvbnN0IGQ9bmV3IERhdGUoeSxtLDEpO3JldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9LTAxYDt9CiAgZnVuY3Rpb24gYXBwbHlIaXN0b3JpY2FsU2VlZCgpewogICAgaWYobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWV9TRUVEX0tFWSkpcmV0dXJuOwogICAgY29uc3QgbWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgY29uc3QgbW9udGhzPVsuLi5uZXcgU2V0KFsuLi5PYmplY3Qua2V5cyhISVNUT1JJQ0FMX1NFRUQudG90YWwpLC4uLk9iamVjdC5rZXlzKEhJU1RPUklDQUxfU0VFRC5hbm5leCksLi4uT2JqZWN0LmtleXMoSElTVE9SSUNBTF9TRUVELmhlYXRQdW1wKV0pXS5zb3J0KCk7CiAgICBmb3IoY29uc3QgbW9udGggb2YgbW9udGhzKXsKICAgICAgY29uc3Qgcj1tYXAuZ2V0KG1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRofSk7CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELnRvdGFsLG1vbnRoKSlyLnRvdGFsPUhJU1RPUklDQUxfU0VFRC50b3RhbFttb250aF07CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELmFubmV4LG1vbnRoKSlyLmFubmV4PUhJU1RPUklDQUxfU0VFRC5hbm5leFttb250aF07CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELmhlYXRQdW1wLG1vbnRoKSl7CiAgICAgICAgY29uc3Qgc2VlZD1ISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXBbbW9udGhdOwogICAgICAgIGNvbnN0IGtlZXBFeGlzdGluZz1OdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCkmJk1hdGguYWJzKHIuaGVhdFB1bXAtc2VlZCk8PTI7CiAgICAgICAgaWYoIWtlZXBFeGlzdGluZylyLmhlYXRQdW1wPXNlZWQ7CiAgICAgICAgaWYoIXIuaGVhdFB1bXBTb3VyY2Upci5oZWF0UHVtcFNvdXJjZT0iaGlzdG9yaWNhbC11c2VyLWRhdGEiOwogICAgICB9CiAgICAgIGlmKG1vbnRoPT09IjIwMjQtMDMiKXsKICAgICAgICBjb25zdCBub3RlPSJaw6RobGVyd2VjaHNlbCBHZXNhbXRzdHJvbSBhbSAwMS4wNC4yMDI0OiBhbHRlciBaw6RobGVyIDYyLjI5NiBrV2gsIG5ldWVyIFrDpGhsZXIgMTk3IGtXaDsgTW9uYXRzdmVyYnJhdWNoIGtvcnJla3QgbWl0IDEuMzIwIGtXaCBiZXLDvGNrc2ljaHRpZ3QuIjsKICAgICAgICBpZighU3RyaW5nKHIubm90ZXx8IiIpLmluY2x1ZGVzKCJaw6RobGVyd2VjaHNlbCBHZXNhbXRzdHJvbSIpKXIubm90ZT1yLm5vdGU/YCR7ci5ub3RlfSDigKIgJHtub3RlfWA6bm90ZTsKICAgICAgfQogICAgICBpZihtb250aD09PSIyMDIzLTEyIiYmIXIubm90ZSlyLm5vdGU9Ikhpc3RvcmlzY2ggaXN0IGbDvHIgRGV6ZW1iZXIgMjAyMyBudXIgZGVyIFfDpHJtZXB1bXBlbnZlcmJyYXVjaCBkb2t1bWVudGllcnQuIjsKICAgICAgbWFwLnNldChtb250aCxyKTsKICAgIH0KICAgIHNhdmVSZWNvcmRzKFsuLi5tYXAudmFsdWVzKCldLHtyZWFzb246Ikhpc3RvcmlzY2hlIFZlcmJyYXVjaHNkYXRlbiAyMDI04oCTMDkvMjAyNiDDvGJlcm5vbW1lbiJ9KTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUllfU0VFRF9LRVksbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTsKICB9CiAgZnVuY3Rpb24gZW5zdXJlTWV0ZXJCYXNlbGluZSgpewogICAgaWYobWV0ZXJSZWFkaW5ncy5zb21lKHI9PnIuZGF0ZT09PUJBU0VMSU5FX01FVEVSX1JFQURJTkcuZGF0ZSkpcmV0dXJuOwogICAgaWYobWV0ZXJSZWFkaW5ncy5sZW5ndGg9PT0wKXNhdmVNZXRlclJlYWRpbmdzKFtCQVNFTElORV9NRVRFUl9SRUFESU5HXSx7dG91Y2g6ZmFsc2V9KTsKICB9CiAgZnVuY3Rpb24gbG9hZFZhaWxsYW50TW9udGhzKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFZBSUxMQU5UX01PTlRIU19LRVkpLFtdKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9yYXc6W107IH0KICBmdW5jdGlvbiBzYXZlVmFpbGxhbnRNb250aHMoKXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oVkFJTExBTlRfTU9OVEhTX0tFWSxKU09OLnN0cmluZ2lmeShBcnJheS5pc0FycmF5KHZhaWxsYW50TW9udGhzKT92YWlsbGFudE1vbnRoczpbXSkpOyBpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKCk7IH0KICBmdW5jdGlvbiBsb2FkT3N0cm9tQ2FjaGUoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oT1NUUk9NX0NBQ0hFX0tFWSksbnVsbCk7IHJldHVybiByYXcmJnJhdy5nZW5lcmF0ZWRBdD9yYXc6bnVsbDsgfQogIGZ1bmN0aW9uIHNhdmVPc3Ryb21DYWNoZShwYXlsb2FkKXsgb3N0cm9tTGl2ZT1wYXlsb2FkfHxudWxsOyBpZihwYXlsb2FkKWxvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9DQUNIRV9LRVksSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpOyBlbHNlIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKE9TVFJPTV9DQUNIRV9LRVkpOyBpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKDE4MDApOyB9CiAgZnVuY3Rpb24gc2FuaXRpemVPc3Ryb21QcmljZVN0YXQocmF3KXsKICAgIGNvbnN0IG1vbnRoPVN0cmluZyhyYXc/Lm1vbnRofHwiIik7CiAgICBpZighL15cZHs0fS1cZHsyfSQvLnRlc3QobW9udGgpKXJldHVybiBudWxsOwogICAgcmV0dXJuIHsKICAgICAgbW9udGgsCiAgICAgIHdlaWdodGVkQXZlcmFnZUN0UGVyS1doOm51bGxhYmxlTnVtYmVyKHJhdy53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCA/PyByYXcucHJpY2VDdCksCiAgICAgIHRvdGFsS1doOm51bGxhYmxlTnVtYmVyKHJhdy50b3RhbEtXaCA/PyByYXcub3N0cm9tQ29uc3VtcHRpb25LV2gpLAogICAgICB2YXJpYWJsZUNvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3LnZhcmlhYmxlQ29zdEV1ciA/PyByYXcub3N0cm9tVmFyaWFibGVDb3N0RXVyKSwKICAgICAgZml4ZWRDb3N0RXVyOm51bGxhYmxlTnVtYmVyKHJhdy5maXhlZENvc3RFdXIgPz8gcmF3LmJhc2VGZWUpLAogICAgICB0b3RhbENvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsQ29zdEV1ciA/PyByYXcub3N0cm9tVG90YWxDb3N0RXVyKSwKICAgICAgY29tcGxldGU6Qm9vbGVhbihyYXcuY29tcGxldGUgPz8gcmF3Lm9zdHJvbVByaWNlQ29tcGxldGUpLAogICAgICBwYXJ0aWFsOkJvb2xlYW4ocmF3LnBhcnRpYWwpLAogICAgICB1cGRhdGVkQXQ6U3RyaW5nKHJhdy51cGRhdGVkQXR8fHJhdy5wcmljZVVwZGF0ZWRBdHx8IiIpCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZU9zdHJvbVByaWNlU3RhdHMoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pe2NvbnN0IGl0ZW09c2FuaXRpemVPc3Ryb21QcmljZVN0YXQocmF3KTtpZihpdGVtKW1hcC5zZXQoaXRlbS5tb250aCxpdGVtKTt9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gbG9hZE9zdHJvbVByaWNlU3RhdHMoKXsgcmV0dXJuIHNhbml0aXplT3N0cm9tUHJpY2VTdGF0cyhzYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE9TVFJPTV9QUklDRV9TVEFUU19LRVkpLFtdKSk7IH0KICBmdW5jdGlvbiBzYXZlT3N0cm9tUHJpY2VTdGF0cyhpdGVtcyl7IG9zdHJvbVByaWNlU3RhdHM9c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKGl0ZW1zKTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShPU1RST01fUFJJQ0VfU1RBVFNfS0VZLEpTT04uc3RyaW5naWZ5KG9zdHJvbVByaWNlU3RhdHMpKTtpZighc3luY0FwcGx5aW5nKXNjaGVkdWxlQ2xvdWRTeW5jKDEyMDApOyB9CiAgZnVuY3Rpb24gdXBzZXJ0T3N0cm9tUHJpY2VTdGF0KG1vbnRoLGRhdGEse3BhcnRpYWw9ZmFsc2V9PXt9KXsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChTdHJpbmcobW9udGh8fCIiKSkpcmV0dXJuOwogICAgY29uc3QgbWFwPW5ldyBNYXAob3N0cm9tUHJpY2VTdGF0cy5tYXAoaXRlbT0+W2l0ZW0ubW9udGgsaXRlbV0pKTsKICAgIG1hcC5zZXQobW9udGgsc2FuaXRpemVPc3Ryb21QcmljZVN0YXQoewogICAgICBtb250aCx3ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaDpOdW1iZXIoZGF0YT8ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpLHRvdGFsS1doOk51bWJlcihkYXRhPy50b3RhbEtXaCksdmFyaWFibGVDb3N0RXVyOk51bWJlcihkYXRhPy52YXJpYWJsZUNvc3RFdXIpLGZpeGVkQ29zdEV1cjpOdW1iZXIoZGF0YT8uZml4ZWRDb3N0RXVyKSx0b3RhbENvc3RFdXI6TnVtYmVyKGRhdGE/LnRvdGFsQ29zdEV1ciksY29tcGxldGU6Qm9vbGVhbihkYXRhPy5jb21wbGV0ZSkscGFydGlhbCx1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpCiAgICB9KSk7CiAgICBzYXZlT3N0cm9tUHJpY2VTdGF0cyhbLi4ubWFwLnZhbHVlcygpXSk7CiAgfQoKICBmdW5jdGlvbiB1cGRhdGVSZWNvdmVyeUJhbm5lcigpewogICAgY29uc3QgcHJpbWFyeT1yZWFkUHJpbWFyeVJlY29yZHMoKTsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgY29uc3Qgc2hvdz0oIXByaW1hcnl8fHByaW1hcnkubGVuZ3RoPT09MCkmJnNoYWRvdy5sZW5ndGg+MDsKICAgICQoInJlY292ZXJ5QmFubmVyIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIHJlc3RvcmVTaGFkb3coKXsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgaWYoIXNoYWRvdy5sZW5ndGgpcmV0dXJuOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkoc2hhZG93KSk7CiAgICByZWNvcmRzPXNoYWRvdzsKICAgIHRvYXN0KGAke3NoYWRvdy5sZW5ndGh9IE1vbmF0c3dlcnRlIHdpZWRlcmhlcmdlc3RlbGx0YCk7CiAgICByZW5kZXJBbGwoKTsKICB9CgogIGZ1bmN0aW9uIHRvYXN0KG1lc3NhZ2UpeyBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7ICQoInRvYXN0IikudGV4dENvbnRlbnQ9bWVzc2FnZTsgJCgidG9hc3QiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsgdG9hc3RUaW1lcj1zZXRUaW1lb3V0KCgpPT4kKCJ0b2FzdCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpLDI2MDApOyB9CiAgZnVuY3Rpb24gc2V0U3RhdHVzKGlkLHRleHQsa2luZD0iIil7IGNvbnN0IGVsPSQoaWQpOyBlbC50ZXh0Q29udGVudD10ZXh0fHwiIjsgZWwuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke2tpbmR9YC50cmltKCk7IH0KCiAgZnVuY3Rpb24gc3dpdGNoVmlldyhpZCl7CiAgICBjdXJyZW50Vmlldz1pZDsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi52aWV3IikuZm9yRWFjaCh2PT52LmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsdi5pZD09PWlkKSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIuYm90dG9tLW5hdiBbZGF0YS1uYXZdIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsYi5kYXRhc2V0Lm5hdj09PWlkKSk7CiAgICB3aW5kb3cuc2Nyb2xsVG8oe3RvcDowLGJlaGF2aW9yOiJpbnN0YW50In0pOwogICAgaWYoaWQ9PT0iYW5hbHlzaXNWaWV3IilyZW5kZXJBbmFseXNpcygpOwogICAgaWYoaWQ9PT0iY29uc3VtcHRpb25WaWV3IilyZW5kZXJSZWNvcmRzKCk7CiAgICBpZihpZD09PSJkYXRhVmlldyIpcmVuZGVyRGF0YSgpOwogICAgaWYoaWQ9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7CiAgfQoKICBmdW5jdGlvbiB5ZWFycygpeyByZXR1cm4gWy4uLm5ldyBTZXQocmVjb3Jkcy5tYXAocj0+TnVtYmVyKHIubW9udGguc2xpY2UoMCw0KSkpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKV0uc29ydCgoYSxiKT0+Yi1hKTsgfQogIGZ1bmN0aW9uIGxhdGVzdFJlY29yZCgpeyByZXR1cm4gc29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkuYXQoLTEpfHxzb3J0ZWQoKS5hdCgtMSl8fG51bGw7IH0KICBmdW5jdGlvbiByZWNvcmRGb3JNb250aChtb250aCl7IHJldHVybiByZWNvcmRzLmZpbmQocj0+ci5tb250aD09PW1vbnRoKXx8bnVsbDsgfQoKICBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmQoKXsKICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RSZWNvcmQoKTsKICAgICQoImxhdGVzdE1vbnRoVGl0bGUiKS50ZXh0Q29udGVudD1sYXRlc3Q/bW9udGhMYWJlbChsYXRlc3QubW9udGgpOiJOb2NoIGtlaW5lIE1vbmF0c3dlcnRlIjsKICAgICQoImVkaXRMYXRlc3RCdG4iKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFsYXRlc3QpOwogICAgaWYobGF0ZXN0KSQoImVkaXRMYXRlc3RCdG4iKS5kYXRhc2V0Lm1vbnRoPWxhdGVzdC5tb250aDsKICAgIGNvbnN0IHJlc3Q9bGF0ZXN0P2Rlcml2ZWQobGF0ZXN0KTpudWxsOwogICAgY29uc3QgbWV0cmljcz1sYXRlc3Q/WwogICAgICBbIkdlc2FtdCIsYCR7bnVtKGxhdGVzdC50b3RhbCwxKX0ga1doYCxsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZT9gYXVzIFrDpGhsZXJzdGFuZCAke2RhdGVMYWJlbChsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZSl9YDoiZG9rdW1lbnRpZXJ0Il0sCiAgICAgIFsiV8Okcm1lcHVtcGUiLGAke251bShsYXRlc3QuaGVhdFB1bXAsMSl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LmhlYXRQdW1wKT9gJHtudW0obGF0ZXN0LmhlYXRQdW1wL2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoi4oCTIl0sCiAgICAgIFsiQWx0ZW50ZWlsIixgJHtudW0obGF0ZXN0LmFubmV4LDEpfSBrV2hgLGxhdGVzdC5tZXRlclJlYWRpbmdEYXRlP2Baw6RobGVyICR7bnVtKGxhdGVzdC5hbm5leE1ldGVyUmVhZGluZywwKX0ga1doYDpOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmbGF0ZXN0LnRvdGFsPjAmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QuYW5uZXgpP2Ake251bShsYXRlc3QuYW5uZXgvbGF0ZXN0LnRvdGFsKjEwMCwxKX0gJSBBbnRlaWxgOiLigJMiXSwKICAgICAgWyJTY2hsZWUvS2x1cyIsYCR7bnVtKHJlc3QsMSl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmbGF0ZXN0LnRvdGFsPjA/YCR7bnVtKHJlc3QvbGF0ZXN0LnRvdGFsKjEwMCwxKX0gJSBBbnRlaWxgOiJhdXRvbWF0aXNjaCJdLAogICAgICBbIktvc3RlbiIsZXVybyhyZWNvcmRDb3N0KGxhdGVzdCkpLGxhdGVzdC5vc3Ryb21QcmljZUNvbXBsZXRlP2BPc3Ryb20gZXhha3QgwrcgJHtudW0obGF0ZXN0LnByaWNlQ3QsMil9IGN0L2tXaGA6TnVtYmVyLmlzRmluaXRlKGxhdGVzdC5wcmljZUN0KT9gJHtudW0obGF0ZXN0LnByaWNlQ3QsMil9IGN0L2tXaGA6IkZhbGxiYWNrLVByZWlzIl0KICAgIF06W1siR2VzYW10Iiwi4oCTIiwiTW9uYXQgZWludHJhZ2VuIl0sWyJXw6RybWVwdW1wZSIsIuKAkyIsIiJdLFsiQWx0ZW50ZWlsIiwi4oCTIiwiIl0sWyJTY2hsZWUvS2x1cyIsIuKAkyIsIiJdLFsiS29zdGVuIiwi4oCTIiwiIl1dOwogICAgJCgibGF0ZXN0TWV0cmljcyIpLmlubmVySFRNTD1tZXRyaWNzLm1hcCgoW2xhYmVsLHZhbHVlLHNtYWxsXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2xhYmVsfTwvc3Bhbj48c3Ryb25nPiR7dmFsdWV9PC9zdHJvbmc+PHNtYWxsPiR7c21hbGx9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbigiIik7CiAgICBjb25zdCBjb21wYXJlPWxhdGVzdD9yZWNvcmRGb3JNb250aChgJHtOdW1iZXIobGF0ZXN0Lm1vbnRoLnNsaWNlKDAsNCkpLTF9LSR7bGF0ZXN0Lm1vbnRoLnNsaWNlKDUsNyl9YCk6bnVsbDsKICAgIGNvbnN0IGRlbHRhPWxhdGVzdCYmY29tcGFyZSYmTnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJk51bWJlci5pc0Zpbml0ZShjb21wYXJlLnRvdGFsKSYmY29tcGFyZS50b3RhbCE9PTA/KGxhdGVzdC50b3RhbC1jb21wYXJlLnRvdGFsKS9jb21wYXJlLnRvdGFsKjEwMDpudWxsOwogICAgY29uc3QgY29tcD0kKCJsYXRlc3RDb21wYXJpc29uIik7CiAgICBjb21wLmNsYXNzTmFtZT0iY29tcGFyaXNvbi1saW5lIG5ldXRyYWwiOwogICAgaWYoTnVtYmVyLmlzRmluaXRlKGRlbHRhKSl7CiAgICAgIGNvbXAudGV4dENvbnRlbnQ9YFp1bSBnbGVpY2hlbiBNb25hdCBkZXMgVm9yamFocmVzOiAke3BjdChkZWx0YSl9ICgke251bShsYXRlc3QudG90YWwtY29tcGFyZS50b3RhbCwxKX0ga1doKS5gOwogICAgICBjb21wLmNsYXNzTmFtZT1gY29tcGFyaXNvbi1saW5lICR7ZGVsdGE+MD8icG9zaXRpdmUiOmRlbHRhPDA/Im5lZ2F0aXZlIjoibmV1dHJhbCJ9YDsKICAgIH1lbHNlIGNvbXAudGV4dENvbnRlbnQ9bGF0ZXN0PyJGw7xyIGRpZXNlbiBNb25hdCBpc3Qgbm9jaCBrZWluIHZvbGxzdMOkbmRpZ2VyIFZvcmphaHJlc3ZlcmdsZWljaCB2b3JoYW5kZW4uIjoiVHJhZ2UgZGVuIGVyc3RlbiBNb25hdHN3ZXJ0IGVpbi4iOwogICAgZHJhd0Rhc2hib2FyZENvbnN1bXB0aW9uKCk7CiAgICByZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTsKICB9CgogIGZ1bmN0aW9uIHJlbmRlclJlY29yZHMoKXsKICAgIGNvbnN0IHlzPXllYXJzKCk7CiAgICBjb25zdCBzZWxlY3Q9JCgicmVjb3JkWWVhckZpbHRlciIpOwogICAgY29uc3QgY3VycmVudD1zZWxlY3QudmFsdWV8fCJhbGwiOwogICAgc2VsZWN0LmlubmVySFRNTD0nPG9wdGlvbiB2YWx1ZT0iYWxsIj5BbGxlIEphaHJlPC9vcHRpb24+Jyt5cy5tYXAoeT0+YDxvcHRpb24gdmFsdWU9IiR7eX0iPiR7eX08L29wdGlvbj5gKS5qb2luKCIiKTsKICAgIHNlbGVjdC52YWx1ZT15cy5pbmNsdWRlcyhOdW1iZXIoY3VycmVudCkpP2N1cnJlbnQ6ImFsbCI7CiAgICBjb25zdCBmaWx0ZXJlZD1zb3J0ZWQoKS5yZXZlcnNlKCkuZmlsdGVyKHI9PnNlbGVjdC52YWx1ZT09PSJhbGwifHxyLm1vbnRoLnN0YXJ0c1dpdGgoYCR7c2VsZWN0LnZhbHVlfS1gKSk7CiAgICAkKCJyZWNvcmRDb3VudCIpLnRleHRDb250ZW50PWAke2ZpbHRlcmVkLmxlbmd0aH0gJHtmaWx0ZXJlZC5sZW5ndGg9PT0xPyJNb25hdCI6Ik1vbmF0ZSJ9YDsKICAgIGlmKCFmaWx0ZXJlZC5sZW5ndGgpeyAkKCJyZWNvcmRMaXN0IikuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJlbXB0eS1zdGF0ZSI+PHN0cm9uZz5Ob2NoIGtlaW5lIE1vbmF0c3dlcnRlIGluIGRpZXNlciBBdXN3YWhsLjwvc3Ryb25nPjxzcGFuPlrDpGhsZXJzdMOkbmRlIHVuZCBteVZBSUxMQU5ULUNTViBlcnpldWdlbiBkaWUgTW9uYXRzd2VydGUgYXV0b21hdGlzY2guPC9zcGFuPjwvZGl2Pic7IHJldHVybjsgfQogICAgJCgicmVjb3JkTGlzdCIpLmlubmVySFRNTD1maWx0ZXJlZC5tYXAocj0+ewogICAgICBjb25zdCByZXN0PWRlcml2ZWQociksIGludmFsaWQ9TnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PDA7CiAgICAgIGNvbnN0IHN0YXR1cz1pbnZhbGlkPyJVbnBsYXVzaWJlbCI6Y29tcGxldGUocik/InZvbGxzdMOkbmRpZyI6InVudm9sbHN0w6RuZGlnIjsKICAgICAgY29uc3Qgc291cmNlPShyLm1ldGVyUmVhZGluZ0RhdGU/YCDigKIgWsOkaGxlciBiaXMgJHtkYXRlTGFiZWwoci5tZXRlclJlYWRpbmdEYXRlKX1gOnIuaGVhdFB1bXBTb3VyY2U/LnN0YXJ0c1dpdGgoIm15dmFpbGxhbnQiKT8iIOKAoiBXw6RybWVwdW1wZSBhdXMgQ1NWIjoiIikrKHIub3N0cm9tUHJpY2VDb21wbGV0ZT8iIOKAoiBPc3Ryb20tUHJlaXMgZXhha3QiOiIiKTsKICAgICAgcmV0dXJuIGA8YXJ0aWNsZSBjbGFzcz0icmVjb3JkLXJvdyAke2ludmFsaWQ/ImludmFsaWQiOiIifSI+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLW1vbnRoIj48c3Ryb25nPiR7ZXNjYXBlSHRtbChtb250aExhYmVsKHIubW9udGgpKX08L3N0cm9uZz48c21hbGw+JHtzdGF0dXN9JHtzb3VyY2V9JHtyLm5vdGU/YCDigKIgJHtlc2NhcGVIdG1sKHIubm90ZS5zbGljZSgwLDcwKSl9YDoiIn08L3NtYWxsPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+R2VzYW10PC9zcGFuPjxzdHJvbmc+JHtudW0oci50b3RhbCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5Xw6RybWVwdW1wZTwvc3Bhbj48c3Ryb25nPiR7bnVtKHIuaGVhdFB1bXAsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+QWx0ZW50ZWlsPC9zcGFuPjxzdHJvbmc+JHtudW0oci5hbm5leCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5TY2hsZWUvS2x1czwvc3Bhbj48c3Ryb25nPiR7bnVtKHJlc3QsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IGVkaXQtcmVjb3JkIiB0eXBlPSJidXR0b24iIGRhdGEtZWRpdC1tb250aD0iJHtyLm1vbnRofSI+QmVhcmJlaXRlbjwvYnV0dG9uPgogICAgICA8L2FydGljbGU+YDsKICAgIH0pLmpvaW4oIiIpOwogIH0KCiAgZnVuY3Rpb24gb3BlblJlY29yZE1vZGFsKG1vbnRoKXsKICAgIGNvbnN0IHI9cmVjb3JkRm9yTW9udGgobW9udGgpOwogICAgaWYoIXIpe3RvYXN0KCJNb25hdCBuaWNodCBnZWZ1bmRlbiIpO3JldHVybjt9CiAgICAkKCJyZWNvcmRNb2RhbFRpdGxlIikudGV4dENvbnRlbnQ9bW9udGhMYWJlbChyLm1vbnRoKTsKICAgICQoImVkaXRpbmdNb250aE9yaWdpbmFsIikudmFsdWU9ci5tb250aDsKICAgICQoInJlY29yZE1vbnRoIikudmFsdWU9ci5tb250aDsKICAgICQoInJlY29yZFRvdGFsIikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIudG90YWwpP3IudG90YWw6IiI7CiAgICAkKCJyZWNvcmRIZWF0UHVtcCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKT9yLmhlYXRQdW1wOiIiOwogICAgJCgicmVjb3JkQW5uZXgiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5hbm5leCk/ci5hbm5leDoiIjsKICAgICQoInJlY29yZFByaWNlQ3QiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5wcmljZUN0KT9yLnByaWNlQ3Q6IiI7CiAgICAkKCJyZWNvcmRCYXNlRmVlIikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuYmFzZUZlZSk/ci5iYXNlRmVlOiIiOwogICAgJCgicmVjb3JkSGVhdEdlbmVyYXRlZCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmhlYXRHZW5lcmF0ZWQpP3IuaGVhdEdlbmVyYXRlZDoiIjsKICAgICQoInJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmhlYXRpbmdFbGVjdHJpY2l0eSk/ci5oZWF0aW5nRWxlY3RyaWNpdHk6IiI7CiAgICAkKCJyZWNvcmREaHdFbGVjdHJpY2l0eSIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmRod0VsZWN0cmljaXR5KT9yLmRod0VsZWN0cmljaXR5OiIiOwogICAgJCgicmVjb3JkSGVhdGluZ0hlYXQiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0aW5nSGVhdCk/ci5oZWF0aW5nSGVhdDoiIjsKICAgICQoInJlY29yZERod0hlYXQiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5kaHdIZWF0KT9yLmRod0hlYXQ6IiI7CiAgICAkKCJyZWNvcmROb3RlIikudmFsdWU9ci5ub3RlfHwiIjsKICAgICQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iIjsKICAgICQoInJlY29yZFNvdXJjZUhpbnQiKS50ZXh0Q29udGVudD1yLm1ldGVyUmVhZGluZ0RhdGUKICAgICAgPyBgRGllc2VyIE1vbmF0IHd1cmRlIGF1cyBaw6RobGVyc3TDpG5kZW4gYmVyZWNobmV0LiBFaW5lIEtvcnJla3R1ciBoaWVyIMOkbmRlcnQgbnVyIGRlbiBNb25hdHN3ZXJ0OyBkaWUgZ2VzcGVpY2hlcnRlbiBaw6RobGVyc3TDpG5kZSBiaXMgJHtkYXRlTGFiZWwoci5tZXRlclJlYWRpbmdEYXRlKX0gYmxlaWJlbiBlcmhhbHRlbi5gCiAgICAgIDogci5oZWF0UHVtcFNvdXJjZT8uc3RhcnRzV2l0aCgibXl2YWlsbGFudCIpCiAgICAgICAgPyAiRGllIFfDpHJtZXB1bXBlbndlcnRlIHN0YW1tZW4gYXVzIGVpbmVyIG15VkFJTExBTlQtQ1NWLiBNYW51ZWxsZSDDhG5kZXJ1bmdlbiBrw7ZubmVuIGJlaSBlaW5lbSBzcMOkdGVyZW4gZXJuZXV0ZW4gQ1NWLUltcG9ydCB3aWVkZXIgZXJzZXR6dCB3ZXJkZW4uIgogICAgICAgIDogIk1hbnVlbGxlIEtvcnJla3R1ciBlaW5lcyBnZXNwZWljaGVydGVuIE1vbmF0c3dlcnRlcy4iOwogICAgdXBkYXRlRGVyaXZlZFByZXZpZXcoKTsKICAgICQoInJlY29yZE1vZGFsIikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7CiAgICBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSJoaWRkZW4iOwogIH0KICBmdW5jdGlvbiBjbG9zZVJlY29yZE1vZGFsKCl7ICQoInJlY29yZE1vZGFsIikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7IGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9IiI7IH0KICBmdW5jdGlvbiB1cGRhdGVEZXJpdmVkUHJldmlldygpewogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkVG90YWwiKS52YWx1ZSksaGVhdD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0UHVtcCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRBbm5leCIpLnZhbHVlKTsKICAgIGNvbnN0IGVsPSQoImRlcml2ZWRQcmV2aWV3Iik7CiAgICBpZihbdG90YWwsaGVhdCxhbm5leF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSl7CiAgICAgIGNvbnN0IHJlc3Q9dG90YWwtaGVhdC1hbm5leDsKICAgICAgZWwudGV4dENvbnRlbnQ9YFNjaGxlZS9LbHVzOiAke251bShyZXN0LDMpfSBrV2hgOwogICAgICBlbC5jbGFzc0xpc3QudG9nZ2xlKCJlcnJvciIscmVzdDwwKTsKICAgIH1lbHNlewogICAgICBlbC50ZXh0Q29udGVudD0iU2NobGVlL0tsdXM6IOKAkyAod2lyZCBhdXMgR2VzYW10IOKIkiBXw6RybWVwdW1wZSDiiJIgQWx0ZW50ZWlsIGJlcmVjaG5ldCkiOwogICAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCJlcnJvciIpOwogICAgfQogIH0KICBmdW5jdGlvbiBzYXZlRWRpdGVkUmVjb3JkKGV2ZW50KXsKICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICBjb25zdCBtb250aD0kKCJlZGl0aW5nTW9udGhPcmlnaW5hbCIpLnZhbHVlOwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgobW9udGgpOwogICAgaWYoIWV4aXN0aW5nKXskKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkRlciBNb25hdCB3dXJkZSBuaWNodCBnZWZ1bmRlbi4iO3JldHVybjt9CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRUb3RhbCIpLnZhbHVlKSxoZWF0UHVtcD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0UHVtcCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRBbm5leCIpLnZhbHVlKTsKICAgIGlmKFt0b3RhbCxoZWF0UHVtcCxhbm5leF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSYmdG90YWwtaGVhdFB1bXAtYW5uZXg8LS4wMSl7CiAgICAgICQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iVW5wbGF1c2liZWw6IFfDpHJtZXB1bXBlICsgQWx0ZW50ZWlsIHNpbmQgZ3LDtsOfZXIgYWxzIGRlciBHZXNhbXR2ZXJicmF1Y2guIjtyZXR1cm47CiAgICB9CiAgICBjb25zdCBoZWF0Q2hhbmdlZD1oZWF0UHVtcCE9PWV4aXN0aW5nLmhlYXRQdW1wOwogICAgY29uc3QgbWV0ZXJDaGFuZ2VkPXRvdGFsIT09ZXhpc3RpbmcudG90YWx8fGFubmV4IT09ZXhpc3RpbmcuYW5uZXg7CiAgICBjb25zdCBuZXh0UHJpY2VDdD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRQcmljZUN0IikudmFsdWUpLG5leHRCYXNlRmVlPW51bGxhYmxlTnVtYmVyKCQoInJlY29yZEJhc2VGZWUiKS52YWx1ZSk7CiAgICBjb25zdCBwcmljZUNoYW5nZWQ9bmV4dFByaWNlQ3QhPT1leGlzdGluZy5wcmljZUN0fHxuZXh0QmFzZUZlZSE9PWV4aXN0aW5nLmJhc2VGZWU7CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgICBjb25zdCByZWNvcmQ9ey4uLmV4aXN0aW5nLAogICAgICB0b3RhbCxoZWF0UHVtcCxhbm5leCwKICAgICAgcHJpY2VDdDpuZXh0UHJpY2VDdCwKICAgICAgYmFzZUZlZTpuZXh0QmFzZUZlZSwKICAgICAgaGVhdEdlbmVyYXRlZDpudWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0R2VuZXJhdGVkIikudmFsdWUpLAogICAgICBoZWF0aW5nRWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdGluZ0VsZWN0cmljaXR5IikudmFsdWUpLAogICAgICBkaHdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcigkKCJyZWNvcmREaHdFbGVjdHJpY2l0eSIpLnZhbHVlKSwKICAgICAgaGVhdGluZ0hlYXQ6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdGluZ0hlYXQiKS52YWx1ZSksCiAgICAgIGRod0hlYXQ6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkRGh3SGVhdCIpLnZhbHVlKSwKICAgICAgbm90ZTokKCJyZWNvcmROb3RlIikudmFsdWUudHJpbSgpLAogICAgICBoZWF0UHVtcFNvdXJjZTpoZWF0Q2hhbmdlZD8ibWFudWFsLWNvcnJlY3Rpb24iOmV4aXN0aW5nLmhlYXRQdW1wU291cmNlLAogICAgICBoZWF0UHVtcFVwZGF0ZWRBdDpoZWF0Q2hhbmdlZD9zdGFtcDpleGlzdGluZy5oZWF0UHVtcFVwZGF0ZWRBdCwKICAgICAgbWV0ZXJTb3VyY2U6bWV0ZXJDaGFuZ2VkJiZleGlzdGluZy5tZXRlclNvdXJjZT9gJHtleGlzdGluZy5tZXRlclNvdXJjZX0rbWFudWFsLW1vbnRoLWNvcnJlY3Rpb25gOmV4aXN0aW5nLm1ldGVyU291cmNlLAogICAgICBwcmljZVNvdXJjZTpwcmljZUNoYW5nZWQ/Im1hbnVhbC1jb3JyZWN0aW9uIjpleGlzdGluZy5wcmljZVNvdXJjZSwKICAgICAgcHJpY2VVcGRhdGVkQXQ6cHJpY2VDaGFuZ2VkP3N0YW1wOmV4aXN0aW5nLnByaWNlVXBkYXRlZEF0LAogICAgICBvc3Ryb21WYXJpYWJsZUNvc3RFdXI6cHJpY2VDaGFuZ2VkP251bGw6ZXhpc3Rpbmcub3N0cm9tVmFyaWFibGVDb3N0RXVyLAogICAgICBvc3Ryb21Ub3RhbENvc3RFdXI6cHJpY2VDaGFuZ2VkP251bGw6ZXhpc3Rpbmcub3N0cm9tVG90YWxDb3N0RXVyLAogICAgICBvc3Ryb21Db25zdW1wdGlvbktXaDpwcmljZUNoYW5nZWQ/bnVsbDpleGlzdGluZy5vc3Ryb21Db25zdW1wdGlvbktXaCwKICAgICAgb3N0cm9tUHJpY2VDb21wbGV0ZTpwcmljZUNoYW5nZWQ/ZmFsc2U6ZXhpc3Rpbmcub3N0cm9tUHJpY2VDb21wbGV0ZSwKICAgICAgdXBkYXRlZEF0OnN0YW1wCiAgICB9OwogICAgY29uc3QgbmV4dD1yZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoIT09bW9udGgpO25leHQucHVzaChyZWNvcmQpOwogICAgdHJ5e3NhdmVSZWNvcmRzKG5leHQse3JlYXNvbjpgTW9uYXQgJHttb250aH0gbWFudWVsbCBrb3JyaWdpZXJ0YH0pO30KICAgIGNhdGNoKGVycm9yKXskKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9ZXJyb3IubWVzc2FnZTtyZXR1cm47fQogICAgY2xvc2VSZWNvcmRNb2RhbCgpO3JlbmRlckFsbCgpO3RvYXN0KGAke21vbnRoTGFiZWwobW9udGgpfSBnZcOkbmRlcnRgKTsKICB9CgogIGZ1bmN0aW9uIG9wZW5NZXRlck1vZGFsKCl7CiAgICBjb25zdCBwcmV2aW91cz1sYXRlc3RNZXRlclJlYWRpbmcoKTsKICAgIGlmKCFwcmV2aW91cyl7YWxlcnQoIkVzIGZlaGx0IGVpbiBBdXNnYW5nc3rDpGhsZXJzdGFuZC4iKTtyZXR1cm47fQogICAgJCgibWV0ZXJEYXRlIikudmFsdWU9bmV4dE1vbnRoRmlyc3QocHJldmlvdXMuZGF0ZSk7CiAgICAkKCJtZXRlclRvdGFsIikudmFsdWU9IiI7CiAgICAkKCJtZXRlckFubmV4IikudmFsdWU9IiI7CiAgICAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iIjsKICAgIHVwZGF0ZU1ldGVyUHJldmlldygpOwogICAgJCgibWV0ZXJNb2RhbCIpLmNsYXNzTGlzdC5yZW1vdmUoImhpZGRlbiIpOwogICAgZG9jdW1lbnQuYm9keS5zdHlsZS5vdmVyZmxvdz0iaGlkZGVuIjsKICAgIHNldFRpbWVvdXQoKCk9PiQoIm1ldGVyVG90YWwiKS5mb2N1cygpLDUwKTsKICB9CiAgZnVuY3Rpb24gY2xvc2VNZXRlck1vZGFsKCl7ICQoIm1ldGVyTW9kYWwiKS5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsgZG9jdW1lbnQuYm9keS5zdHlsZS5vdmVyZmxvdz0iIjsgfQogIGZ1bmN0aW9uIHVwZGF0ZU1ldGVyUHJldmlldygpewogICAgY29uc3QgcHJldmlvdXM9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighcHJldmlvdXMpcmV0dXJuOwogICAgY29uc3QgZGF0ZT0kKCJtZXRlckRhdGUiKS52YWx1ZXx8bmV4dE1vbnRoRmlyc3QocHJldmlvdXMuZGF0ZSk7CiAgICBjb25zdCB0YXJnZXRNb250aD1wcmV2aW91cy5kYXRlLnNsaWNlKDAsNyk7CiAgICAkKCJtZXRlclByZXZpb3VzIikuaW5uZXJIVE1MPWBWb3JoZXJpZ2VyIFN0YW5kOiA8c3Ryb25nPiR7ZGF0ZUxhYmVsKHByZXZpb3VzLmRhdGUpfTwvc3Ryb25nPiDCtyBHZXNhbXQgPHN0cm9uZz4ke251bShwcmV2aW91cy50b3RhbCwwKX0ga1doPC9zdHJvbmc+IMK3IEFsdGVudGVpbCA8c3Ryb25nPiR7bnVtKHByZXZpb3VzLmFubmV4LDApfSBrV2g8L3N0cm9uZz5gOwogICAgJCgibWV0ZXJUYXJnZXRNb250aCIpLnRleHRDb250ZW50PWBCZXJlY2huZXQgd2lyZCBkZXIgVmVyYnJhdWNoIGbDvHIgJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0uYDsKICAgIGNvbnN0IHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyVG90YWwiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJBbm5leCIpLnZhbHVlKTsKICAgIGlmKE51bWJlci5pc0Zpbml0ZSh0b3RhbCkmJk51bWJlci5pc0Zpbml0ZShhbm5leCkpewogICAgICBjb25zdCB0b3RhbFVzZT10b3RhbC1wcmV2aW91cy50b3RhbCxhbm5leFVzZT1hbm5leC1wcmV2aW91cy5hbm5leDsKICAgICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgodGFyZ2V0TW9udGgpLGhlYXQ9ZXhpc3Rpbmc/LmhlYXRQdW1wOwogICAgICBjb25zdCByZXN0PU51bWJlci5pc0Zpbml0ZShoZWF0KT90b3RhbFVzZS1hbm5leFVzZS1oZWF0Om51bGw7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLmlubmVySFRNTD1gR2VzYW10OiA8c3Ryb25nPiR7bnVtKHRvdGFsVXNlLDEpfSBrV2g8L3N0cm9uZz4gwrcgQWx0ZW50ZWlsOiA8c3Ryb25nPiR7bnVtKGFubmV4VXNlLDEpfSBrV2g8L3N0cm9uZz4ke051bWJlci5pc0Zpbml0ZShoZWF0KT9gIMK3IFfDpHJtZXB1bXBlOiA8c3Ryb25nPiR7bnVtKGhlYXQsMSl9IGtXaDwvc3Ryb25nPiDCtyBTY2hsZWUvS2x1czogPHN0cm9uZz4ke251bShyZXN0LDEpfSBrV2g8L3N0cm9uZz5gOmAgwrcgV8Okcm1lcHVtcGU6IDxzdHJvbmc+Q1NWIGZlaGx0PC9zdHJvbmc+YH1gOwogICAgICAkKCJtZXRlclByZXZpZXciKS5jbGFzc0xpc3QudG9nZ2xlKCJlcnJvciIsdG90YWxVc2U8MHx8YW5uZXhVc2U8MHx8KE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwKSk7CiAgICB9ZWxzZXsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikudGV4dENvbnRlbnQ9Ik1vbmF0c3ZlcmJyw6R1Y2hlIHdlcmRlbiBhdXMgZGVyIERpZmZlcmVueiB6dW0gdm9yaGVyaWdlbiBaw6RobGVyc3RhbmQgYmVyZWNobmV0LiI7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLmNsYXNzTGlzdC5yZW1vdmUoImVycm9yIik7CiAgICB9CiAgfQogIGZ1bmN0aW9uIHNhdmVNZXRlclJlYWRpbmdGcm9tRm9ybShldmVudCl7CiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpOwogICAgY29uc3QgcHJldmlvdXM9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighcHJldmlvdXMpcmV0dXJuOwogICAgY29uc3QgZGF0ZT0kKCJtZXRlckRhdGUiKS52YWx1ZSx0b3RhbD1udWxsYWJsZU51bWJlcigkKCJtZXRlclRvdGFsIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyQW5uZXgiKS52YWx1ZSk7CiAgICBpZighL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoZGF0ZSkpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iQml0dGUgZWluIGfDvGx0aWdlcyBBYmxlc2VkYXR1bSB3w6RobGVuLiI7IHJldHVybjsgfQogICAgaWYoZGF0ZTw9cHJldmlvdXMuZGF0ZSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWBEYXMgRGF0dW0gbXVzcyBuYWNoIGRlbSBsZXR6dGVuIFN0YW5kIHZvbSAke2RhdGVMYWJlbChwcmV2aW91cy5kYXRlKX0gbGllZ2VuLmA7IHJldHVybjsgfQogICAgaWYoIU51bWJlci5pc0Zpbml0ZSh0b3RhbCl8fCFOdW1iZXIuaXNGaW5pdGUoYW5uZXgpKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkJpdHRlIGJlaWRlIFrDpGhsZXJzdMOkbmRlIGVpbnRyYWdlbi4iOyByZXR1cm47IH0KICAgIGlmKHRvdGFsPHByZXZpb3VzLnRvdGFsKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkRlciBHZXNhbXR6w6RobGVyc3RhbmQgaXN0IGtsZWluZXIgYWxzIGRlciB2b3JoZXJpZ2UgU3RhbmQuIEVpbiBuZXVlciBaw6RobGVyIG3DvHNzdGUgc2VwYXJhdCBiZXLDvGNrc2ljaHRpZ3Qgd2VyZGVuLiI7IHJldHVybjsgfQogICAgaWYoYW5uZXg8cHJldmlvdXMuYW5uZXgpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iRGVyIEFsdGVudGVpbC1aw6RobGVyc3RhbmQgaXN0IGtsZWluZXIgYWxzIGRlciB2b3JoZXJpZ2UgU3RhbmQuIjsgcmV0dXJuOyB9CiAgICBjb25zdCB0YXJnZXRNb250aD1wcmV2aW91cy5kYXRlLnNsaWNlKDAsNyksdG90YWxVc2U9dG90YWwtcHJldmlvdXMudG90YWwsYW5uZXhVc2U9YW5uZXgtcHJldmlvdXMuYW5uZXg7CiAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aCh0YXJnZXRNb250aCl8fHNhbml0aXplUmVjb3JkKHttb250aDp0YXJnZXRNb250aH0pOwogICAgY29uc3QgcmVzdD1OdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcuaGVhdFB1bXApP3RvdGFsVXNlLWFubmV4VXNlLWV4aXN0aW5nLmhlYXRQdW1wOm51bGw7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8LS4wMSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWBVbnBsYXVzaWJlbDogTmFjaCBBYnp1ZyB2b24gV8Okcm1lcHVtcGUgdW5kIEFsdGVudGVpbCBlcmdpYnQgU2NobGVlL0tsdXMgJHtudW0ocmVzdCwxKX0ga1doLmA7IHJldHVybjsgfQogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgY29uc3QgbmV4dFJlY29yZD17Li4uZXhpc3RpbmcsdG90YWw6dG90YWxVc2UsYW5uZXg6YW5uZXhVc2UsbWV0ZXJSZWFkaW5nRGF0ZTpkYXRlLHByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZTpwcmV2aW91cy5kYXRlLHRvdGFsTWV0ZXJSZWFkaW5nOnRvdGFsLGFubmV4TWV0ZXJSZWFkaW5nOmFubmV4LG1ldGVyU291cmNlOiJjdW11bGF0aXZlLXJlYWRpbmdzIix1cGRhdGVkQXQ6c3RhbXB9OwogICAgY29uc3QgbmV4dD1yZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoIT09dGFyZ2V0TW9udGgpO25leHQucHVzaChuZXh0UmVjb3JkKTsKICAgIHRyeXsKICAgICAgc2F2ZVJlY29yZHMobmV4dCx7cmVhc29uOmBaw6RobGVyc3TDpG5kZSAke2RhdGVMYWJlbChkYXRlKX0gZ2VzcGVpY2hlcnRgfSk7CiAgICAgIHNhdmVNZXRlclJlYWRpbmdzKFsuLi5tZXRlclJlYWRpbmdzLHtkYXRlLHRvdGFsLGFubmV4LG5vdGU6YFZlcmJyYXVjaCAke3RhcmdldE1vbnRofWAsdXBkYXRlZEF0OnN0YW1wfV0pOwogICAgfWNhdGNoKGVycm9yKXskKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1lcnJvci5tZXNzYWdlO3JldHVybjt9CiAgICBjbG9zZU1ldGVyTW9kYWwoKTtyZW5kZXJBbGwoKTsKICAgIHRvYXN0KE51bWJlci5pc0Zpbml0ZShleGlzdGluZy5oZWF0UHVtcCk/YCR7bW9udGhMYWJlbCh0YXJnZXRNb250aCl9IHZvbGxzdMOkbmRpZyBiZXJlY2huZXRgOmBaw6RobGVyc3TDpG5kZSBnZXNwZWljaGVydCDCtyBXw6RybWVwdW1wZW4tQ1NWIGZlaGx0IG5vY2hgKTsKICB9CiAgZnVuY3Rpb24gdW5kb0xhdGVzdE1ldGVyUmVhZGluZygpewogICAgaWYobWV0ZXJSZWFkaW5ncy5sZW5ndGg8PTEpcmV0dXJuOwogICAgY29uc3QgbGF0ZXN0PW1ldGVyUmVhZGluZ3MuYXQoLTEpLHByZXZpb3VzPW1ldGVyUmVhZGluZ3MuYXQoLTIpLHRhcmdldE1vbnRoPXByZXZpb3VzLmRhdGUuc2xpY2UoMCw3KTsKICAgIGlmKCFjb25maXJtKGBaw6RobGVyc3RhbmQgdm9tICR7ZGF0ZUxhYmVsKGxhdGVzdC5kYXRlKX0genVyw7xja25laG1lbj8gRGllIGRhcmF1cyBiZXJlY2huZXRlbiBXZXJ0ZSBmw7xyICR7bW9udGhMYWJlbCh0YXJnZXRNb250aCl9IHdlcmRlbiBlbnRmZXJudC5gKSlyZXR1cm47CiAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aCh0YXJnZXRNb250aCk7CiAgICBpZihleGlzdGluZyl7CiAgICAgIGNvbnN0IGNsZWFyZWQ9ey4uLmV4aXN0aW5nLHRvdGFsOm51bGwsYW5uZXg6bnVsbCxtZXRlclJlYWRpbmdEYXRlOm51bGwscHJldmlvdXNNZXRlclJlYWRpbmdEYXRlOm51bGwsdG90YWxNZXRlclJlYWRpbmc6bnVsbCxhbm5leE1ldGVyUmVhZGluZzpudWxsLG1ldGVyU291cmNlOiIiLHVwZGF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9OwogICAgICBjb25zdCBuZXh0PXJlY29yZHMuZmlsdGVyKHI9PnIubW9udGghPT10YXJnZXRNb250aCk7bmV4dC5wdXNoKGNsZWFyZWQpO3NhdmVSZWNvcmRzKG5leHQse3JlYXNvbjpgTGV0enRlbiBaw6RobGVyc3RhbmQgJHtsYXRlc3QuZGF0ZX0genVyw7xja2dlbm9tbWVuYH0pOwogICAgfQogICAgc2F2ZU1ldGVyUmVhZGluZ3MobWV0ZXJSZWFkaW5ncy5zbGljZSgwLC0xKSk7cmVuZGVyQWxsKCk7dG9hc3QoIkxldHp0ZW4gWsOkaGxlcnN0YW5kIHp1csO8Y2tnZW5vbW1lbiIpOwogIH0KCiAgZnVuY3Rpb24gYW5hbHlzaXNZZWFyUm93cyh5ZWFyKXsgcmV0dXJuIHJlY29yZHMuZmlsdGVyKHI9PnIubW9udGguc3RhcnRzV2l0aChgJHt5ZWFyfS1gKSkuc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsgfQogIGZ1bmN0aW9uIG9zdHJvbVN0YXRzRm9yWWVhcih5ZWFyKXsKICAgIGNvbnN0IGNhY2hlPW5ldyBNYXAob3N0cm9tUHJpY2VTdGF0cy5maWx0ZXIoaXRlbT0+aXRlbS5tb250aC5zdGFydHNXaXRoKGAke3llYXJ9LWApKS5tYXAoaXRlbT0+W2l0ZW0ubW9udGgsaXRlbV0pKTsKICAgIGZvcihjb25zdCByIG9mIGFuYWx5c2lzWWVhclJvd3MoeWVhcikpewogICAgICBpZighci5vc3Ryb21QcmljZUNvbXBsZXRlfHwhTnVtYmVyLmlzRmluaXRlKHIucHJpY2VDdCl8fCFOdW1iZXIuaXNGaW5pdGUoci5vc3Ryb21Db25zdW1wdGlvbktXaCl8fHIub3N0cm9tQ29uc3VtcHRpb25LV2g8PTApY29udGludWU7CiAgICAgIGNvbnN0IGZyb21SZWNvcmQ9c2FuaXRpemVPc3Ryb21QcmljZVN0YXQoe21vbnRoOnIubW9udGgsd2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2g6ci5wcmljZUN0LHRvdGFsS1doOnIub3N0cm9tQ29uc3VtcHRpb25LV2gsdmFyaWFibGVDb3N0RXVyOnIub3N0cm9tVmFyaWFibGVDb3N0RXVyLGZpeGVkQ29zdEV1cjpyLmJhc2VGZWUsdG90YWxDb3N0RXVyOnIub3N0cm9tVG90YWxDb3N0RXVyLGNvbXBsZXRlOnRydWUscGFydGlhbDpmYWxzZSx1cGRhdGVkQXQ6ci5wcmljZVVwZGF0ZWRBdHx8ci51cGRhdGVkQXR8fCIifSk7CiAgICAgIGNvbnN0IGV4aXN0aW5nPWNhY2hlLmdldChyLm1vbnRoKTsKICAgICAgaWYoIWV4aXN0aW5nfHxEYXRlLnBhcnNlKGZyb21SZWNvcmQudXBkYXRlZEF0fHwiIik+PURhdGUucGFyc2UoZXhpc3RpbmcudXBkYXRlZEF0fHwiIikpY2FjaGUuc2V0KHIubW9udGgsZnJvbVJlY29yZCk7CiAgICB9CiAgICByZXR1cm4gWy4uLmNhY2hlLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOwogIH0KICBmdW5jdGlvbiBvc3Ryb21QZXJpb2RBdmVyYWdlKGl0ZW1zKXsKICAgIGNvbnN0IHZhbGlkPShBcnJheS5pc0FycmF5KGl0ZW1zKT9pdGVtczpbXSkuZmlsdGVyKGl0ZW09Pk51bWJlci5pc0Zpbml0ZShpdGVtLnRvdGFsS1doKSYmaXRlbS50b3RhbEtXaD4wJiZOdW1iZXIuaXNGaW5pdGUoaXRlbS52YXJpYWJsZUNvc3RFdXIpKTsKICAgIGlmKCF2YWxpZC5sZW5ndGgpcmV0dXJuIHthdmVyYWdlQ3Q6bnVsbCxlZmZlY3RpdmVDdDpudWxsLGtXaDowLHZhcmlhYmxlQ29zdEV1cjowLGZpeGVkQ29zdEV1cjowLHRvdGFsQ29zdEV1cjowLG1vbnRoczowLHBhcnRpYWw6ZmFsc2V9OwogICAgY29uc3Qga1doPXZhbGlkLnJlZHVjZSgoc3VtLGl0ZW0pPT5zdW0rTnVtYmVyKGl0ZW0udG90YWxLV2h8fDApLDApOwogICAgY29uc3QgdmFyaWFibGVDb3N0RXVyPXZhbGlkLnJlZHVjZSgoc3VtLGl0ZW0pPT5zdW0rTnVtYmVyKGl0ZW0udmFyaWFibGVDb3N0RXVyfHwwKSwwKTsKICAgIGNvbnN0IGZpeGVkQ29zdEV1cj12YWxpZC5yZWR1Y2UoKHN1bSxpdGVtKT0+c3VtK051bWJlcihpdGVtLmZpeGVkQ29zdEV1cnx8MCksMCk7CiAgICBjb25zdCB0b3RhbENvc3RFdXI9dmFsaWQucmVkdWNlKChzdW0saXRlbSk9PnN1bSsoTnVtYmVyLmlzRmluaXRlKGl0ZW0udG90YWxDb3N0RXVyKT9OdW1iZXIoaXRlbS50b3RhbENvc3RFdXIpOk51bWJlcihpdGVtLnZhcmlhYmxlQ29zdEV1cnx8MCkrTnVtYmVyKGl0ZW0uZml4ZWRDb3N0RXVyfHwwKSksMCk7CiAgICByZXR1cm4ge2F2ZXJhZ2VDdDprV2g+MD92YXJpYWJsZUNvc3RFdXIva1doKjEwMDpudWxsLGVmZmVjdGl2ZUN0OmtXaD4wP3RvdGFsQ29zdEV1ci9rV2gqMTAwOm51bGwsa1doLHZhcmlhYmxlQ29zdEV1cixmaXhlZENvc3RFdXIsdG90YWxDb3N0RXVyLG1vbnRoczp2YWxpZC5sZW5ndGgscGFydGlhbDp2YWxpZC5zb21lKGl0ZW09Pml0ZW0ucGFydGlhbCl9OwogIH0KICBmdW5jdGlvbiBxdWFydGVyRm9yTW9udGgobW9udGgpe3JldHVybiBNYXRoLmZsb29yKChOdW1iZXIoU3RyaW5nKG1vbnRoKS5zbGljZSg1LDcpKS0xKS8zKSsxO30KICBmdW5jdGlvbiByZW5kZXJPc3Ryb21QcmljZVN0YXRzKHllYXIpewogICAgaWYoISQoJ29zdHJvbVByaWNlU3RhdHNNZXRyaWNzJykpcmV0dXJuOwogICAgY29uc3QgaXRlbXM9b3N0cm9tU3RhdHNGb3JZZWFyKHllYXIpOwogICAgY29uc3QgY3VycmVudFllYXI9bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpOwogICAgY29uc3QgYW5udWFsPW9zdHJvbVBlcmlvZEF2ZXJhZ2UoaXRlbXMpOwogICAgY29uc3QgY2FyZHM9W1tTdHJpbmcoeWVhciksYW5udWFsLHllYXI9PT1jdXJyZW50WWVhcj8iYmlzIGhldXRlIjoiSmFocmVzd2VydCJdXTsKICAgIGZvcihsZXQgcT0xO3E8PTQ7cSsrKWNhcmRzLnB1c2goW2BRJHtxfWAsb3N0cm9tUGVyaW9kQXZlcmFnZShpdGVtcy5maWx0ZXIoaXRlbT0+cXVhcnRlckZvck1vbnRoKGl0ZW0ubW9udGgpPT09cSkpLGAke2l0ZW1zLmZpbHRlcihpdGVtPT5xdWFydGVyRm9yTW9udGgoaXRlbS5tb250aCk9PT1xKS5sZW5ndGh9IE1vbmF0KGUpYF0pOwogICAgJCgnb3N0cm9tUHJpY2VTdGF0c01ldHJpY3MnKS5pbm5lckhUTUw9Y2FyZHMubWFwKChbbGFiZWwsc3RhdHMsc3ViXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj48c3Ryb25nPiR7TnVtYmVyLmlzRmluaXRlKHN0YXRzLmF2ZXJhZ2VDdCk/YCR7bnVtKHN0YXRzLmF2ZXJhZ2VDdCwyKX0gY3Qva1doYDoi4oCTIn08L3N0cm9uZz48c21hbGw+JHtzdGF0cy5tb250aHM/YCR7ZXNjYXBlSHRtbChzdWIpfSDCtyAke251bShzdGF0cy5rV2gsMCl9IGtXaCR7TnVtYmVyLmlzRmluaXRlKHN0YXRzLmVmZmVjdGl2ZUN0KT9gIMK3IGlua2wuIEZpeGtvc3RlbiAke251bShzdGF0cy5lZmZlY3RpdmVDdCwyKX0gY3Qva1doYDoiIn1gOiJrZWluZSBPc3Ryb20tRGF0ZW4ifTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oJycpOwogICAgY29uc3QgbW9udGhNYXA9bmV3IE1hcChpdGVtcy5tYXAoaXRlbT0+W051bWJlcihpdGVtLm1vbnRoLnNsaWNlKDUsNykpLGl0ZW1dKSk7CiAgICAkKCdvc3Ryb21QcmljZVN0YXRzVGFibGUnKS5pbm5lckhUTUw9QXJyYXkuZnJvbSh7bGVuZ3RoOjEyfSwoXyxpKT0+aSsxKS5tYXAobT0+ewogICAgICBjb25zdCBpdGVtPW1vbnRoTWFwLmdldChtKTtpZighaXRlbSlyZXR1cm4gYDx0cj48dGQ+JHtNT05USFNbbS0xXX08L3RkPjx0ZD7igJM8L3RkPjx0ZD7igJM8L3RkPjx0ZD7igJM8L3RkPjx0ZD7igJM8L3RkPjwvdHI+YDsKICAgICAgY29uc3QgZWZmZWN0aXZlPU51bWJlcihpdGVtLnRvdGFsS1doKT4wJiZOdW1iZXIuaXNGaW5pdGUoaXRlbS50b3RhbENvc3RFdXIpP051bWJlcihpdGVtLnRvdGFsQ29zdEV1cikvTnVtYmVyKGl0ZW0udG90YWxLV2gpKjEwMDpudWxsOwogICAgICBjb25zdCBydW5uaW5nPWl0ZW0ucGFydGlhbHx8aXRlbS5tb250aD09PWN1cnJlbnRNb250aEtleSgpOwogICAgICByZXR1cm4gYDx0cj48dGQ+JHtNT05USFNbbS0xXX0ke3J1bm5pbmc/JyA8c21hbGwgY2xhc3M9InByaWNlLXJ1bm5pbmciPmxhdWZlbmQ8L3NtYWxsPic6Jyd9PC90ZD48dGQ+JHtudW0oaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCwyKX0gY3Q8L3RkPjx0ZD4ke051bWJlci5pc0Zpbml0ZShlZmZlY3RpdmUpP2Ake251bShlZmZlY3RpdmUsMil9IGN0YDoi4oCTIn08L3RkPjx0ZD4ke251bShpdGVtLnRvdGFsS1doLDEpfSBrV2g8L3RkPjx0ZD4ke2l0ZW0uY29tcGxldGU/J09zdHJvbSBleGFrdCc6J3Vudm9sbHN0w6RuZGlnJ308L3RkPjwvdHI+YDsKICAgIH0pLmpvaW4oJycpOwogICAgY29uc3QgbGFzdD1pdGVtcy5tYXAoaXRlbT0+RGF0ZS5wYXJzZShpdGVtLnVwZGF0ZWRBdHx8JycpKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKS5zb3J0KChhLGIpPT5iLWEpWzBdOwogICAgJCgnb3N0cm9tUHJpY2VTdGF0c1N0YXR1cycpLnRleHRDb250ZW50PW9zdHJvbVByaWNlU3RhdHNCdXN5PydPc3Ryb20tUHJlaXNlIHdlcmRlbiBnZWxhZGVuIOKApic6aXRlbXMubGVuZ3RoP2Ake2l0ZW1zLmxlbmd0aH0gTW9uYXQoZSkgdmVyZsO8Z2JhciR7bGFzdD9gIMK3IHp1bGV0enQgJHtmb3JtYXREYXRlVGltZShsYXN0KX1gOicnfSDCtyBRdWFydGFsL0phaHIgdmVyYnJhdWNoc2dld2ljaHRldGA6c2V0dGluZ3Mub3N0cm9tQXBwS2V5PydOb2NoIGtlaW5lIFByZWlzc3RhdGlzdGlrIGbDvHIgZGllc2VzIEphaHIgZ2VsYWRlbi4nOidOb2NoIGtlaW5lIFByZWlzc3RhdGlzdGlrIHN5bmNocm9uaXNpZXJ0LiBBdWYgZWluZW0gdmVyYnVuZGVuZW4gR2Vyw6R0IG1pdCBPc3Ryb20tU2NobMO8c3NlbCBha3R1YWxpc2llcmVuLic7CiAgICAkKCdyZWZyZXNoT3N0cm9tUHJpY2VTdGF0c0J0bicpLmRpc2FibGVkPW9zdHJvbVByaWNlU3RhdHNCdXN5fHwhc2V0dGluZ3Mub3N0cm9tQXBwS2V5OwogICAgZHJhd09zdHJvbUF2ZXJhZ2VQcmljZUNoYXJ0KHllYXIsaXRlbXMpOwogIH0KICBmdW5jdGlvbiBkcmF3T3N0cm9tQXZlcmFnZVByaWNlQ2hhcnQoeWVhcixpdGVtcz1vc3Ryb21TdGF0c0ZvclllYXIoeWVhcikpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCdvc3Ryb21BdmVyYWdlUHJpY2VDaGFydCcpKTtpZighYylyZXR1cm47Y29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7CiAgICBjb25zdCB2YWxzPWl0ZW1zLm1hcChpdGVtPT5OdW1iZXIoaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpO2lmKCF2YWxzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsJ0tlaW5lIE9zdHJvbS1QcmVpc2RhdGVuJyk7cmV0dXJuO30KICAgIGNvbnN0IG1heD1NYXRoLm1heCguLi52YWxzKSoxLjE1fHwxOwogICAgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxNT05USFMse30pOwogICAgY29uc3QgbWFwPW5ldyBNYXAoaXRlbXMubWFwKGl0ZW09PltOdW1iZXIoaXRlbS5tb250aC5zbGljZSg1LDcpKS0xLGl0ZW1dKSk7Y3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5jb3N0O2N0eC5saW5lV2lkdGg9Mi44O2N0eC5iZWdpblBhdGgoKTtsZXQgc3RhcnRlZD1mYWxzZTsKICAgIGZvcihsZXQgbT0wO208MTI7bSsrKXtjb25zdCBpdGVtPW1hcC5nZXQobSk7aWYoIWl0ZW18fCFOdW1iZXIuaXNGaW5pdGUoaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpY29udGludWU7Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKm0vMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtaXRlbS53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaC9tYXgpO2lmKCFzdGFydGVkKXtjdHgubW92ZVRvKHgseSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8oeCx5KTt9Y3R4LnN0cm9rZSgpOwogICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMuY29zdDtmb3IobGV0IG09MDttPDEyO20rKyl7Y29uc3QgaXRlbT1tYXAuZ2V0KG0pO2lmKCFpdGVtfHwhTnVtYmVyLmlzRmluaXRlKGl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gpKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLWl0ZW0ud2VpZ2h0ZWRBdmVyYWdlQ3RQZXJLV2gvbWF4KTtjdHguYmVnaW5QYXRoKCk7Y3R4LmFyYyh4LHksMy4yLDAsTWF0aC5QSSoyKTtjdHguZmlsbCgpO2N0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7Y3R4LmZvbnQ9JzEwcHggLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsU2Vnb2UgVUksc2Fucy1zZXJpZic7Y3R4LmZpbGxUZXh0KG51bShpdGVtLndlaWdodGVkQXZlcmFnZUN0UGVyS1doLDEpLHgtMTAsTWF0aC5tYXgoMTAseS04KSk7Y3R4LmZpbGxTdHlsZT1DT0xPUlMuY29zdDt9CiAgfQogIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hPc3Ryb21QcmljZVN0YXRzKHllYXIse3NpbGVudD1mYWxzZX09e30pewogICAgaWYob3N0cm9tUHJpY2VTdGF0c0J1c3kpcmV0dXJuIGZhbHNlO2lmKCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe2lmKCFzaWxlbnQpdG9hc3QoJ09zdHJvbSB6dWVyc3QgdmVyYmluZGVuJyk7cmV0dXJuIGZhbHNlO30KICAgIGNvbnN0IHk9TnVtYmVyKHllYXIpO2lmKCFOdW1iZXIuaXNJbnRlZ2VyKHkpfHx5PDIwMjB8fHk+bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpKXtpZighc2lsZW50KXRvYXN0KCdVbmfDvGx0aWdlcyBKYWhyJyk7cmV0dXJuIGZhbHNlO30KICAgIGNvbnN0IG5vdz1uZXcgRGF0ZSgpLGxhc3RNb250aD15PT09bm93LmdldEZ1bGxZZWFyKCk/bm93LmdldE1vbnRoKCkrMToxMjtvc3Ryb21QcmljZVN0YXRzQnVzeT10cnVlO3JlbmRlck9zdHJvbVByaWNlU3RhdHMoeSk7CiAgICBsZXQgdXBkYXRlZD0wLHVuYXZhaWxhYmxlPTA7Y29uc3QgcmVjb3JkTWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgdHJ5ewogICAgICBmb3IobGV0IG09MTttPD1sYXN0TW9udGg7bSsrKXsKICAgICAgICBjb25zdCBtb250aD1gJHt5fS0ke1N0cmluZyhtKS5wYWRTdGFydCgyLCcwJyl9YDtpZighc2lsZW50KSQoJ29zdHJvbVByaWNlU3RhdHNTdGF0dXMnKS50ZXh0Q29udGVudD1gJHttb250aExhYmVsKG1vbnRoLGZhbHNlKX0gd2lyZCB2b24gT3N0cm9tIGdlbGFkZW4g4oCmICgke219LyR7bGFzdE1vbnRofSlgOwogICAgICAgIHRyeXsKICAgICAgICAgIGNvbnN0IGRhdGE9YXdhaXQgb3N0cm9tRmV0Y2goYC9hcGkvbW9udGg/bW9udGg9JHtlbmNvZGVVUklDb21wb25lbnQobW9udGgpfWApOwogICAgICAgICAgaWYoIWRhdGE/LmNvbXBsZXRlfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSl8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEudG90YWxLV2gpKXx8TnVtYmVyKGRhdGEudG90YWxLV2gpPD0wfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLnZhcmlhYmxlQ29zdEV1cikpKXt1bmF2YWlsYWJsZSsrO2NvbnRpbnVlO30KICAgICAgICAgIGNvbnN0IHBhcnRpYWw9bW9udGg9PT1jdXJyZW50TW9udGhLZXkoKTt1cHNlcnRPc3Ryb21QcmljZVN0YXQobW9udGgsZGF0YSx7cGFydGlhbH0pO3VwZGF0ZWQrKzsKICAgICAgICAgIGlmKCFwYXJ0aWFsJiZyZWNvcmRNYXAuaGFzKG1vbnRoKSl7Y29uc3QgaXRlbT1yZWNvcmRNYXAuZ2V0KG1vbnRoKSxzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7aXRlbS5wcmljZUN0PU51bWJlcihkYXRhLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKTtpdGVtLmJhc2VGZWU9TnVtYmVyKGRhdGEuZml4ZWRDb3N0RXVyKXx8MDtpdGVtLm9zdHJvbVZhcmlhYmxlQ29zdEV1cj1OdW1iZXIoZGF0YS52YXJpYWJsZUNvc3RFdXIpO2l0ZW0ub3N0cm9tVG90YWxDb3N0RXVyPU51bWJlcihkYXRhLnRvdGFsQ29zdEV1cik7aXRlbS5vc3Ryb21Db25zdW1wdGlvbktXaD1OdW1iZXIoZGF0YS50b3RhbEtXaCk7aXRlbS5vc3Ryb21QcmljZUNvbXBsZXRlPXRydWU7aXRlbS5wcmljZVNvdXJjZT0nb3N0cm9tLWhvdXJseS1jb25zdW1wdGlvbi13ZWlnaHRlZCc7aXRlbS5wcmljZVVwZGF0ZWRBdD1zdGFtcDtpdGVtLnVwZGF0ZWRBdD1zdGFtcDtyZWNvcmRNYXAuc2V0KG1vbnRoLGl0ZW0pO30KICAgICAgICB9Y2F0Y2h7dW5hdmFpbGFibGUrKzt9CiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZT0+c2V0VGltZW91dChyZXNvbHZlLDE0MCkpOwogICAgICB9CiAgICAgIGlmKHVwZGF0ZWQpc2F2ZVJlY29yZHMoWy4uLnJlY29yZE1hcC52YWx1ZXMoKV0se3JlYXNvbjpgT3N0cm9tLVByZWlzc3RhdGlzdGlrICR7eX0gYWt0dWFsaXNpZXJ0YH0pOwogICAgICByZW5kZXJBbGwoKTtpZighc2lsZW50KXRvYXN0KGAke3VwZGF0ZWR9IE9zdHJvbS1Nb25hdChlKSBmw7xyICR7eX0gYWt0dWFsaXNpZXJ0JHt1bmF2YWlsYWJsZT9gIMK3ICR7dW5hdmFpbGFibGV9IG5pY2h0IHZlcmbDvGdiYXJgOicnfWApO3JldHVybiB1cGRhdGVkPjA7CiAgICB9ZmluYWxseXtvc3Ryb21QcmljZVN0YXRzQnVzeT1mYWxzZTtyZW5kZXJPc3Ryb21QcmljZVN0YXRzKHkpO30KICB9CiAgZnVuY3Rpb24gYW5udWFsU3Vtcyhyb3dzKXsKICAgIHJldHVybiByb3dzLnJlZHVjZSgoYSxyKT0+eyBpZihOdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpYS50b3RhbCs9ci50b3RhbDsgaWYoTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApKWEuaGVhdCs9ci5oZWF0UHVtcDsgaWYoTnVtYmVyLmlzRmluaXRlKHIuYW5uZXgpKWEuYW5uZXgrPXIuYW5uZXg7IGNvbnN0IHJlc3Q9ZGVyaXZlZChyKTsgaWYoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0Pj0wKWEucmVzdCs9cmVzdDsgY29uc3QgY29zdD1yZWNvcmRDb3N0KHIpOyBpZihOdW1iZXIuaXNGaW5pdGUoY29zdCkpYS5jb3N0Kz1jb3N0OyBpZihOdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpYS5jb3VudCsrOyByZXR1cm4gYTsgfSx7dG90YWw6MCxoZWF0OjAsYW5uZXg6MCxyZXN0OjAsY29zdDowLGNvdW50OjB9KTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyQW5hbHlzaXMoKXsKICAgIGNvbnN0IHlzPXllYXJzKCk7CiAgICBjb25zdCB5ZWFyU2VsZWN0PSQoImFuYWx5c2lzWWVhciIpOwogICAgY29uc3QgcHJpb3I9TnVtYmVyKHllYXJTZWxlY3QudmFsdWUpOwogICAgY29uc3Qgc2VsZWN0ZWQ9eXMuaW5jbHVkZXMocHJpb3IpP3ByaW9yOih5c1swXXx8bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpKTsKICAgIHllYXJTZWxlY3QuaW5uZXJIVE1MPSh5cy5sZW5ndGg/eXM6W25ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKV0pLm1hcCh5PT5gPG9wdGlvbiB2YWx1ZT0iJHt5fSI+JHt5fTwvb3B0aW9uPmApLmpvaW4oIiIpOwogICAgeWVhclNlbGVjdC52YWx1ZT1TdHJpbmcoc2VsZWN0ZWQpOwogICAgY29uc3Qgcm93cz1hbmFseXNpc1llYXJSb3dzKHNlbGVjdGVkKSwgc3Vtcz1hbm51YWxTdW1zKHJvd3MpOwogICAgY29uc3QgcHJldmlvdXNZZWFyPXlzLmZpbHRlcih5PT55PHNlbGVjdGVkKS5zb3J0KChhLGIpPT5iLWEpWzBdfHxudWxsOwogICAgY29uc3QgcHJldmlvdXNSb3dzPXByZXZpb3VzWWVhcj9hbmFseXNpc1llYXJSb3dzKHByZXZpb3VzWWVhcik6W107CiAgICBjb25zdCBwcmV2aW91cz1hbm51YWxTdW1zKHByZXZpb3VzUm93cyk7CiAgICBjb25zdCB0b3RhbERlbHRhPXByZXZpb3VzLmNvdW50JiZwcmV2aW91cy50b3RhbD8oKHN1bXMudG90YWwtcHJldmlvdXMudG90YWwpL3ByZXZpb3VzLnRvdGFsKjEwMCk6bnVsbDsKICAgIGNvbnN0IGNvcFJvd3M9cm93cy5tYXAocmVjb3JkQ29wKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTsKICAgIGNvbnN0IGFubnVhbENvcD1yb3dzLnJlZHVjZSgoYSxyKT0+eyBpZihOdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCkmJk51bWJlci5pc0Zpbml0ZShyLmhlYXRHZW5lcmF0ZWQpKXthLmUrPXIuaGVhdFB1bXA7YS5oKz1yLmhlYXRHZW5lcmF0ZWQ7fSByZXR1cm4gYTt9LHtlOjAsaDowfSk7CiAgICBjb25zdCBleGFjdFByaWNlTW9udGhzPXJvd3MuZmlsdGVyKHI9PnIub3N0cm9tUHJpY2VDb21wbGV0ZSYmTnVtYmVyLmlzRmluaXRlKHIub3N0cm9tVG90YWxDb3N0RXVyKSkubGVuZ3RoOwogICAgY29uc3QgbWV0cmljcz1bCiAgICAgIFsiR2VzYW10IixgJHtudW0oc3Vtcy50b3RhbCwwKX0ga1doYCxOdW1iZXIuaXNGaW5pdGUodG90YWxEZWx0YSk/YCR7cGN0KHRvdGFsRGVsdGEpfSB6dSAke3ByZXZpb3VzWWVhcn1gOmAke3N1bXMuY291bnR9IE1vbmF0ZWBdLAogICAgICBbIlfDpHJtZXB1bXBlIixgJHtudW0oc3Vtcy5oZWF0LDApfSBrV2hgLHN1bXMudG90YWw/YCR7bnVtKHN1bXMuaGVhdC9zdW1zLnRvdGFsKjEwMCwxKX0gJWA6IuKAkyJdLAogICAgICBbIkFsdGVudGVpbCIsYCR7bnVtKHN1bXMuYW5uZXgsMCl9IGtXaGAsc3Vtcy50b3RhbD9gJHtudW0oc3Vtcy5hbm5leC9zdW1zLnRvdGFsKjEwMCwxKX0gJWA6IuKAkyJdLAogICAgICBbIlNjaGxlZS9LbHVzIixgJHtudW0oc3Vtcy5yZXN0LDApfSBrV2hgLHN1bXMudG90YWw/YCR7bnVtKHN1bXMucmVzdC9zdW1zLnRvdGFsKjEwMCwxKX0gJWA6IuKAkyJdLAogICAgICBbIktvc3RlbiIsZXVybyhzdW1zLmNvc3QpLGV4YWN0UHJpY2VNb250aHM/YCR7ZXhhY3RQcmljZU1vbnRoc30gTW9uYXQoZSkgbWl0IE9zdHJvbS1TdHVuZGVucHJlaXNlbmA6YW5udWFsQ29wLmU+MD9gV1AtQXJiZWl0c3phaGwgJHtudW0oYW5udWFsQ29wLmgvYW5udWFsQ29wLmUsMil9YDoiRmFsbGJhY2stUHJlaXNlIl0KICAgIF07CiAgICAkKCJhbmFseXNpc01ldHJpY3MiKS5pbm5lckhUTUw9bWV0cmljcy5tYXAoKFtsLHYsc10pPT5gPGFydGljbGU+PHNwYW4+JHtsfTwvc3Bhbj48c3Ryb25nPiR7dn08L3N0cm9uZz48c21hbGw+JHtzfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgJCgiYW5hbHlzaXNUYWJsZSIpLmlubmVySFRNTD1yb3dzLmxlbmd0aD9yb3dzLm1hcChyPT5gPHRyPjx0ZD4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChyLm1vbnRoLGZhbHNlKSl9PC90ZD48dGQ+JHtudW0oci50b3RhbCwxKX08L3RkPjx0ZD4ke251bShyLmhlYXRQdW1wLDEpfTwvdGQ+PHRkPiR7bnVtKHIuYW5uZXgsMSl9PC90ZD48dGQ+JHtudW0oZGVyaXZlZChyKSwxKX08L3RkPjx0ZD4ke2V1cm8ocmVjb3JkQ29zdChyKSl9JHtyLm9zdHJvbVByaWNlQ29tcGxldGU/IiAqIjoiIn08L3RkPjwvdHI+YCkuam9pbigiIik6Jzx0cj48dGQgY29sc3Bhbj0iNiI+S2VpbmUgTW9uYXRzZGF0ZW4gZsO8ciBkaWVzZXMgSmFoci48L3RkPjwvdHI+JzsKICAgICQoImNvcFBhbmVsIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhY29wUm93cy5sZW5ndGgpOwogICAgcmVuZGVyT3N0cm9tUHJpY2VTdGF0cyhzZWxlY3RlZCk7CiAgICBkcmF3QWxsb2NhdGlvbkNoYXJ0KHJvd3MpOyBkcmF3VG90YWxDaGFydEFsbFllYXJzKHlzKTsgZHJhd0Nvc3RDaGFydChyb3dzKTsgaWYoY29wUm93cy5sZW5ndGgpZHJhd0NvcENoYXJ0KHJvd3MpOwogIH0KCiAgZnVuY3Rpb24gY2FudmFzU2V0dXAoY2FudmFzKXsKICAgIGlmKCFjYW52YXMpcmV0dXJuIG51bGw7CiAgICBjb25zdCByZWN0PWNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsgY29uc3QgZHByPU1hdGgubWluKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvfHwxLDIpOyBjb25zdCB3aWR0aD1NYXRoLm1heCgyODAsTWF0aC5yb3VuZChyZWN0LndpZHRofHw2MDApKTsgY29uc3QgaGVpZ2h0PU1hdGgubWF4KDE4MCxNYXRoLnJvdW5kKHJlY3QuaGVpZ2h0fHwyNjApKTsKICAgIGNhbnZhcy53aWR0aD1NYXRoLnJvdW5kKHdpZHRoKmRwcik7IGNhbnZhcy5oZWlnaHQ9TWF0aC5yb3VuZChoZWlnaHQqZHByKTsgY29uc3QgY3R4PWNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOyBjdHguc2V0VHJhbnNmb3JtKGRwciwwLDAsZHByLDAsMCk7IGN0eC5jbGVhclJlY3QoMCwwLHdpZHRoLGhlaWdodCk7IHJldHVybiB7Y3R4LHdpZHRoLGhlaWdodH07CiAgfQogIGZ1bmN0aW9uIGRyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LHRleHQ9IktlaW5lIERhdGVuIil7CiAgICBjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0OyBjdHguZm9udD0iMTNweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjsgY3R4LnRleHRBbGlnbj0iY2VudGVyIjsgY3R4LmZpbGxUZXh0KHRleHQsd2lkdGgvMixoZWlnaHQvMik7IGN0eC50ZXh0QWxpZ249ImxlZnQiOwogIH0KICBmdW5jdGlvbiBjaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LGxhYmVscyx7bGVmdD00OCxib3R0b209MzQsdG9wPTE1LHJpZ2h0PTEyfT17fSl7CiAgICBjb25zdCBwbG90Vz13aWR0aC1sZWZ0LXJpZ2h0LCBwbG90SD1oZWlnaHQtdG9wLWJvdHRvbTsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuZ3JpZDsgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDsgY3R4LmZvbnQ9IjEwcHggLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsU2Vnb2UgVUksc2Fucy1zZXJpZiI7IGN0eC5saW5lV2lkdGg9MTsKICAgIGZvcihsZXQgaT0wO2k8PTQ7aSsrKXsgY29uc3QgeT10b3ArcGxvdEgqaS80OyBjdHguYmVnaW5QYXRoKCk7Y3R4Lm1vdmVUbyhsZWZ0LHkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseSk7Y3R4LnN0cm9rZSgpOyBjb25zdCB2YWw9bWF4KigxLWkvNCk7Y3R4LmZpbGxUZXh0KG51bSh2YWwsMCksNCx5KzMpOyB9CiAgICBpZihsYWJlbHM/Lmxlbmd0aCl7IGxhYmVscy5mb3JFYWNoKChsYWJlbCxpKT0+eyBjb25zdCB4PWxlZnQrKGxhYmVscy5sZW5ndGg9PT0xP3Bsb3RXLzI6cGxvdFcqaS8obGFiZWxzLmxlbmd0aC0xKSk7IGN0eC5maWxsVGV4dChsYWJlbCx4LTEwLGhlaWdodC0xMCk7IH0pOyB9CiAgICByZXR1cm4ge2xlZnQscmlnaHQsdG9wLGJvdHRvbSxwbG90VyxwbG90SH07CiAgfQogIGZ1bmN0aW9uIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCByb3dzPXNvcnRlZCgpLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpLnNsaWNlKC0xMik7IGlmKCFyb3dzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4ucm93cy5tYXAocj0+ci50b3RhbCkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgscm93cy5tYXAocj0+TU9OVEhTW051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTFdKSx7fSk7CiAgICBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLnRvdGFsO2N0eC5saW5lV2lkdGg9Mi41O2N0eC5iZWdpblBhdGgoKTtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PWZyYW1lLmxlZnQrKHJvd3MubGVuZ3RoPT09MT9mcmFtZS5wbG90Vy8yOmZyYW1lLnBsb3RXKmkvKHJvd3MubGVuZ3RoLTEpKTtjb25zdCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1yLnRvdGFsL21heCk7aT9jdHgubGluZVRvKHgseSk6Y3R4Lm1vdmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLnRvdGFsO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9ZnJhbWUubGVmdCsocm93cy5sZW5ndGg9PT0xP2ZyYW1lLnBsb3RXLzI6ZnJhbWUucGxvdFcqaS8ocm93cy5sZW5ndGgtMSkpO2NvbnN0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXIudG90YWwvbWF4KTtjdHguYmVnaW5QYXRoKCk7Y3R4LmFyYyh4LHksMywwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0FsbG9jYXRpb25DaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiYWxsb2NhdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxpZD1yb3dzLmZpbHRlcihyPT5bci5oZWF0UHVtcCxyLmFubmV4LHIudG90YWxdLnNvbWUoTnVtYmVyLmlzRmluaXRlKSk7IGlmKCF2YWxpZC5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbGlkLm1hcChyPT5NYXRoLm1heCgwLE51bWJlcihyLnRvdGFsKXx8KChOdW1iZXIoci5oZWF0UHVtcCl8fDApKyhOdW1iZXIoci5hbm5leCl8fDApKyhNYXRoLm1heCgwLGRlcml2ZWQocikpfHwwKSkpKSkqMS4xfHwxOyBjb25zdCBsYWJlbHM9dmFsaWQubWFwKHI9Pk1PTlRIU1tOdW1iZXIoci5tb250aC5zbGljZSg1LDcpKS0xXSk7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsbGFiZWxzLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy92YWxpZC5sZW5ndGgsIGJhclc9TWF0aC5taW4oMzgsc2xvdCouNjIpOwogICAgdmFsaWQuZm9yRWFjaCgocixpKT0+eyBjb25zdCB4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzI7IGxldCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SDsgY29uc3QgcGFydHM9W1tNYXRoLm1heCgwLE51bWJlcihyLmhlYXRQdW1wKXx8MCksQ09MT1JTLmhlYXRdLFtNYXRoLm1heCgwLE51bWJlcihyLmFubmV4KXx8MCksQ09MT1JTLmFubmV4XSxbTWF0aC5tYXgoMCxkZXJpdmVkKHIpfHwwKSxDT0xPUlMucmVzdF1dOyBmb3IoY29uc3QgW3YsY29sb3JdIG9mIHBhcnRzKXtjb25zdCBoPWZyYW1lLnBsb3RIKnYvbWF4O3ktPWg7Y3R4LmZpbGxTdHlsZT1jb2xvcjtjdHguZmlsbFJlY3QoeCx5LGJhclcsaCk7fSB9KTsKICB9CiAgZnVuY3Rpb24geWVhckNvbG9yKHllYXIseWVhcnNBc2MpewogICAgY29uc3QgaW5kZXg9TWF0aC5tYXgoMCx5ZWFyc0FzYy5pbmRleE9mKHllYXIpKTsKICAgIHJldHVybiBZRUFSX0NPTE9SU1tpbmRleCVZRUFSX0NPTE9SUy5sZW5ndGhdOwogIH0KICBmdW5jdGlvbiBkcmF3VG90YWxDaGFydEFsbFllYXJzKHllYXJMaXN0KXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgidG90YWxDaGFydCIpKTsgaWYoIWMpcmV0dXJuOwogICAgY29uc3QgeWVhcnNBc2M9Wy4uLnllYXJMaXN0XS5zb3J0KChhLGIpPT5hLWIpOwogICAgY29uc3Qgc2VyaWVzPXllYXJzQXNjLm1hcCh5ZWFyPT4oe3llYXIscm93czphbmFseXNpc1llYXJSb3dzKHllYXIpfSkpLmZpbHRlcihzPT5zLnJvd3Muc29tZShyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpKTsKICAgIGNvbnN0IHZhbHM9c2VyaWVzLmZsYXRNYXAocz0+cy5yb3dzKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKTsKICAgIGlmKCF2YWxzLmxlbmd0aCl7ZHJhd0VtcHR5KGMuY3R4LGMud2lkdGgsYy5oZWlnaHQpOyQoInllYXJDb21wYXJpc29uTGVnZW5kIikuaW5uZXJIVE1MPSIiO3JldHVybjt9CiAgICBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMubWFwKHI9PnIudG90YWwpKSoxLjEyfHwxOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7CiAgICBjb25zdCBjdXJyZW50WWVhcj1uZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCk7CiAgICAkKCJ5ZWFyQ29tcGFyaXNvbkxlZ2VuZCIpLmlubmVySFRNTD1zZXJpZXMubWFwKGl0ZW09Pntjb25zdCBjb2xvcj15ZWFyQ29sb3IoaXRlbS55ZWFyLHllYXJzQXNjKTtjb25zdCBwYXN0PWl0ZW0ueWVhciE9PWN1cnJlbnRZZWFyO3JldHVybiBgPHNwYW4gY2xhc3M9IiR7cGFzdD8icGFzdCI6ImN1cnJlbnQifSIgc3R5bGU9ImNvbG9yOiR7Y29sb3J9Ij48aT48L2k+JHtpdGVtLnllYXJ9JHtwYXN0PyIiOiIgwrcgYWt0dWVsbCJ9PC9zcGFuPmA7fSkuam9pbigiIik7CiAgICBmb3IoY29uc3QgaXRlbSBvZiBzZXJpZXMpewogICAgICBjb25zdCBjb2xvcj15ZWFyQ29sb3IoaXRlbS55ZWFyLHllYXJzQXNjKSxkYXNoZWQ9aXRlbS55ZWFyIT09Y3VycmVudFllYXI7CiAgICAgIGNvbnN0IG1hcD1uZXcgTWFwKGl0ZW0ucm93cy5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKS5tYXAocj0+W051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTEsci50b3RhbF0pKTsKICAgICAgY3R4LnN0cm9rZVN0eWxlPWNvbG9yO2N0eC5saW5lV2lkdGg9ZGFzaGVkPzIuMjozO2N0eC5zZXRMaW5lRGFzaChkYXNoZWQ/WzcsNV06W10pO2N0eC5iZWdpblBhdGgoKTtsZXQgc3RhcnRlZD1mYWxzZTsKICAgICAgZm9yKGxldCBtPTA7bTwxMjttKyspe2lmKCFtYXAuaGFzKG0pKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLW1hcC5nZXQobSkvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fQogICAgICBjdHguc3Ryb2tlKCk7Y3R4LnNldExpbmVEYXNoKFtdKTsKICAgICAgY3R4LmZpbGxTdHlsZT1jb2xvcjtmb3IobGV0IG09MDttPDEyO20rKyl7aWYoIW1hcC5oYXMobSkpY29udGludWU7Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKm0vMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtbWFwLmdldChtKS9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSxkYXNoZWQ/Mi4yOjMuMiwwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBkcmF3Q29zdENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3N0Q2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbHM9cm93cy5tYXAocj0+cmVjb3JkQ29zdChyKSk7IGlmKCF2YWxzLnNvbWUoTnVtYmVyLmlzRmluaXRlKSl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsIktlaW5lIEtvc3RlbmRhdGVuIik7cmV0dXJuO30gY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy8xMixiYXJXPU1hdGgubWluKDM4LHNsb3QqLjYyKTsgdmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgaD1mcmFtZS5wbG90SCp2L21heCx4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzIseT1mcmFtZS50b3ArZnJhbWUucGxvdEgtaDtjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O2N0eC5maWxsUmVjdCh4LHksYmFyVyxoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0NvcENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3BDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgdmFscz1yb3dzLm1hcChyZWNvcmRDb3ApOyBpZighdmFscy5zb21lKE51bWJlci5pc0Zpbml0ZSkpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fSBjb25zdCBtYXg9TWF0aC5tYXgoNSwuLi52YWxzLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKSoxLjA1OyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7IGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuaGVhdDtjdHgubGluZVdpZHRoPTIuNDtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7dmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKmkvMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtdi9tYXgpO2lmKCFzdGFydGVkKXtjdHgubW92ZVRvKHgseSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRlclBhbmVsKCl7CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighbGF0ZXN0KXJldHVybjsKICAgICQoIm1ldGVyTGF0ZXN0IikuaW5uZXJIVE1MPWA8YXJ0aWNsZT48c3Bhbj5TdGFuZCB2b208L3NwYW4+PHN0cm9uZz4ke2RhdGVMYWJlbChsYXRlc3QuZGF0ZSl9PC9zdHJvbmc+PHNtYWxsPmxldHp0ZSBBYmxlc3VuZzwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkdlc2FtdDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC50b3RhbCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkFsdGVudGVpbDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC5hbm5leCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPmA7CiAgICAkKCJtZXRlckhpc3RvcnkiKS5pbm5lckhUTUw9bWV0ZXJSZWFkaW5ncy5zbGljZSgpLnJldmVyc2UoKS5zbGljZSgwLDgpLm1hcCgocixpKT0+YDxkaXYgY2xhc3M9Im1ldGVyLWhpc3Rvcnktcm93Ij48c3Bhbj4ke2RhdGVMYWJlbChyLmRhdGUpfTwvc3Bhbj48c3Ryb25nPkdlc2FtdCAke251bShyLnRvdGFsLDApfTwvc3Ryb25nPjxzdHJvbmc+QWx0ZW50ZWlsICR7bnVtKHIuYW5uZXgsMCl9PC9zdHJvbmc+JHtpPT09bWV0ZXJSZWFkaW5ncy5sZW5ndGgtMT8nPHNtYWxsPlN0YXJ0d2VydDwvc21hbGw+JzonJ308L2Rpdj5gKS5qb2luKCIiKTsKICAgICQoInVuZG9MYXRlc3RNZXRlckJ0biIpLmRpc2FibGVkPW1ldGVyUmVhZGluZ3MubGVuZ3RoPD0xOwogIH0KICBmdW5jdGlvbiByZW5kZXJEYXRhKCl7CiAgICBjb25zdCBpc3N1ZXM9W107IGxldCBjb21wbGV0ZUNvdW50PTA7CiAgICBmb3IoY29uc3QgciBvZiByZWNvcmRzKXsKICAgICAgY29uc3QgbWlzc2luZz1bXTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSltaXNzaW5nLnB1c2goIkdlc2FtdCIpOyBpZighTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApKW1pc3NpbmcucHVzaCgiV8Okcm1lcHVtcGUiKTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLmFubmV4KSltaXNzaW5nLnB1c2goIkFsdGVudGVpbCIpOyBjb25zdCByZXN0PWRlcml2ZWQocik7CiAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwKWlzc3Vlcy5wdXNoKHtsZXZlbDoiZXJyb3IiLG1vbnRoOnIubW9udGgsdGl0bGU6IkF1ZnRlaWx1bmcgdW5wbGF1c2liZWwiLGRldGFpbDpgU2NobGVlL0tsdXMgZXJnaWJ0ICR7bnVtKHJlc3QsMSl9IGtXaC5gfSk7CiAgICAgIGVsc2UgaWYobWlzc2luZy5sZW5ndGgpaXNzdWVzLnB1c2goe2xldmVsOiJ3YXJuaW5nIixtb250aDpyLm1vbnRoLHRpdGxlOiJNb25hdCB1bnZvbGxzdMOkbmRpZyIsZGV0YWlsOmBGZWhsdDogJHttaXNzaW5nLmpvaW4oIiwgIil9YH0pOwogICAgICBlbHNlIGNvbXBsZXRlQ291bnQrKzsKICAgIH0KICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RSZWNvcmQoKTsKICAgIGNvbnN0IHE9WwogICAgICBbIk1vbmF0ZSIsU3RyaW5nKHJlY29yZHMubGVuZ3RoKSwiZ2VzcGVpY2hlcnQiXSwKICAgICAgWyJWb2xsc3TDpG5kaWciLFN0cmluZyhjb21wbGV0ZUNvdW50KSxyZWNvcmRzLmxlbmd0aD9gJHtudW0oY29tcGxldGVDb3VudC9yZWNvcmRzLmxlbmd0aCoxMDAsMCl9ICVgOiLigJMiXSwKICAgICAgWyJIaW53ZWlzZSIsU3RyaW5nKGlzc3Vlcy5sZW5ndGgpLGlzc3Vlcy5zb21lKGk9PmkubGV2ZWw9PT0iZXJyb3IiKT8ibWluZC4gMSBGZWhsZXIiOiJwcsO8ZmVuIl0sCiAgICAgIFsiTGV0enRlciBNb25hdCIsbGF0ZXN0P21vbnRoTGFiZWwobGF0ZXN0Lm1vbnRoLGZhbHNlKToi4oCTIiwiYXV0b21hdGlzY2ggYmVyZWNobmV0Il0KICAgIF07CiAgICAkKCJxdWFsaXR5TWV0cmljcyIpLmlubmVySFRNTD1xLm1hcCgoW2wsdixzXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2x9PC9zcGFuPjxzdHJvbmc+JHt2fTwvc3Ryb25nPjxzbWFsbD4ke3N9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbigiIik7CiAgICAkKCJxdWFsaXR5SXNzdWVzIikuaW5uZXJIVE1MPWlzc3Vlcy5sZW5ndGg/aXNzdWVzLnNsaWNlKCkucmV2ZXJzZSgpLnNsaWNlKDAsMTYpLm1hcChpPT5gPGFydGljbGUgY2xhc3M9Imlzc3VlICR7aS5sZXZlbH0iPjxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChpLm1vbnRoKSl9OiAke2VzY2FwZUh0bWwoaS50aXRsZSl9PC9zdHJvbmc+PHNtYWxsPiR7ZXNjYXBlSHRtbChpLmRldGFpbCl9PC9zbWFsbD48L2Rpdj48L2FydGljbGU+YCkuam9pbigiIik6JzxhcnRpY2xlIGNsYXNzPSJpc3N1ZSI+PGRpdj48c3Ryb25nPktlaW5lIEF1ZmbDpGxsaWdrZWl0ZW48L3N0cm9uZz48c21hbGw+QWxsZSBnZXNwZWljaGVydGVuIE1vbmF0ZSBzaW5kIHBsYXVzaWJlbCB1bmQgdm9sbHN0w6RuZGlnLjwvc21hbGw+PC9kaXY+PC9hcnRpY2xlPic7CiAgICByZW5kZXJNZXRlclBhbmVsKCk7CiAgICAkKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlPXNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiI7CiAgICAkKCJvc3Ryb21BdXRvUmVmcmVzaElucHV0IikuY2hlY2tlZD1zZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlOwogICAgJCgicHJlZmVycmVkV2luZG93SG91cnNJbnB1dCIpLnZhbHVlPVN0cmluZyhzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vyc3x8Myk7CiAgICAkKCJmYWxsYmFja1ByaWNlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMikudG9GaXhlZCgzKTsKICAgICQoImRlZmF1bHRCYXNlRmVlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApLnRvRml4ZWQoMik7CiAgICBjb25zdCBsYXN0QmFja3VwPWxvY2FsU3RvcmFnZS5nZXRJdGVtKExBU1RfQkFDS1VQX0tFWSk7ICQoImJhY2t1cFN0YXR1cyIpLnRleHRDb250ZW50PWxhc3RCYWNrdXA/YExldHp0ZXMgQmFja3VwOiAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2RhdGVTdHlsZToibWVkaXVtIix0aW1lU3R5bGU6InNob3J0In0pLmZvcm1hdChuZXcgRGF0ZShsYXN0QmFja3VwKSl9YDoiTm9jaCBrZWluIEJhY2t1cCBtaXQgRWxkZWhvZiA2LjIgZXJzdGVsbHQuIjsKICAgIGNvbnN0IGhpc3RvcnlTdGF0dXM9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShPU1RST01fSElTVE9SWV9LRVkpLG51bGwpOwogICAgaWYoJCgib3N0cm9tSGlzdG9yeVN0YXR1cyIpKSQoIm9zdHJvbUhpc3RvcnlTdGF0dXMiKS50ZXh0Q29udGVudD1vc3Ryb21IaXN0b3J5QnVzeT8iSGlzdG9yaXNjaGUgT3N0cm9tLVByZWlzZSB3ZXJkZW4gZ2VsYWRlbiDigKYiOmhpc3RvcnlTdGF0dXM/LnVwZGF0ZWRBdD9gUHJlaXNoaXN0b3JpZSB6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUoaGlzdG9yeVN0YXR1cy51cGRhdGVkQXQpfSDCtyAke2hpc3RvcnlTdGF0dXMudXBkYXRlZHx8MH0gTW9uYXQoZSkgZXhha3QgwrcgJHtoaXN0b3J5U3RhdHVzLnVuYXZhaWxhYmxlfHwwfSBuaWNodCB2ZXJmw7xnYmFyYDpgSGlzdG9yaXNjaGUgUHJlaXNlIG5vY2ggbmljaHQgZ2VwcsO8ZnQuYDsKICAgIHJlbmRlclN5bmNQYW5lbCgpOwogIH0KCiAgZnVuY3Rpb24gZG93bmxvYWRCbG9iKGNvbnRlbnQsZmlsZW5hbWUsdHlwZSl7IGNvbnN0IGJsb2I9bmV3IEJsb2IoW2NvbnRlbnRdLHt0eXBlfSk7IGNvbnN0IHVybD1VUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOyBjb25zdCBhPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImEiKTsgYS5ocmVmPXVybDthLmRvd25sb2FkPWZpbGVuYW1lO2RvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYSk7YS5jbGljaygpO2EucmVtb3ZlKCk7c2V0VGltZW91dCgoKT0+VVJMLnJldm9rZU9iamVjdFVSTCh1cmwpLDEwMDApOyB9CiAgZnVuY3Rpb24gZXhwb3J0QmFja3VwKCl7CiAgICBjb25zdCBub3c9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgY29uc3QgcmVsZXZhbnRTZXR0aW5ncz17ZmFsbGJhY2tQcmljZTpzZXR0aW5ncy5mYWxsYmFja1ByaWNlLGRlZmF1bHRCYXNlRmVlOnNldHRpbmdzLmRlZmF1bHRCYXNlRmVlLG9zdHJvbUFwcEtleTpzZXR0aW5ncy5vc3Ryb21BcHBLZXksb3N0cm9tQXV0b1JlZnJlc2g6c2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2gscHJlZmVycmVkV2luZG93SG91cnM6c2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnN9OwogICAgY29uc3QgcGF5bG9hZD17dmVyc2lvbjoiNi4yLjEiLGFwcDoiRWxkZWhvZiIscHVycG9zZToiUHJpdmF0ZXMgbG9rYWxlcyBCYWNrdXAg4oCTIG5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbiIsZXhwb3J0ZWRBdDpub3csc2V0dGluZ3M6cmVsZXZhbnRTZXR0aW5ncyxyZWNvcmRzLHZhaWxsYW50TW9udGhzLG1ldGVyUmVhZGluZ3Msb3N0cm9tUHJpY2VTdGF0c307CiAgICBkb3dubG9hZEJsb2IoSlNPTi5zdHJpbmdpZnkocGF5bG9hZCxudWxsLDIpLGBFbGRlaG9mX1BSSVZBVEVfQmFja3VwXyR7ZGF0ZVN0YW1wKCl9Lmpzb25gLCJhcHBsaWNhdGlvbi9qc29uIik7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKExBU1RfQkFDS1VQX0tFWSxub3cpOyByZW5kZXJEYXRhKCk7IHRvYXN0KCJQcml2YXRlcyBCYWNrdXAgZXJzdGVsbHQiKTsKICB9CiAgZnVuY3Rpb24gZXhwb3J0Q3N2KCl7CiAgICBjb25zdCByb3dzPVtbIk1vbmF0IiwiV8Okcm1lcHVtcGUga1doIiwiRXJ6ZXVndGUgV8Okcm1lIGtXaCIsIkFyYmVpdHN6YWhsIiwiQWx0ZW50ZWlsIGtXaCIsIlNjaGxlZS9LbHVzIGtXaCIsIkdlc2FtdCBrV2giLCJHZXNhbXQtWsOkaGxlcnN0YW5kIGtXaCIsIkFsdGVudGVpbC1aw6RobGVyc3RhbmQga1doIiwiQWJsZXNlZGF0dW0iLCJQcmVpcyBjdC9rV2giLCJGaXhrb3N0ZW4gRVVSIiwiS29zdGVuIEVVUiIsIlByZWlzcXVlbGxlIiwiT3N0cm9tLVZlcmJyYXVjaCBrV2giLCJOb3RpeiJdXTsKICAgIGZvcihjb25zdCByIG9mIHNvcnRlZCgpKXJvd3MucHVzaChbci5tb250aCxyLmhlYXRQdW1wPz8iIixyLmhlYXRHZW5lcmF0ZWQ/PyIiLHJlY29yZENvcChyKT8/IiIsci5hbm5leD8/IiIsZGVyaXZlZChyKT8/IiIsci50b3RhbD8/IiIsci50b3RhbE1ldGVyUmVhZGluZz8/IiIsci5hbm5leE1ldGVyUmVhZGluZz8/IiIsci5tZXRlclJlYWRpbmdEYXRlPz8iIixyLnByaWNlQ3Q/PyIiLHIuYmFzZUZlZT8/IiIscmVjb3JkQ29zdChyKT8/IiIsci5wcmljZVNvdXJjZXx8IiIsci5vc3Ryb21Db25zdW1wdGlvbktXaD8/IiIsci5ub3RlfHwiIl0pOwogICAgZG93bmxvYWRCbG9iKCJcdUZFRkYiK3Jvd3MubWFwKHJvdz0+cm93Lm1hcChjc3ZDZWxsKS5qb2luKCI7IikpLmpvaW4oIlxuIiksYEVsZGVob2ZfVmVyYnJhdWNoXyR7ZGF0ZVN0YW1wKCl9LmNzdmAsInRleHQvY3N2O2NoYXJzZXQ9dXRmLTgiKTsgdG9hc3QoIkNTViBlcnN0ZWxsdCIpOwogIH0KICBhc3luYyBmdW5jdGlvbiBpbXBvcnRCYWNrdXAoZmlsZSl7CiAgICB0cnl7CiAgICAgIGNvbnN0IHBheWxvYWQ9SlNPTi5wYXJzZShhd2FpdCBmaWxlLnRleHQoKSk7IGNvbnN0IGluY29taW5nPUFycmF5LmlzQXJyYXkocGF5bG9hZCk/cGF5bG9hZDooQXJyYXkuaXNBcnJheShwYXlsb2FkLnJlY29yZHMpP3BheWxvYWQucmVjb3JkczpwYXlsb2FkLmRhdGEpOyBpZighQXJyYXkuaXNBcnJheShpbmNvbWluZykpdGhyb3cgbmV3IEVycm9yKCJLZWluZSBNb25hdHNkYXRlbiBnZWZ1bmRlbi4iKTsKICAgICAgY29uc3QgY2xlYW5lZD1zYW5pdGl6ZVJlY29yZHMoaW5jb21pbmcpOyBpZighY2xlYW5lZC5sZW5ndGgmJiFjb25maXJtKCJEYXMgQmFja3VwIGVudGjDpGx0IGtlaW5lIE1vbmF0c3dlcnRlLiBMZWVyZW4gQmVzdGFuZCB3aXJrbGljaCBpbXBvcnRpZXJlbj8iKSlyZXR1cm47CiAgICAgIGlmKCFjb25maXJtKGAke2NsZWFuZWQubGVuZ3RofSBNb25hdHN3ZXJ0ZSBhdXMgZGVtIEJhY2t1cCDDvGJlcm5laG1lbj8gRGVyIGFrdHVlbGxlIFN0YW5kIHdpcmQgdm9yaGVyIGxva2FsIGdlc2ljaGVydC5gKSlyZXR1cm47CiAgICAgIGNvbnN0IGltcG9ydFN0YW1wPW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgICAgc2F2ZVJlY29yZHMoY2xlYW5lZC5tYXAocj0+KHsuLi5yLHVwZGF0ZWRBdDppbXBvcnRTdGFtcH0pKSx7cmVhc29uOiJCYWNrdXAgaW1wb3J0aWVydCIsYWxsb3dFbXB0eTp0cnVlfSk7CiAgICAgIGlmKHBheWxvYWQuc2V0dGluZ3MmJnR5cGVvZiBwYXlsb2FkLnNldHRpbmdzPT09Im9iamVjdCIpewogICAgICAgIHNldHRpbmdzPXsuLi5zZXR0aW5ncywuLi5wYXlsb2FkLnNldHRpbmdzfTsKICAgICAgICBpZihOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHBheWxvYWQuc2V0dGluZ3MucHJpY2UpKSYmIU51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5mYWxsYmFja1ByaWNlKSkpc2V0dGluZ3MuZmFsbGJhY2tQcmljZT1OdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5wcmljZSk7CiAgICAgICAgc2F2ZVNldHRpbmdzKCk7CiAgICAgIH0KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLnZhaWxsYW50TW9udGhzKSl7IHZhaWxsYW50TW9udGhzPXBheWxvYWQudmFpbGxhbnRNb250aHMubWFwKHY9Pih7Li4udix1cGRhdGVkQXQ6aW1wb3J0U3RhbXB9KSk7IHNhdmVWYWlsbGFudE1vbnRocygpOyB9CiAgICAgIGlmKEFycmF5LmlzQXJyYXkocGF5bG9hZC5tZXRlclJlYWRpbmdzKSl7c2F2ZU1ldGVyUmVhZGluZ3MocGF5bG9hZC5tZXRlclJlYWRpbmdzKTt9ZWxzZXttZXRlclJlYWRpbmdzPWxvYWRNZXRlclJlYWRpbmdzKCk7ZW5zdXJlTWV0ZXJCYXNlbGluZSgpO30KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLm9zdHJvbVByaWNlU3RhdHMpKXNhdmVPc3Ryb21QcmljZVN0YXRzKHBheWxvYWQub3N0cm9tUHJpY2VTdGF0cyk7CiAgICAgIHJlbmRlckFsbCgpOyB0b2FzdCgiQmFja3VwIGltcG9ydGllcnQiKTsKICAgIH1jYXRjaChlcnJvcil7IGFsZXJ0KGBCYWNrdXAga29ubnRlIG5pY2h0IGltcG9ydGllcnQgd2VyZGVuOiAke2Vycm9yLm1lc3NhZ2V9YCk7IH0KICAgIGZpbmFsbHl7ICQoImltcG9ydEJhY2t1cElucHV0IikudmFsdWU9IiI7IH0KICB9CgoKICAvKiBFbGRlaG9mIDYuMC4xIOKAkyBzY2hsYW5rZXIgbG9rYWxlciBteVZBSUxMQU5ULUNTVi1JbXBvcnQgKi8KICBmdW5jdGlvbiB2YWlsbGFudENzdk51bWJlcih2YWx1ZSl7CiAgICBjb25zdCB0ZXh0PVN0cmluZyh2YWx1ZT8/IiIpLnRyaW0oKTsKICAgIGlmKCF0ZXh0KXJldHVybiBudWxsOwogICAgY29uc3Qgbm9ybWFsaXplZD10ZXh0LmluY2x1ZGVzKCIsIikmJnRleHQuaW5jbHVkZXMoIi4iKQogICAgICA/dGV4dC5sYXN0SW5kZXhPZigiLCIpPnRleHQubGFzdEluZGV4T2YoIi4iKQogICAgICAgID90ZXh0LnJlcGxhY2UoL1wuL2csIiIpLnJlcGxhY2UoIiwiLCIuIikKICAgICAgICA6dGV4dC5yZXBsYWNlKC8sL2csIiIpCiAgICAgIDp0ZXh0LnJlcGxhY2UoIiwiLCIuIik7CiAgICBjb25zdCBudW1iZXI9TnVtYmVyKG5vcm1hbGl6ZWQpOwogICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShudW1iZXIpP251bWJlcjpudWxsOwogIH0KICBmdW5jdGlvbiB2YWlsbGFudENzdkRhdGVQYXJ0cyh2YWx1ZSl7CiAgICBjb25zdCBtYXRjaD0vXihcZHs0fSktKFxkezJ9KS0oXGR7Mn0pKD86WyBUXShcZHsyfSk6KFxkezJ9KTooXGR7Mn0pKT8kLy5leGVjKFN0cmluZyh2YWx1ZXx8IiIpLnRyaW0oKSk7CiAgICBpZighbWF0Y2gpcmV0dXJuIG51bGw7CiAgICBjb25zdCB5ZWFyPU51bWJlcihtYXRjaFsxXSksbW9udGg9TnVtYmVyKG1hdGNoWzJdKSxkYXk9TnVtYmVyKG1hdGNoWzNdKTsKICAgIGNvbnN0IGRhdGU9bmV3IERhdGUoRGF0ZS5VVEMoeWVhcixtb250aC0xLGRheSkpOwogICAgaWYoZGF0ZS5nZXRVVENGdWxsWWVhcigpIT09eWVhcnx8ZGF0ZS5nZXRVVENNb250aCgpIT09bW9udGgtMXx8ZGF0ZS5nZXRVVENEYXRlKCkhPT1kYXkpcmV0dXJuIG51bGw7CiAgICByZXR1cm4ge3llYXIsbW9udGgsZGF5LGRhdGVLZXk6YCR7bWF0Y2hbMV19LSR7bWF0Y2hbMl19LSR7bWF0Y2hbM119YCxtb250aEtleTpgJHttYXRjaFsxXX0tJHttYXRjaFsyXX1gLGRhdGVUaW1lOlN0cmluZyh2YWx1ZXx8IiIpLnRyaW0oKX07CiAgfQogIGZ1bmN0aW9uIGRldGVjdFZhaWxsYW50Q3N2VHlwZShoZWFkZXJzKXsKICAgIGNvbnN0IGZpZWxkcz1uZXcgU2V0KGhlYWRlcnMpLGhhcz1uYW1lPT5maWVsZHMuaGFzKG5hbWUpOwogICAgaWYoaGFzKCJEYXRlVGltZSIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikmJmhhcygiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkRvbWVzdGljSG90V2F0ZXIiKSYmaGFzKCJIZWF0R2VuZXJhdGVkOkhlYXRpbmciKSYmaGFzKCJIZWF0R2VuZXJhdGVkOkRvbWVzdGljSG90V2F0ZXIiKSlyZXR1cm4gImFyb3RoZXJtLWVuZXJneSI7CiAgICBpZihoYXMoIkRhdGVUaW1lIikmJmhhcygiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKSYmaGFzKCJIZWF0R2VuZXJhdGVkOkhlYXRpbmciKSYmIWhhcygiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkRvbWVzdGljSG90V2F0ZXIiKSlyZXR1cm4gInVuaXRvd2VyLWVuZXJneSI7CiAgICByZXR1cm4gInVua25vd24iOwogIH0KICBmdW5jdGlvbiBwYXJzZVZhaWxsYW50Q3N2VGV4dCh0ZXh0LGluZGV4PTApewogICAgY29uc3Qgbm9ybWFsaXplZD1TdHJpbmcodGV4dHx8IiIpLnJlcGxhY2UoL15cdUZFRkYvLCIiKS5yZXBsYWNlKC9cclxuPy9nLCJcbiIpOwogICAgY29uc3QgZGF0YUxpbmVzPW5vcm1hbGl6ZWQuc3BsaXQoIlxuIikuZmlsdGVyKGxpbmU9Pntjb25zdCB0PWxpbmUudHJpbSgpO3JldHVybiB0JiYhdC5zdGFydHNXaXRoKCIjIik7fSk7CiAgICBpZighZGF0YUxpbmVzLmxlbmd0aClyZXR1cm4ge2luZGV4LHR5cGU6InVua25vd24iLHJvd3M6W10saW52YWxpZFJvd3M6MH07CiAgICBjb25zdCBkZWxpbWl0ZXI9ZGF0YUxpbmVzWzBdLmluY2x1ZGVzKCI7Iik/IjsiOiIsIjsKICAgIGNvbnN0IGhlYWRlcnM9ZGF0YUxpbmVzWzBdLnNwbGl0KGRlbGltaXRlcikubWFwKHY9PnYudHJpbSgpKTsKICAgIGNvbnN0IHR5cGU9ZGV0ZWN0VmFpbGxhbnRDc3ZUeXBlKGhlYWRlcnMpLHJvd3M9W107bGV0IGludmFsaWRSb3dzPTA7CiAgICBmb3IoY29uc3QgbGluZSBvZiBkYXRhTGluZXMuc2xpY2UoMSkpewogICAgICBpZighbGluZS50cmltKCkpY29udGludWU7CiAgICAgIGNvbnN0IHZhbHVlcz1saW5lLnNwbGl0KGRlbGltaXRlcik7CiAgICAgIGNvbnN0IHJhdz1PYmplY3QuZnJvbUVudHJpZXMoaGVhZGVycy5tYXAoKGhlYWRlcixjb2x1bW4pPT5baGVhZGVyLHZhbHVlc1tjb2x1bW5dPz8iIl0pKTsKICAgICAgY29uc3QgZGF0ZT12YWlsbGFudENzdkRhdGVQYXJ0cyhyYXcuRGF0ZVRpbWUpO2lmKCFkYXRlKXtpbnZhbGlkUm93cysrO2NvbnRpbnVlO30KICAgICAgY29uc3QgcGFyc2VkPXsuLi5kYXRlLHZhbHVlczp7fX07CiAgICAgIGZvcihjb25zdCBoZWFkZXIgb2YgaGVhZGVycyl7aWYoaGVhZGVyIT09IkRhdGVUaW1lIilwYXJzZWQudmFsdWVzW2hlYWRlcl09dmFpbGxhbnRDc3ZOdW1iZXIocmF3W2hlYWRlcl0pO30KICAgICAgcm93cy5wdXNoKHBhcnNlZCk7CiAgICB9CiAgICByZXR1cm4ge2luZGV4LHR5cGUsaGVhZGVycyxyb3dzLGludmFsaWRSb3dzfTsKICB9CiAgZnVuY3Rpb24gc2FtZVZhaWxsYW50VmFsdWUoYSxiLHRvbGVyYW5jZT0uMDUpewogICAgaWYoYT09bnVsbHx8Yj09bnVsbClyZXR1cm4gYT09bnVsbCYmYj09bnVsbDsKICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGEpKSYmTnVtYmVyLmlzRmluaXRlKE51bWJlcihiKSk/TWF0aC5hYnMoTnVtYmVyKGEpLU51bWJlcihiKSk8PXRvbGVyYW5jZTpTdHJpbmcoYSk9PT1TdHJpbmcoYik7CiAgfQogIGZ1bmN0aW9uIGJ1aWxkVmFpbGxhbnRJbXBvcnRQcmV2aWV3KHBhcnNlZEZpbGVzKXsKICAgIGNvbnN0IGVuZXJneVR5cGVzPVsiYXJvdGhlcm0tZW5lcmd5IiwidW5pdG93ZXItZW5lcmd5Il07CiAgICBjb25zdCBkYWlseT17ImFyb3RoZXJtLWVuZXJneSI6bmV3IE1hcCgpLCJ1bml0b3dlci1lbmVyZ3kiOm5ldyBNYXAoKX07CiAgICBjb25zdCBjb25mbGljdE1vbnRocz1uZXcgU2V0KCk7bGV0IGR1cGxpY2F0ZVJvd3M9MDsKICAgIGZvcihjb25zdCBmaWxlIG9mIHBhcnNlZEZpbGVzLmZpbHRlcihmPT5lbmVyZ3lUeXBlcy5pbmNsdWRlcyhmLnR5cGUpKSl7CiAgICAgIGNvbnN0IHRhcmdldD1kYWlseVtmaWxlLnR5cGVdOwogICAgICBmb3IoY29uc3Qgcm93IG9mIGZpbGUucm93cyl7CiAgICAgICAgY29uc3QgZXhpc3Rpbmc9dGFyZ2V0LmdldChyb3cuZGF0ZUtleSk7CiAgICAgICAgaWYoIWV4aXN0aW5nKXt0YXJnZXQuc2V0KHJvdy5kYXRlS2V5LHJvdyk7Y29udGludWU7fQogICAgICAgIGNvbnN0IG1ldHJpY3M9bmV3IFNldChbLi4uT2JqZWN0LmtleXMoZXhpc3RpbmcudmFsdWVzfHx7fSksLi4uT2JqZWN0LmtleXMocm93LnZhbHVlc3x8e30pXSk7CiAgICAgICAgY29uc3QgZGlmZmVycz1bLi4ubWV0cmljc10uc29tZShtZXRyaWM9PiFzYW1lVmFpbGxhbnRWYWx1ZShleGlzdGluZy52YWx1ZXM/LlttZXRyaWNdLHJvdy52YWx1ZXM/LlttZXRyaWNdKSk7CiAgICAgICAgaWYoZGlmZmVycyljb25mbGljdE1vbnRocy5hZGQocm93Lm1vbnRoS2V5KTtlbHNlIGR1cGxpY2F0ZVJvd3MrKzsKICAgICAgfQogICAgfQogICAgY29uc3QgYWxsRGF0ZXM9Wy4uLm5ldyBTZXQoWy4uLmRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXS5rZXlzKCksLi4uZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLmtleXMoKV0pXTsKICAgIGNvbnN0IG1vbnRoS2V5cz1bLi4ubmV3IFNldChhbGxEYXRlcy5tYXAoZD0+ZC5zbGljZSgwLDcpKSldLnNvcnQoKTsKICAgIGNvbnN0IHN1bT0obWFwLGRhdGVzLG1ldHJpYyk9PmRhdGVzLnJlZHVjZSgocyxrZXkpPT57Y29uc3Qgdj1tYXAuZ2V0KGtleSk/LnZhbHVlcz8uW21ldHJpY107cmV0dXJuIHMrKE51bWJlci5pc0Zpbml0ZSh2KT92OjApO30sMCk7CiAgICBjb25zdCBmdWxsPShkYXRlcyx5LG0pPT57Y29uc3QgZXhwZWN0ZWQ9bmV3IERhdGUoeSxtLDApLmdldERhdGUoKSx1PVsuLi5uZXcgU2V0KGRhdGVzKV0uc29ydCgpO3JldHVybiB1Lmxlbmd0aD09PWV4cGVjdGVkJiZ1WzBdPT09YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwiMCIpfS0wMWAmJnUuYXQoLTEpPT09YCR7eX0tJHtTdHJpbmcobSkucGFkU3RhcnQoMiwiMCIpfS0ke1N0cmluZyhleHBlY3RlZCkucGFkU3RhcnQoMiwiMCIpfWA7fTsKICAgIGNvbnN0IGN1cnJlbnQ9Y3VycmVudE1vbnRoS2V5KCk7CiAgICBjb25zdCBtb250aHM9bW9udGhLZXlzLm1hcChtb250aD0+ewogICAgICBjb25zdCB5PU51bWJlcihtb250aC5zbGljZSgwLDQpKSxtPU51bWJlcihtb250aC5zbGljZSg1LDcpKTsKICAgICAgY29uc3QgYXJvPVsuLi5kYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0ua2V5cygpXS5maWx0ZXIoaz0+ay5zdGFydHNXaXRoKGAke21vbnRofS1gKSkuc29ydCgpOwogICAgICBjb25zdCB1bmk9Wy4uLmRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXS5rZXlzKCldLmZpbHRlcihrPT5rLnN0YXJ0c1dpdGgoYCR7bW9udGh9LWApKS5zb3J0KCk7CiAgICAgIGNvbnN0IHVuaW9uPVsuLi5uZXcgU2V0KFsuLi5hcm8sLi4udW5pXSldLnNvcnQoKTsKICAgICAgY29uc3QgY29tcGxldGU9ZnVsbChhcm8seSxtKSYmZnVsbCh1bmkseSxtKTsKICAgICAgY29uc3QgaGVhdGluZ0VsZWN0cmljaXR5PShzdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKStzdW0oZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLHVuaSwiQ29uc3VtZWRFbGVjdHJpY2FsRW5lcmd5OkhlYXRpbmciKSkvMTAwMDsKICAgICAgY29uc3QgZGh3RWxlY3RyaWNpdHk9c3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikvMTAwMDsKICAgICAgY29uc3QgaGVhdGluZ0hlYXQ9KHN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJIZWF0R2VuZXJhdGVkOkhlYXRpbmciKStzdW0oZGFpbHlbInVuaXRvd2VyLWVuZXJneSJdLHVuaSwiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikpLzEwMDA7CiAgICAgIGNvbnN0IGRod0hlYXQ9c3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkhlYXRHZW5lcmF0ZWQ6RG9tZXN0aWNIb3RXYXRlciIpLzEwMDA7CiAgICAgIGNvbnN0IGVsZWN0cmljaXR5S1doPWhlYXRpbmdFbGVjdHJpY2l0eStkaHdFbGVjdHJpY2l0eSxoZWF0R2VuZXJhdGVkS1doPWhlYXRpbmdIZWF0K2Rod0hlYXQ7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKG1vbnRoKTsKICAgICAgY29uc3QgbmVnYXRpdmVSZXN0PUJvb2xlYW4oZXhpc3RpbmcmJk51bWJlci5pc0Zpbml0ZShleGlzdGluZy50b3RhbCkmJk51bWJlci5pc0Zpbml0ZShleGlzdGluZy5hbm5leCkmJmV4aXN0aW5nLnRvdGFsLWVsZWN0cmljaXR5S1doLWV4aXN0aW5nLmFubmV4PC0uMDEpOwogICAgICBjb25zdCBoYXNDb25mbGljdD1jb25mbGljdE1vbnRocy5oYXMobW9udGgpLGhhc0JvdGg9YXJvLmxlbmd0aD4wJiZ1bmkubGVuZ3RoPjAsaXNDdXJyZW50PW1vbnRoPT09Y3VycmVudCxpc0Z1dHVyZT1tb250aD5jdXJyZW50OwogICAgICBjb25zdCBibG9ja2VkPSFoYXNCb3RofHxoYXNDb25mbGljdHx8bmVnYXRpdmVSZXN0fHxpc0Z1dHVyZXx8KCFjb21wbGV0ZSYmIWlzQ3VycmVudCk7CiAgICAgIHJldHVybiB7bW9udGgsZWxlY3RyaWNpdHlLV2gsaGVhdEdlbmVyYXRlZEtXaCxoZWF0aW5nRWxlY3RyaWNpdHlLV2g6aGVhdGluZ0VsZWN0cmljaXR5LGRod0VsZWN0cmljaXR5S1doOmRod0VsZWN0cmljaXR5LGhlYXRpbmdIZWF0S1doOmhlYXRpbmdIZWF0LGRod0hlYXRLV2g6ZGh3SGVhdCxjb21wbGV0ZSxjb3ZlcmFnZVN0YXJ0OnVuaW9uWzBdfHxudWxsLGNvdmVyYWdlRW5kOnVuaW9uLmF0KC0xKXx8bnVsbCxibG9ja2VkLGhhc0JvdGgsaGFzQ29uZmxpY3QsbmVnYXRpdmVSZXN0LGlzQ3VycmVudH07CiAgICB9KTsKICAgIHJldHVybiB7bW9udGhzLGR1cGxpY2F0ZVJvd3MscmVjb2duaXplZDpwYXJzZWRGaWxlcy5maWx0ZXIoZj0+Zi50eXBlIT09InVua25vd24iKS5sZW5ndGgsdW5rbm93bjpwYXJzZWRGaWxlcy5maWx0ZXIoZj0+Zi50eXBlPT09InVua25vd24iKS5sZW5ndGgsaW52YWxpZFJvd3M6cGFyc2VkRmlsZXMucmVkdWNlKChzLGYpPT5zK2YuaW52YWxpZFJvd3MsMCl9OwogIH0KICBmdW5jdGlvbiBtZXJnZVZhaWxsYW50SW1wb3J0KG1vbnRocyl7CiAgICBjb25zdCByZWNvcmRNYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICBjb25zdCB2YWlsbGFudE1hcD1uZXcgTWFwKCh2YWlsbGFudE1vbnRoc3x8W10pLm1hcCh2PT5bdi5tb250aCx7Li4udn1dKSk7CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7bGV0IGltcG9ydGVkPTAsY3JlYXRlZD0wLHBhcnRpYWw9MDsKICAgIGZvcihjb25zdCBtb250aCBvZiBtb250aHMuZmlsdGVyKG09PiFtLmJsb2NrZWQpKXsKICAgICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkTWFwLmdldChtb250aC5tb250aCl8fHNhbml0aXplUmVjb3JkKHttb250aDptb250aC5tb250aH0pOwogICAgICBjb25zdCB3YXNOZXc9IXJlY29yZE1hcC5oYXMobW9udGgubW9udGgpOwogICAgICBleGlzdGluZy5oZWF0UHVtcD1tb250aC5lbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuaGVhdEdlbmVyYXRlZD1tb250aC5oZWF0R2VuZXJhdGVkS1doOwogICAgICBleGlzdGluZy5oZWF0aW5nRWxlY3RyaWNpdHk9bW9udGguaGVhdGluZ0VsZWN0cmljaXR5S1doOwogICAgICBleGlzdGluZy5kaHdFbGVjdHJpY2l0eT1tb250aC5kaHdFbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuaGVhdGluZ0hlYXQ9bW9udGguaGVhdGluZ0hlYXRLV2g7CiAgICAgIGV4aXN0aW5nLmRod0hlYXQ9bW9udGguZGh3SGVhdEtXaDsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXBTb3VyY2U9bW9udGguY29tcGxldGU/Im15dmFpbGxhbnQtY3N2LWltcG9ydCI6Im15dmFpbGxhbnQtY3N2LWltcG9ydC1wYXJ0aWFsIjsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXBVcGRhdGVkQXQ9c3RhbXA7CiAgICAgIGV4aXN0aW5nLnVwZGF0ZWRBdD1zdGFtcDsKICAgICAgaWYoIW1vbnRoLmNvbXBsZXRlKXsKICAgICAgICBwYXJ0aWFsKys7CiAgICAgICAgY29uc3Qgbm90ZT1gbXlWQUlMTEFOVCBDU1YtVGVpbG1vbmF0ICR7bW9udGguY292ZXJhZ2VTdGFydH0gYmlzICR7bW9udGguY292ZXJhZ2VFbmR9YDsKICAgICAgICBpZighU3RyaW5nKGV4aXN0aW5nLm5vdGV8fCIiKS5pbmNsdWRlcyhub3RlKSlleGlzdGluZy5ub3RlPWV4aXN0aW5nLm5vdGU/YCR7ZXhpc3Rpbmcubm90ZX0g4oCiICR7bm90ZX1gOm5vdGU7CiAgICAgICAgZXhpc3RpbmcuY2xvc2VkPWZhbHNlO2V4aXN0aW5nLmNsb3NlZEF0PW51bGw7CiAgICAgIH0KICAgICAgcmVjb3JkTWFwLnNldChtb250aC5tb250aCxleGlzdGluZyk7CiAgICAgIHZhaWxsYW50TWFwLnNldChtb250aC5tb250aCx7bW9udGg6bW9udGgubW9udGgsZWxlY3RyaWNpdHlLV2g6bW9udGguZWxlY3RyaWNpdHlLV2gsaGVhdEdlbmVyYXRlZEtXaDptb250aC5oZWF0R2VuZXJhdGVkS1doLGhlYXRpbmdFbGVjdHJpY2l0eUtXaDptb250aC5oZWF0aW5nRWxlY3RyaWNpdHlLV2gsZGh3RWxlY3RyaWNpdHlLV2g6bW9udGguZGh3RWxlY3RyaWNpdHlLV2gsaGVhdGluZ0hlYXRLV2g6bW9udGguaGVhdGluZ0hlYXRLV2gsZGh3SGVhdEtXaDptb250aC5kaHdIZWF0S1doLHNvdXJjZTpleGlzdGluZy5oZWF0UHVtcFNvdXJjZSxlc3RpbWF0ZWQ6IW1vbnRoLmNvbXBsZXRlLHVwZGF0ZWRBdDpzdGFtcH0pOwogICAgICBpbXBvcnRlZCsrO2lmKHdhc05ldyljcmVhdGVkKys7CiAgICB9CiAgICBzYXZlUmVjb3JkcyhbLi4ucmVjb3JkTWFwLnZhbHVlcygpXSx7cmVhc29uOiJteVZBSUxMQU5UIENTViBpbXBvcnRpZXJ0In0pOwogICAgdmFpbGxhbnRNb250aHM9Wy4uLnZhaWxsYW50TWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpO3NhdmVWYWlsbGFudE1vbnRocygpOwogICAgcmV0dXJuIHtpbXBvcnRlZCxjcmVhdGVkLHBhcnRpYWx9OwogIH0KICBhc3luYyBmdW5jdGlvbiBpbXBvcnRWYWlsbGFudENzdkZpbGVzKGZpbGVMaXN0KXsKICAgIGNvbnN0IGZpbGVzPVsuLi4oZmlsZUxpc3R8fFtdKV07CiAgICBpZighZmlsZXMubGVuZ3RoKXJldHVybjsKICAgIHNldFN0YXR1cygidmFpbGxhbnRJbXBvcnRTdGF0dXMiLCJEYXRlaWVuIHdlcmRlbiBsb2thbCBnZXByw7xmdCDigKYiKTsKICAgIHRyeXsKICAgICAgY29uc3QgcGFyc2VkPVtdOwogICAgICBmb3IobGV0IGk9MDtpPGZpbGVzLmxlbmd0aDtpKyspcGFyc2VkLnB1c2gocGFyc2VWYWlsbGFudENzdlRleHQoYXdhaXQgZmlsZXNbaV0udGV4dCgpLGkpKTsKICAgICAgY29uc3QgcHJldmlldz1idWlsZFZhaWxsYW50SW1wb3J0UHJldmlldyhwYXJzZWQpOwogICAgICBjb25zdCBpbXBvcnRhYmxlPXByZXZpZXcubW9udGhzLmZpbHRlcihtPT4hbS5ibG9ja2VkKTsKICAgICAgY29uc3QgbWlzc2luZ0Fybz0hcGFyc2VkLnNvbWUoZj0+Zi50eXBlPT09ImFyb3RoZXJtLWVuZXJneSIpLG1pc3NpbmdVbmk9IXBhcnNlZC5zb21lKGY9PmYudHlwZT09PSJ1bml0b3dlci1lbmVyZ3kiKTsKICAgICAgaWYobWlzc2luZ0Fyb3x8bWlzc2luZ1VuaSl0aHJvdyBuZXcgRXJyb3IoYEVzIGZlaGxlbiAke1ttaXNzaW5nQXJvPyJhcm9USEVSTS1FbmVyZ2llIjpudWxsLG1pc3NpbmdVbmk/InVuaVRPV0VSLUVuZXJnaWUiOm51bGxdLmZpbHRlcihCb29sZWFuKS5qb2luKCIgdW5kICIpfS4gQml0dGUgYmVpZGUgRXhwb3J0ZGF0ZWllbiBhdXN3w6RobGVuLmApOwogICAgICBpZighcHJldmlldy5tb250aHMubGVuZ3RoKXRocm93IG5ldyBFcnJvcigiS2VpbmUgV8Okcm1lcHVtcGVuLU1vbmF0c2RhdGVuIGVya2FubnQuIik7CiAgICAgIGlmKCFpbXBvcnRhYmxlLmxlbmd0aCl7CiAgICAgICAgY29uc3QgYmxvY2tlZD1wcmV2aWV3Lm1vbnRocy5tYXAobT0+YCR7bW9udGhMYWJlbChtLm1vbnRoLGZhbHNlKX06ICR7bS5oYXNDb25mbGljdD8iS29uZmxpa3QiOm0ubmVnYXRpdmVSZXN0PyJ1bnBsYXVzaWJsZXIgUmVzdHZlcmJyYXVjaCI6IW0uaGFzQm90aD8iRGF0ZWkgZmVobHQiOiFtLmNvbXBsZXRlJiYhbS5pc0N1cnJlbnQ/Imhpc3RvcmlzY2hlciBUZWlsbW9uYXQiOiJuaWNodCBpbXBvcnRpZXJiYXIifWApLmpvaW4oIiDigKIgIik7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBLZWluZSBpbXBvcnRpZXJiYXJlbiBNb25hdGUuICR7YmxvY2tlZH1gKTsKICAgICAgfQogICAgICBjb25zdCBibG9ja2VkQ291bnQ9cHJldmlldy5tb250aHMubGVuZ3RoLWltcG9ydGFibGUubGVuZ3RoOwogICAgICBjb25zdCBtZXNzYWdlPWAke2ltcG9ydGFibGUubGVuZ3RofSBNb25hdChlKSBpbXBvcnRpZXJlbj8ke2Jsb2NrZWRDb3VudD9gICR7YmxvY2tlZENvdW50fSB1bnZvbGxzdMOkbmRpZ2UvYXVmZsOkbGxpZ2UgTW9uYXRlIHdlcmRlbiDDvGJlcnNwcnVuZ2VuLmA6IiJ9IEdlc2FtdHZlcmJyYXVjaCwgQWx0ZW50ZWlsLCBQcmVpc2UgdW5kIE5vdGl6ZW4gYmxlaWJlbiBlcmhhbHRlbi5gOwogICAgICBpZighY29uZmlybShtZXNzYWdlKSl7c2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsIkltcG9ydCBhYmdlYnJvY2hlbi4iKTtyZXR1cm47fQogICAgICBjb25zdCByZXN1bHQ9bWVyZ2VWYWlsbGFudEltcG9ydChpbXBvcnRhYmxlKTsKICAgICAgcmVuZGVyQWxsKCk7CiAgICAgIHNldFN0YXR1cygidmFpbGxhbnRJbXBvcnRTdGF0dXMiLGAke3Jlc3VsdC5pbXBvcnRlZH0gTW9uYXQoZSkgaW1wb3J0aWVydCR7cmVzdWx0LnBhcnRpYWw/YCDCtyAke3Jlc3VsdC5wYXJ0aWFsfSBha3R1ZWxsZXIgVGVpbG1vbmF0YDoiIn0ke2Jsb2NrZWRDb3VudD9gIMK3ICR7YmxvY2tlZENvdW50fSDDvGJlcnNwcnVuZ2VuYDoiIn0uYCwib2siKTsKICAgICAgdG9hc3QoYCR7cmVzdWx0LmltcG9ydGVkfSBXw6RybWVwdW1wZW4tTW9uYXRlIGltcG9ydGllcnRgKTsKICAgIH1jYXRjaChlcnJvcil7c2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsZXJyb3IubWVzc2FnZSwiZXJyb3IiKTt9CiAgICBmaW5hbGx5eyQoInZhaWxsYW50Q3N2RmlsZXNJbnB1dCIpLnZhbHVlPSIiO30KICB9CgogIGFzeW5jIGZ1bmN0aW9uIG9zdHJvbUZldGNoKHBhdGgpewogICAgaWYoIXNldHRpbmdzLm9zdHJvbUFwcEtleSl0aHJvdyBuZXcgRXJyb3IoIkFwcC1TY2hsw7xzc2VsIGZlaGx0LiIpOwogICAgY29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2gocGF0aCx7aGVhZGVyczp7IngtZWxkZWhvZi1rZXkiOnNldHRpbmdzLm9zdHJvbUFwcEtleSwiYWNjZXB0IjoiYXBwbGljYXRpb24vanNvbiJ9LGNhY2hlOiJuby1zdG9yZSJ9KTsgY29uc3QgdGV4dD1hd2FpdCByZXNwb25zZS50ZXh0KCk7IGxldCBwYXlsb2FkPXt9OyB0cnl7cGF5bG9hZD10ZXh0P0pTT04ucGFyc2UodGV4dCk6e307fWNhdGNoe30KICAgIGlmKCFyZXNwb25zZS5vayl0aHJvdyBuZXcgRXJyb3IocGF5bG9hZC5lcnJvcnx8cGF5bG9hZC5tZXNzYWdlfHx0ZXh0fHxgRmVobGVyICR7cmVzcG9uc2Uuc3RhdHVzfWApOyByZXR1cm4gcGF5bG9hZDsKICB9CiAgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE9zdHJvbShzaG93VG9hc3Q9ZmFsc2UpewogICAgaWYob3N0cm9tQnVzeXx8IXNldHRpbmdzLm9zdHJvbUFwcEtleSl7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7cmV0dXJuIGZhbHNlO30KICAgIG9zdHJvbUJ1c3k9dHJ1ZTtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTsKICAgIHRyeXsgY29uc3QgcGF5bG9hZD1hd2FpdCBvc3Ryb21GZXRjaChgL2FwaS9saXZlJHtzaG93VG9hc3Q/Ij9yZWZyZXNoPTEiOiIifWApOyBzYXZlT3N0cm9tQ2FjaGUocGF5bG9hZCk7IGlmKHNob3dUb2FzdCl0b2FzdCgiT3N0cm9tIGFrdHVhbGlzaWVydCIpOyByZXR1cm4gdHJ1ZTsgfQogICAgY2F0Y2goZXJyb3IpeyBzZXRPc3Ryb21TdGF0dXMoYEZlaGxlcjogJHtlcnJvci5tZXNzYWdlfWAsImVycm9yIik7IGlmKHNob3dUb2FzdCl0b2FzdChgT3N0cm9tOiAke2Vycm9yLm1lc3NhZ2V9YCk7IHJldHVybiBmYWxzZTsgfQogICAgZmluYWxseXtvc3Ryb21CdXN5PWZhbHNlO3JlbmRlck9zdHJvbURhc2hib2FyZCgpO30KICB9CiAgZnVuY3Rpb24gc2NoZWR1bGVPc3Ryb20oKXsgY2xlYXJJbnRlcnZhbChvc3Ryb21UaW1lcik7b3N0cm9tVGltZXI9bnVsbDsgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5JiZzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlKW9zdHJvbVRpbWVyPXNldEludGVydmFsKCgpPT5yZWZyZXNoT3N0cm9tKGZhbHNlKSwxMCo2MCoxMDAwKTsgfQogIGZ1bmN0aW9uIHNldE9zdHJvbVN0YXR1cyh0ZXh0LGtpbmQ9IiIpeyBjb25zdCBlbD0kKCJvc3Ryb21TdGF0dXMiKTtlbC50ZXh0Q29udGVudD10ZXh0O2VsLnN0eWxlLmNvbG9yPWtpbmQ9PT0iZXJyb3IiPyIjZmZhYWE5IjoiIjsgfQogIGZ1bmN0aW9uIGZvcm1hdERhdGVUaW1lKHZhbHVlKXsgY29uc3QgZD1uZXcgRGF0ZSh2YWx1ZSk7IGlmKE51bWJlci5pc05hTihkLnZhbHVlT2YoKSkpcmV0dXJuICLigJMiOyByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7d2Vla2RheToic2hvcnQiLGRheToiMi1kaWdpdCIsbW9udGg6IjItZGlnaXQiLGhvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQoZCk7IH0KICBmdW5jdGlvbiBpbnRlcnZhbFJvd3MoKXsgcmV0dXJuIChBcnJheS5pc0FycmF5KG9zdHJvbUxpdmU/LnByaWNlRm9yZWNhc3QpP29zdHJvbUxpdmUucHJpY2VGb3JlY2FzdDpbXSkubWFwKHA9Pih7dGltZTpuZXcgRGF0ZShwLmRhdGV8fHAuc3RhcnR8fHAudGltZXN0YW1wKS5nZXRUaW1lKCkscHJpY2U6TnVtYmVyKHAudG90YWxDdFBlcktXaD8/cC5wcmljZUN0UGVyS1doPz9wLnByaWNlKX0pKS5maWx0ZXIocD0+TnVtYmVyLmlzRmluaXRlKHAudGltZSkmJk51bWJlci5pc0Zpbml0ZShwLnByaWNlKSkuc29ydCgoYSxiKT0+YS50aW1lLWIudGltZSk7IH0KICBmdW5jdGlvbiBpbmZlclN0ZXAocm93cyl7IGNvbnN0IGRpZmZzPVtdO2ZvcihsZXQgaT0xO2k8cm93cy5sZW5ndGg7aSsrKXtjb25zdCBkPXJvd3NbaV0udGltZS1yb3dzW2ktMV0udGltZTtpZihkPj01KjYwZTMmJmQ8PTIqMzYwMGUzKWRpZmZzLnB1c2goZCk7fSBpZighZGlmZnMubGVuZ3RoKXJldHVybiAzNjAwZTM7ZGlmZnMuc29ydCgoYSxiKT0+YS1iKTtyZXR1cm4gZGlmZnNbTWF0aC5mbG9vcihkaWZmcy5sZW5ndGgvMildOyB9CiAgZnVuY3Rpb24gY29tcHV0ZVByaWNlV2luZG93KHJvd3MsaG91cnMsbW9kZSl7CiAgICBpZighcm93cy5sZW5ndGgpcmV0dXJuIG51bGw7IGNvbnN0IHN0ZXA9aW5mZXJTdGVwKHJvd3MpOyBjb25zdCBjb3VudD1NYXRoLm1heCgxLE1hdGgucm91bmQoaG91cnMqMzYwMGUzL3N0ZXApKTsgY29uc3Qgbm93PURhdGUubm93KCk7IGNvbnN0IHBvb2w9cm93cy5maWx0ZXIocj0+ci50aW1lPj1ub3ctc3RlcCkuc2xpY2UoMCxNYXRoLm1heChjb3VudCxNYXRoLnJvdW5kKDQ4KjM2MDBlMy9zdGVwKSkpOwogICAgbGV0IGJlc3Q9bnVsbDsKICAgIGZvcihsZXQgaT0wO2krY291bnQ8PXBvb2wubGVuZ3RoO2krKyl7Y29uc3Qgc2xpY2U9cG9vbC5zbGljZShpLGkrY291bnQpO2xldCBjb250aWd1b3VzPXRydWU7Zm9yKGxldCBqPTE7ajxzbGljZS5sZW5ndGg7aisrKWlmKHNsaWNlW2pdLnRpbWUtc2xpY2Vbai0xXS50aW1lPnN0ZXAqMS42KXtjb250aWd1b3VzPWZhbHNlO2JyZWFrO31pZighY29udGlndW91cyljb250aW51ZTtjb25zdCBhdmc9c2xpY2UucmVkdWNlKChzLHIpPT5zK3IucHJpY2UsMCkvc2xpY2UubGVuZ3RoO2NvbnN0IGNhbmRpZGF0ZT17c3RhcnQ6c2xpY2VbMF0udGltZSxlbmQ6c2xpY2UuYXQoLTEpLnRpbWUrc3RlcCxhdmd9O2lmKCFiZXN0fHwobW9kZT09PSJtaW4iP2F2ZzxiZXN0LmF2Zzphdmc+YmVzdC5hdmcpKWJlc3Q9Y2FuZGlkYXRlO30KICAgIHJldHVybiBiZXN0OwogIH0KICBmdW5jdGlvbiByZW5kZXJPc3Ryb21EYXNoYm9hcmQoKXsKICAgIGNvbnN0IGNhblJlZnJlc2g9Qm9vbGVhbihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpOwogICAgY29uc3QgaGFzU3luY2VkRGF0YT1Cb29sZWFuKG9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0KTsKICAgIGNvbnN0IHZpc2libGU9Y2FuUmVmcmVzaHx8aGFzU3luY2VkRGF0YTsKICAgICQoIm9zdHJvbVNldHVwSGludCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsdmlzaWJsZSk7CiAgICAkKCJvc3Ryb21EYXNoYm9hcmQiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCF2aXNpYmxlKTsKICAgICQoIm9zdHJvbU1pbmlDaGFydCIpLnBhcmVudEVsZW1lbnQuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhdmlzaWJsZSk7CiAgICAkKCJyZWZyZXNoT3N0cm9tQnRuIikuZGlzYWJsZWQ9IWNhblJlZnJlc2h8fG9zdHJvbUJ1c3k7CiAgICBpZighdmlzaWJsZSl7IHNldE9zdHJvbVN0YXR1cygiTmljaHQgdmVyYnVuZGVuIik7IHJldHVybjsgfQogICAgaWYob3N0cm9tQnVzeSlzZXRPc3Ryb21TdGF0dXMoIkFrdHVhbGlzaWVydW5nIGzDpHVmdCDigKYiKTsKICAgIGVsc2UgaWYoaGFzU3luY2VkRGF0YSYmIWNhblJlZnJlc2gpc2V0T3N0cm9tU3RhdHVzKGBWb20gYW5kZXJlbiBHZXLDpHQgc3luY2hyb25pc2llcnQgwrcgJHtmb3JtYXREYXRlVGltZShvc3Ryb21MaXZlLmdlbmVyYXRlZEF0KX1gKTsKICAgIGVsc2UgaWYoaGFzU3luY2VkRGF0YSlzZXRPc3Ryb21TdGF0dXMoYEFrdHVhbGlzaWVydCAke2Zvcm1hdERhdGVUaW1lKG9zdHJvbUxpdmUuZ2VuZXJhdGVkQXQpfWApOwogICAgZWxzZSBzZXRPc3Ryb21TdGF0dXMoIk5vY2gga2VpbmUgTGl2ZS1EYXRlbiIpOwogICAgY29uc3Qgcm93cz1pbnRlcnZhbFJvd3MoKTsgaWYoIXJvd3MubGVuZ3RoKXsgWyJvc3Ryb21DdXJyZW50UHJpY2UiLCJvc3Ryb21CZXN0UHJpY2UiLCJvc3Ryb21Xb3JzdFByaWNlIl0uZm9yRWFjaChpZD0+JChpZCkudGV4dENvbnRlbnQ9IuKAkyIpOyBbIm9zdHJvbUN1cnJlbnRNZXRhIiwib3N0cm9tQmVzdE1ldGEiLCJvc3Ryb21Xb3JzdE1ldGEiXS5mb3JFYWNoKGlkPT4kKGlkKS50ZXh0Q29udGVudD0iTm9jaCBrZWluZSBQcmVpc3ZvcnNjaGF1Iik7IGRyYXdPc3Ryb21NaW5pKFtdKTsgcmV0dXJuOyB9CiAgICBjb25zdCBub3c9RGF0ZS5ub3coKSxzdGVwPWluZmVyU3RlcChyb3dzKTsgY29uc3QgY3VycmVudD1yb3dzLmZpbmQoKHIsaSk9PnIudGltZTw9bm93JiYocm93c1tpKzFdPy50aW1lPz9yLnRpbWUrc3RlcCk+bm93KXx8cm93cy5maW5kKHI9PnIudGltZT5ub3cpfHxyb3dzLmF0KC0xKTsgY29uc3QgaG91cnM9TnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKXx8MzsgY29uc3QgYmVzdD1jb21wdXRlUHJpY2VXaW5kb3cocm93cyxob3VycywibWluIiksIHdvcnN0PWNvbXB1dGVQcmljZVdpbmRvdyhyb3dzLGhvdXJzLCJtYXgiKTsKICAgICQoIm9zdHJvbUJlc3RMYWJlbCIpLnRleHRDb250ZW50PWBCZXN0ZXMgJHtob3Vyc31oLUZlbnN0ZXJgOyAkKCJvc3Ryb21Xb3JzdExhYmVsIikudGV4dENvbnRlbnQ9YFNjaGxlY2h0ZXN0ZXMgJHtob3Vyc31oLUZlbnN0ZXJgOwogICAgJCgib3N0cm9tQ3VycmVudFByaWNlIikudGV4dENvbnRlbnQ9YCR7bnVtKGN1cnJlbnQ/LnByaWNlLDIpfSBjdC9rV2hgOyAkKCJvc3Ryb21DdXJyZW50TWV0YSIpLnRleHRDb250ZW50PWN1cnJlbnQ/Zm9ybWF0RGF0ZVRpbWUoY3VycmVudC50aW1lKToi4oCTIjsKICAgICQoIm9zdHJvbUJlc3RQcmljZSIpLnRleHRDb250ZW50PWJlc3Q/YCR7bnVtKGJlc3QuYXZnLDIpfSBjdC9rV2hgOiLigJMiOyAkKCJvc3Ryb21CZXN0TWV0YSIpLnRleHRDb250ZW50PWJlc3Q/YCR7Zm9ybWF0RGF0ZVRpbWUoYmVzdC5zdGFydCl9IOKAkyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUoYmVzdC5lbmQpKX1gOiLigJMiOwogICAgJCgib3N0cm9tV29yc3RQcmljZSIpLnRleHRDb250ZW50PXdvcnN0P2Ake251bSh3b3JzdC5hdmcsMil9IGN0L2tXaGA6IuKAkyI7ICQoIm9zdHJvbVdvcnN0TWV0YSIpLnRleHRDb250ZW50PXdvcnN0P2Ake2Zvcm1hdERhdGVUaW1lKHdvcnN0LnN0YXJ0KX0g4oCTICR7bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCIsbWludXRlOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZSh3b3JzdC5lbmQpKX1gOiLigJMiOwogICAgZHJhd09zdHJvbU1pbmkocm93cy5maWx0ZXIocj0+ci50aW1lPj1ub3ctc3RlcCkuc2xpY2UoMCw0OCkpOwogIH0KICBmdW5jdGlvbiBkcmF3T3N0cm9tTWluaShyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgib3N0cm9tTWluaUNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBpZighcm93cy5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LCJLZWluZSBPc3Ryb20tUHJlaXNkYXRlbiIpO3JldHVybjt9IGNvbnN0IG1pbj1NYXRoLm1pbiguLi5yb3dzLm1hcChyPT5yLnByaWNlKSksbWF4PU1hdGgubWF4KC4uLnJvd3MubWFwKHI9PnIucHJpY2UpKSxzcGFuPU1hdGgubWF4KDEsbWF4LW1pbik7IGNvbnN0IHBhZD17bDo0MyxyOjgsdDoxMixiOjMwfSx3PXdpZHRoLXBhZC5sLXBhZC5yLGg9aGVpZ2h0LXBhZC50LXBhZC5iOwogICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkO2N0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7Y3R4LmZvbnQ9IjEwcHggc2Fucy1zZXJpZiI7Zm9yKGxldCBpPTA7aTw9MztpKyspe2NvbnN0IHk9cGFkLnQraCppLzM7Y3R4LmJlZ2luUGF0aCgpO2N0eC5tb3ZlVG8ocGFkLmwseSk7Y3R4LmxpbmVUbyh3aWR0aC1wYWQucix5KTtjdHguc3Ryb2tlKCk7Y3R4LmZpbGxUZXh0KG51bShtYXgtc3BhbippLzMsMCksNCx5KzMpO30gY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy50b3RhbDtjdHgubGluZVdpZHRoPTI7Y3R4LmJlZ2luUGF0aCgpO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9cGFkLmwrKHJvd3MubGVuZ3RoPT09MT93LzI6dyppLyhyb3dzLmxlbmd0aC0xKSkseT1wYWQudCtoKigxLShyLnByaWNlLW1pbikvc3Bhbik7aT9jdHgubGluZVRvKHgseSk6Y3R4Lm1vdmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICAgIGNvbnN0IHN0ZXA9TWF0aC5tYXgoMSxNYXRoLmZsb29yKHJvd3MubGVuZ3RoLzUpKTsgcm93cy5mb3JFYWNoKChyLGkpPT57aWYoaSVzdGVwJiZpIT09cm93cy5sZW5ndGgtMSlyZXR1cm47Y29uc3QgeD1wYWQubCsocm93cy5sZW5ndGg9PT0xP3cvMjp3KmkvKHJvd3MubGVuZ3RoLTEpKTtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5maWxsVGV4dChuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZShyLnRpbWUpKSx4LTgsaGVpZ2h0LTkpO30pOwogIH0KICBhc3luYyBmdW5jdGlvbiBzYXZlQW5kQ2hlY2tPc3Ryb20oKXsKICAgIGNvbnN0IGtleT0kKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlLnRyaW0oKTsgc2V0dGluZ3Mub3N0cm9tQXBwS2V5PWtleTsgc2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2g9JCgib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIpLmNoZWNrZWQ7IHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzPU51bWJlcigkKCJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0IikudmFsdWUpfHwzOyBzYXZlU2V0dGluZ3MoKTsKICAgIGlmKCFrZXkpe3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIkJpdHRlIEFwcC1TY2hsw7xzc2VsIGVpbnRyYWdlbi4iLCJlcnJvciIpO3JlbmRlck9zdHJvbURhc2hib2FyZCgpO3JldHVybjt9CiAgICBzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJWZXJiaW5kdW5nIHdpcmQgZ2VwcsO8ZnQg4oCmIik7CiAgICB0cnl7IGNvbnN0IGhlYWx0aD1hd2FpdCBvc3Ryb21GZXRjaCgiL2FwaS9oZWFsdGg/ZGVlcD10b2tlbiIpOyBpZighaGVhbHRoLmNvbmZpZ3VyZWQpdGhyb3cgbmV3IEVycm9yKCJDbG91ZGZsYXJlLVNlY3JldHMgc2luZCBuaWNodCB2b2xsc3TDpG5kaWcgZWluZ2VyaWNodGV0LiIpOyBzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJPc3Ryb20tVmVyYmluZHVuZyBlcmZvbGdyZWljaC4iLCJvayIpOyBhd2FpdCByZWZyZXNoT3N0cm9tKHRydWUpOyBzY2hlZHVsZU9zdHJvbSgpOyByZW5kZXJBbGwoKTsgfQogICAgY2F0Y2goZXJyb3Ipe3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsZXJyb3IubWVzc2FnZSwiZXJyb3IiKTt9CiAgfQogIGZ1bmN0aW9uIGRpc2Nvbm5lY3RPc3Ryb20oKXsgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5JiYhY29uZmlybSgiT3N0cm9tLVZlcmJpbmR1bmcgd2lya2xpY2ggZW50ZmVybmVuPyIpKXJldHVybjsgc2V0dGluZ3Mub3N0cm9tQXBwS2V5PSIiO3NhdmVTZXR0aW5ncygpO3NhdmVPc3Ryb21DYWNoZShudWxsKTtsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShPU1RST01fQ09OVFJPTF9LRVkpO3NjaGVkdWxlT3N0cm9tKCk7cmVuZGVyQWxsKCk7c2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiVmVyYmluZHVuZyBlbnRmZXJudC4iKTt0b2FzdCgiT3N0cm9tIGdldHJlbm50Iik7IH0KCgogIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hPc3Ryb21IaXN0b3J5KHtzaWxlbnQ9ZmFsc2Usb25seU1pc3Npbmc9ZmFsc2UsbWF4TW9udGhzPUluZmluaXR5fT17fSl7CiAgICBpZihvc3Ryb21IaXN0b3J5QnVzeSlyZXR1cm47CiAgICBpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtpZighc2lsZW50KXRvYXN0KCJPc3Ryb20genVlcnN0IHZlcmJpbmRlbiIpO3JldHVybjt9CiAgICBjb25zdCBlbGlnaWJsZT1zb3J0ZWQoKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpJiZyLm1vbnRoPGN1cnJlbnRNb250aEtleSgpKS5maWx0ZXIocj0+IW9ubHlNaXNzaW5nfHwhci5vc3Ryb21QcmljZUNvbXBsZXRlKTsKICAgIGlmKCFlbGlnaWJsZS5sZW5ndGgpe2lmKCFzaWxlbnQpdG9hc3QoIlByZWlzaGlzdG9yaWUgaXN0IGJlcmVpdHMgdm9sbHN0w6RuZGlnIik7cmV0dXJuO30KICAgIG9zdHJvbUhpc3RvcnlCdXN5PXRydWU7cmVuZGVyRGF0YSgpOwogICAgbGV0IHVwZGF0ZWQ9MCx1bmF2YWlsYWJsZT0wLHByb2Nlc3NlZD0wOwogICAgY29uc3QgbWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgdHJ5ewogICAgICBmb3IoY29uc3QgciBvZiBlbGlnaWJsZS5zbGljZSgtTWF0aC5tYXgoMSxOdW1iZXIobWF4TW9udGhzKXx8ZWxpZ2libGUubGVuZ3RoKSkpewogICAgICAgIHByb2Nlc3NlZCsrOwogICAgICAgIGlmKCFzaWxlbnQpc2V0U3RhdHVzKCJvc3Ryb21IaXN0b3J5U3RhdHVzIixgJHttb250aExhYmVsKHIubW9udGgsZmFsc2UpfSB3aXJkIHZvbiBPc3Ryb20gZ2VsYWRlbiDigKYgKCR7cHJvY2Vzc2VkfS8ke01hdGgubWluKGVsaWdpYmxlLmxlbmd0aCxtYXhNb250aHMpfSlgKTsKICAgICAgICB0cnl7CiAgICAgICAgICBjb25zdCBkYXRhPWF3YWl0IG9zdHJvbUZldGNoKGAvYXBpL21vbnRoP21vbnRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHIubW9udGgpfWApOwogICAgICAgICAgaWYoIWRhdGE/LmNvbXBsZXRlfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcihkYXRhLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKSl8fCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGRhdGEudG90YWxDb3N0RXVyKSkpe3VuYXZhaWxhYmxlKys7Y29udGludWU7fQogICAgICAgICAgY29uc3QgaXRlbT1tYXAuZ2V0KHIubW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6ci5tb250aH0pOwogICAgICAgICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogICAgICAgICAgaXRlbS5wcmljZUN0PU51bWJlcihkYXRhLndlaWdodGVkQXZlcmFnZUN0UGVyS1doKTsKICAgICAgICAgIGl0ZW0uYmFzZUZlZT1OdW1iZXIoZGF0YS5maXhlZENvc3RFdXIpfHwwOwogICAgICAgICAgaXRlbS5vc3Ryb21WYXJpYWJsZUNvc3RFdXI9TnVtYmVyKGRhdGEudmFyaWFibGVDb3N0RXVyKTsKICAgICAgICAgIGl0ZW0ub3N0cm9tVG90YWxDb3N0RXVyPU51bWJlcihkYXRhLnRvdGFsQ29zdEV1cik7CiAgICAgICAgICBpdGVtLm9zdHJvbUNvbnN1bXB0aW9uS1doPU51bWJlcihkYXRhLnRvdGFsS1doKTsKICAgICAgICAgIGl0ZW0ub3N0cm9tUHJpY2VDb21wbGV0ZT10cnVlOwogICAgICAgICAgaXRlbS5wcmljZVNvdXJjZT0ib3N0cm9tLWhvdXJseS1jb25zdW1wdGlvbi13ZWlnaHRlZCI7CiAgICAgICAgICBpdGVtLnByaWNlVXBkYXRlZEF0PXN0YW1wOwogICAgICAgICAgaXRlbS51cGRhdGVkQXQ9c3RhbXA7CiAgICAgICAgICBtYXAuc2V0KHIubW9udGgsaXRlbSk7dXBzZXJ0T3N0cm9tUHJpY2VTdGF0KHIubW9udGgsZGF0YSx7cGFydGlhbDpmYWxzZX0pO3VwZGF0ZWQrKzsKICAgICAgICB9Y2F0Y2goZXJyb3Ipe3VuYXZhaWxhYmxlKys7fQogICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmU9PnNldFRpbWVvdXQocmVzb2x2ZSwxNDApKTsKICAgICAgfQogICAgICBpZih1cGRhdGVkKXNhdmVSZWNvcmRzKFsuLi5tYXAudmFsdWVzKCldLHtyZWFzb246Ik9zdHJvbS1TdHVuZGVucHJlaXNlIGFrdHVhbGlzaWVydCJ9KTsKICAgICAgY29uc3Qgc3RhdHVzPXt1cGRhdGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHVwZGF0ZWQsdW5hdmFpbGFibGV9O2xvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9ISVNUT1JZX0tFWSxKU09OLnN0cmluZ2lmeShzdGF0dXMpKTsKICAgICAgcmVuZGVyQWxsKCk7CiAgICAgIGlmKCFzaWxlbnQpdG9hc3QoYCR7dXBkYXRlZH0gTW9uYXQoZSkgbWl0IE9zdHJvbS1TdHVuZGVucHJlaXNlbiBha3R1YWxpc2llcnQke3VuYXZhaWxhYmxlP2AgwrcgJHt1bmF2YWlsYWJsZX0gbmljaHQgdmVyZsO8Z2JhcmA6IiJ9YCk7CiAgICB9ZmluYWxseXtvc3Ryb21IaXN0b3J5QnVzeT1mYWxzZTtyZW5kZXJEYXRhKCk7fQogIH0KCiAgZnVuY3Rpb24gc3luY1JhbmRvbUJ5dGVzKGxlbmd0aD0zMil7Y29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ5dGVzKTtyZXR1cm4gYnl0ZXM7fQogIGZ1bmN0aW9uIHN5bmNCeXRlc1RvQmFzZTY0VXJsKGJ5dGVzKXtsZXQgYmluYXJ5PSIiO2ZvcihsZXQgaT0wO2k8Ynl0ZXMubGVuZ3RoO2krPTgxOTIpYmluYXJ5Kz1TdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksaSs4MTkyKSk7cmV0dXJuIGJ0b2EoYmluYXJ5KS5yZXBsYWNlQWxsKCIrIiwiLSIpLnJlcGxhY2VBbGwoIi8iLCJfIikucmVwbGFjZSgvPSskL2csIiIpO30KICBmdW5jdGlvbiBzeW5jQmFzZTY0VXJsVG9CeXRlcyh2YWx1ZSl7Y29uc3QgcmF3PVN0cmluZyh2YWx1ZXx8IiIpLnJlcGxhY2VBbGwoIi0iLCIrIikucmVwbGFjZUFsbCgiXyIsIi8iKTtjb25zdCBwYWRkZWQ9cmF3KyI9Ii5yZXBlYXQoKDQtcmF3Lmxlbmd0aCU0KSU0KTtjb25zdCBiaW5hcnk9YXRvYihwYWRkZWQpO2NvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KGJpbmFyeS5sZW5ndGgpO2ZvcihsZXQgaT0wO2k8YmluYXJ5Lmxlbmd0aDtpKyspYnl0ZXNbaV09YmluYXJ5LmNoYXJDb2RlQXQoaSk7cmV0dXJuIGJ5dGVzO30KICBmdW5jdGlvbiBzeW5jUmVjb3ZlcnlOb3JtYWxpemUodmFsdWUpe3JldHVybiBTdHJpbmcodmFsdWV8fCIiKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teMC05YS1mXS9nLCIiKTt9CiAgZnVuY3Rpb24gc3luY1JlY292ZXJ5Rm9ybWF0KHZhbHVlKXtjb25zdCByYXc9c3luY1JlY292ZXJ5Tm9ybWFsaXplKHZhbHVlKS50b1VwcGVyQ2FzZSgpO3JldHVybiByYXcubWF0Y2goLy57MSw0fS9nKT8uam9pbigiLSIpfHwiIjt9CiAgZnVuY3Rpb24gc3luY0dlbmVyYXRlUmVjb3ZlcnlLZXkoKXtyZXR1cm4gWy4uLnN5bmNSYW5kb21CeXRlcygzMildLm1hcChiPT5iLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCIwIikpLmpvaW4oIiIpO30KICBmdW5jdGlvbiBzeW5jR2VuZXJhdGVJZChwcmVmaXgsYnl0ZXM9MTYpe3JldHVybiBgJHtwcmVmaXh9LSR7c3luY0J5dGVzVG9CYXNlNjRVcmwoc3luY1JhbmRvbUJ5dGVzKGJ5dGVzKSl9YDt9CiAgZnVuY3Rpb24gbG9hZFN5bmNTdGF0ZSgpewogICAgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU1lOQ19TVEFURV9LRVkpLHt9KTsKICAgIHJldHVybiB7Y29uZmlndXJlZDpCb29sZWFuKHJhdz8uY29uZmlndXJlZCksdmF1bHRJZDpTdHJpbmcocmF3Py52YXVsdElkfHwiIiksZGV2aWNlSWQ6U3RyaW5nKHJhdz8uZGV2aWNlSWR8fCIiKSxkZXZpY2VOYW1lOlN0cmluZyhyYXc/LmRldmljZU5hbWV8fCIiKSxkZXZpY2VUb2tlbjpTdHJpbmcocmF3Py5kZXZpY2VUb2tlbnx8IiIpLHJlY292ZXJ5S2V5OigoKT0+e2NvbnN0IGN1cnJlbnQ9c3luY1JlY292ZXJ5Tm9ybWFsaXplKHJhdz8ucmVjb3ZlcnlLZXl8fCIiKTtjb25zdCBsZWdhY3k9c3luY1JlY292ZXJ5Tm9ybWFsaXplKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNZTkNfU0VDUkVUX0xFR0FDWV9LRVkpfHwiIik7cmV0dXJuIGN1cnJlbnQubGVuZ3RoPT09NjQ/Y3VycmVudDpsZWdhY3kubGVuZ3RoPT09NjQ/bGVnYWN5OmN1cnJlbnQ7fSkoKSxyb2xlOnJhdz8ucm9sZT09PSJhZG1pbiI/ImFkbWluIjoibWVtYmVyIixzY29wZToiZnVsbCIsc2VydmVyUmV2aXNpb246TWF0aC5tYXgoMCxOdW1iZXIocmF3Py5zZXJ2ZXJSZXZpc2lvbj8/cmF3Py5yZXZpc2lvbil8fDApLGxhc3RTeW5jQXQ6U3RyaW5nKHJhdz8ubGFzdFN5bmNBdHx8IiIpLGxhc3RFcnJvcjpTdHJpbmcocmF3Py5sYXN0RXJyb3J8fCIiKX07CiAgfQogIGZ1bmN0aW9uIHNhdmVTeW5jU3RhdGUoKXtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTWU5DX1NUQVRFX0tFWSxKU09OLnN0cmluZ2lmeShzeW5jU3RhdGUpKTt9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0Rlcml2ZUtleShyZWNvdmVyeUtleSx2YXVsdElkKXsKICAgIGNvbnN0IHJhdz1zeW5jUmVjb3ZlcnlOb3JtYWxpemUocmVjb3ZlcnlLZXkpO2lmKHJhdy5sZW5ndGghPT02NCl0aHJvdyBuZXcgRXJyb3IoIldpZWRlcmhlcnN0ZWxsdW5nc3NjaGzDvHNzZWwgaXN0IHVudm9sbHN0w6RuZGlnLiIpOwogICAgY29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkocmF3Lm1hdGNoKC8uezJ9L2cpLm1hcCh2PT5wYXJzZUludCh2LDE2KSkpO2NvbnN0IGJhc2U9YXdhaXQgY3J5cHRvLnN1YnRsZS5pbXBvcnRLZXkoInJhdyIsYnl0ZXMsIkhLREYiLGZhbHNlLFsiZGVyaXZlS2V5Il0pOwogICAgcmV0dXJuIGNyeXB0by5zdWJ0bGUuZGVyaXZlS2V5KHtuYW1lOiJIS0RGIixoYXNoOiJTSEEtMjU2IixzYWx0Om5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh2YXVsdElkKSxpbmZvOm5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSgiZWxkZWhvZi1wcml2YXRlLXN5bmMtdjEiKX0sYmFzZSx7bmFtZToiQUVTLUdDTSIsbGVuZ3RoOjI1Nn0sZmFsc2UsWyJlbmNyeXB0IiwiZGVjcnlwdCJdKTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gc3luY0VuY3J5cHQocGF5bG9hZCl7Y29uc3Qga2V5PWF3YWl0IHN5bmNEZXJpdmVLZXkoc3luY1N0YXRlLnJlY292ZXJ5S2V5LHN5bmNTdGF0ZS52YXVsdElkKTtjb25zdCBpdj1zeW5jUmFuZG9tQnl0ZXMoMTIpO2NvbnN0IGFhZD1uZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoYCR7U1lOQ19FTlZFTE9QRV9TQ0hFTUF9OiR7c3luY1N0YXRlLnZhdWx0SWR9YCk7Y29uc3QgcGxhaW49bmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtjb25zdCBlbmNyeXB0ZWQ9YXdhaXQgY3J5cHRvLnN1YnRsZS5lbmNyeXB0KHtuYW1lOiJBRVMtR0NNIixpdixhZGRpdGlvbmFsRGF0YTphYWQsdGFnTGVuZ3RoOjEyOH0sa2V5LHBsYWluKTtyZXR1cm4ge3NjaGVtYTpTWU5DX0VOVkVMT1BFX1NDSEVNQSxhbGdvcml0aG06IkFFUy1HQ00tMjU2L0hLREYtU0hBLTI1NiIsaXY6c3luY0J5dGVzVG9CYXNlNjRVcmwoaXYpLGNpcGhlcnRleHQ6c3luY0J5dGVzVG9CYXNlNjRVcmwobmV3IFVpbnQ4QXJyYXkoZW5jcnlwdGVkKSksc2NvcGU6ImZ1bGwiLGNyZWF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkscGF5bG9hZEJ1aWxkOkFQUF9CVUlMRH07fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNEZWNyeXB0KGVudmVsb3BlKXtpZihlbnZlbG9wZT8uc2NoZW1hIT09U1lOQ19FTlZFTE9QRV9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJVbmJla2FubnRlcyBTeW5jLVBha2V0LiIpO2NvbnN0IGtleT1hd2FpdCBzeW5jRGVyaXZlS2V5KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSxzeW5jU3RhdGUudmF1bHRJZCk7Y29uc3QgYWFkPW5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShgJHtTWU5DX0VOVkVMT1BFX1NDSEVNQX06JHtzeW5jU3RhdGUudmF1bHRJZH1gKTtsZXQgcGxhaW47dHJ5e3BsYWluPWF3YWl0IGNyeXB0by5zdWJ0bGUuZGVjcnlwdCh7bmFtZToiQUVTLUdDTSIsaXY6c3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuaXYpLGFkZGl0aW9uYWxEYXRhOmFhZCx0YWdMZW5ndGg6MTI4fSxrZXksc3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuY2lwaGVydGV4dCkpO31jYXRjaHt0aHJvdyBuZXcgRXJyb3IoIlN5bmMtUGFrZXQga29ubnRlIG5pY2h0IGVudHNjaGzDvHNzZWx0IHdlcmRlbi4iKTt9Y29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShwbGFpbikpO2lmKHBheWxvYWQ/LnNjaGVtYSE9PVNZTkNfUEFZTE9BRF9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJTeW5jLVBha2V0IHN0YW1tdCBhdXMgZWluZXIgbmljaHQga29tcGF0aWJsZW4gRWxkZWhvZi1WZXJzaW9uLiIpO3JldHVybiBwYXlsb2FkO30KICBhc3luYyBmdW5jdGlvbiBzeW5jQXBpKHBhdGgsYm9keSl7Y29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2goYC9hcGkvc3luYy8ke3BhdGh9YCx7bWV0aG9kOiJQT1NUIixoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiIsImFjY2VwdCI6ImFwcGxpY2F0aW9uL2pzb24ifSxib2R5OkpTT04uc3RyaW5naWZ5KGJvZHkpLGNhY2hlOiJuby1zdG9yZSJ9KTtsZXQgcGF5bG9hZD17fTt0cnl7cGF5bG9hZD1hd2FpdCByZXNwb25zZS5qc29uKCk7fWNhdGNoe31pZighcmVzcG9uc2Uub2spe2NvbnN0IGVycm9yPW5ldyBFcnJvcihwYXlsb2FkLmVycm9yfHxgU3luYy1GZWhsZXIgJHtyZXNwb25zZS5zdGF0dXN9YCk7ZXJyb3Iuc3RhdHVzPXJlc3BvbnNlLnN0YXR1cztlcnJvci5wYXlsb2FkPXBheWxvYWQ7dGhyb3cgZXJyb3I7fXJldHVybiBwYXlsb2FkO30KICBmdW5jdGlvbiBzeW5jQXV0aChleHRyYT17fSl7cmV0dXJuIHt2YXVsdElkOnN5bmNTdGF0ZS52YXVsdElkLGRldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxkZXZpY2VUb2tlbjpzeW5jU3RhdGUuZGV2aWNlVG9rZW4sLi4uZXh0cmF9O30KICBmdW5jdGlvbiBzeW5jSXRlbVRpbWUoaXRlbSl7Zm9yKGNvbnN0IGtleSBvZiBbInVwZGF0ZWRBdCIsInByaWNlVXBkYXRlZEF0IiwiaGVhdFB1bXBVcGRhdGVkQXQiLCJjbG9zZWRBdCJdKXtjb25zdCB0PURhdGUucGFyc2UoaXRlbT8uW2tleV18fCIiKTtpZihOdW1iZXIuaXNGaW5pdGUodCkpcmV0dXJuIHQ7fXJldHVybiAwO30KICBmdW5jdGlvbiBzeW5jTWVyZ2VCeUtleShsb2NhbCxyZW1vdGUsa2V5RmllbGQpe2NvbnN0IG1hcD1uZXcgTWFwKCk7Zm9yKGNvbnN0IGl0ZW0gb2YgQXJyYXkuaXNBcnJheShsb2NhbCk/bG9jYWw6W10pbWFwLnNldChTdHJpbmcoaXRlbT8uW2tleUZpZWxkXXx8IiIpLGl0ZW0pO2Zvcihjb25zdCByZW1vdGVJdGVtIG9mIEFycmF5LmlzQXJyYXkocmVtb3RlKT9yZW1vdGU6W10pe2NvbnN0IGtleT1TdHJpbmcocmVtb3RlSXRlbT8uW2tleUZpZWxkXXx8IiIpO2lmKCFrZXkpY29udGludWU7Y29uc3QgbG9jYWxJdGVtPW1hcC5nZXQoa2V5KTtpZighbG9jYWxJdGVtfHxzeW5jSXRlbVRpbWUocmVtb3RlSXRlbSk+PXN5bmNJdGVtVGltZShsb2NhbEl0ZW0pKW1hcC5zZXQoa2V5LHJlbW90ZUl0ZW0pO31yZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV07fQogIGZ1bmN0aW9uIHN5bmNDdXJyZW50UGF5bG9hZCgpe3JldHVybiB7c2NoZW1hOlNZTkNfUEFZTE9BRF9TQ0hFTUEscGF5bG9hZFZlcnNpb246IjYuMi4xIixhcHA6IkVsZGVob2YiLHNjb3BlOiJmdWxsIixyZWNvcmRzOnNhbml0aXplUmVjb3JkcyhyZWNvcmRzKSx2YWlsbGFudE1vbnRoczpBcnJheS5pc0FycmF5KHZhaWxsYW50TW9udGhzKT92YWlsbGFudE1vbnRoczpbXSxtZXRlclJlYWRpbmdzOnNhbml0aXplTWV0ZXJSZWFkaW5ncyhtZXRlclJlYWRpbmdzKSxtZXRlclJlYWRpbmdzVXBkYXRlZEF0OmxvY2FsU3RvcmFnZS5nZXRJdGVtKE1FVEVSX01FVEFfS0VZKXx8IiIsb3N0cm9tTGl2ZTpvc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKG9zdHJvbVByaWNlU3RhdHMpLGV4cG9ydGVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHNvdXJjZURldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxzb3VyY2VEZXZpY2VOYW1lOnN5bmNTdGF0ZS5kZXZpY2VOYW1lfTt9CiAgZnVuY3Rpb24gc3luY01lcmdlUGF5bG9hZChsb2NhbCxyZW1vdGUpewogICAgY29uc3QgbG9jYWxNZXRlclRpbWU9RGF0ZS5wYXJzZShsb2NhbD8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIpfHwwLHJlbW90ZU1ldGVyVGltZT1EYXRlLnBhcnNlKHJlbW90ZT8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIpfHwwOwogICAgbGV0IG1lcmdlZE1ldGVycztpZihyZW1vdGVNZXRlclRpbWU+bG9jYWxNZXRlclRpbWUpbWVyZ2VkTWV0ZXJzPXJlbW90ZS5tZXRlclJlYWRpbmdzfHxbXTtlbHNlIGlmKGxvY2FsTWV0ZXJUaW1lPnJlbW90ZU1ldGVyVGltZSltZXJnZWRNZXRlcnM9bG9jYWwubWV0ZXJSZWFkaW5nc3x8W107ZWxzZSBtZXJnZWRNZXRlcnM9KHJlbW90ZT8ubWV0ZXJSZWFkaW5ncz8ubGVuZ3RofHwwKT49KGxvY2FsPy5tZXRlclJlYWRpbmdzPy5sZW5ndGh8fDApP3JlbW90ZS5tZXRlclJlYWRpbmdzfHxbXTpsb2NhbC5tZXRlclJlYWRpbmdzfHxbXTsKICAgIGNvbnN0IGxvY2FsTGl2ZT1EYXRlLnBhcnNlKGxvY2FsPy5vc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpfHwwLHJlbW90ZUxpdmU9RGF0ZS5wYXJzZShyZW1vdGU/Lm9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0fHwiIil8fDA7CiAgICByZXR1cm4ge3NjaGVtYTpTWU5DX1BBWUxPQURfU0NIRU1BLHBheWxvYWRWZXJzaW9uOiI2LjIuMSIsYXBwOiJFbGRlaG9mIixzY29wZToiZnVsbCIscmVjb3JkczpzYW5pdGl6ZVJlY29yZHMoc3luY01lcmdlQnlLZXkobG9jYWw/LnJlY29yZHMscmVtb3RlPy5yZWNvcmRzLCJtb250aCIpKSx2YWlsbGFudE1vbnRoczpzeW5jTWVyZ2VCeUtleShsb2NhbD8udmFpbGxhbnRNb250aHMscmVtb3RlPy52YWlsbGFudE1vbnRocywibW9udGgiKSxtZXRlclJlYWRpbmdzOnNhbml0aXplTWV0ZXJSZWFkaW5ncyhtZXJnZWRNZXRlcnMpLG1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6cmVtb3RlTWV0ZXJUaW1lPmxvY2FsTWV0ZXJUaW1lP3JlbW90ZS5tZXRlclJlYWRpbmdzVXBkYXRlZEF0OmxvY2FsLm1ldGVyUmVhZGluZ3NVcGRhdGVkQXQsb3N0cm9tTGl2ZTpyZW1vdGVMaXZlPj1sb2NhbExpdmU/cmVtb3RlPy5vc3Ryb21MaXZlfHxudWxsOmxvY2FsPy5vc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHN5bmNNZXJnZUJ5S2V5KGxvY2FsPy5vc3Ryb21QcmljZVN0YXRzLHJlbW90ZT8ub3N0cm9tUHJpY2VTdGF0cywibW9udGgiKSksZXhwb3J0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksc291cmNlRGV2aWNlSWQ6c3luY1N0YXRlLmRldmljZUlkLHNvdXJjZURldmljZU5hbWU6c3luY1N0YXRlLmRldmljZU5hbWV9OwogIH0KICBmdW5jdGlvbiBzeW5jQ29tcGFyYWJsZShwYXlsb2FkKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3JlY29yZHM6c2FuaXRpemVSZWNvcmRzKHBheWxvYWQ/LnJlY29yZHN8fFtdKSx2YWlsbGFudE1vbnRoczpwYXlsb2FkPy52YWlsbGFudE1vbnRoc3x8W10sbWV0ZXJSZWFkaW5nczpzYW5pdGl6ZU1ldGVyUmVhZGluZ3MocGF5bG9hZD8ubWV0ZXJSZWFkaW5nc3x8W10pLG1ldGVyUmVhZGluZ3NVcGRhdGVkQXQ6cGF5bG9hZD8ubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdHx8IiIsb3N0cm9tTGl2ZTpwYXlsb2FkPy5vc3Ryb21MaXZlfHxudWxsLG9zdHJvbVByaWNlU3RhdHM6c2FuaXRpemVPc3Ryb21QcmljZVN0YXRzKHBheWxvYWQ/Lm9zdHJvbVByaWNlU3RhdHN8fFtdKX0pO30KICBmdW5jdGlvbiBzeW5jQXBwbHlQYXlsb2FkKHBheWxvYWQpe3N5bmNBcHBseWluZz10cnVlO3RyeXtzYXZlUmVjb3JkcyhwYXlsb2FkLnJlY29yZHN8fFtdLHtyZWFzb246IkdlcsOkdGUtU3luYyIsYWxsb3dFbXB0eTp0cnVlfSk7dmFpbGxhbnRNb250aHM9QXJyYXkuaXNBcnJheShwYXlsb2FkLnZhaWxsYW50TW9udGhzKT9wYXlsb2FkLnZhaWxsYW50TW9udGhzOltdO3NhdmVWYWlsbGFudE1vbnRocygpO3NhdmVNZXRlclJlYWRpbmdzKHBheWxvYWQubWV0ZXJSZWFkaW5nc3x8W10se3RvdWNoOmZhbHNlfSk7aWYocGF5bG9hZC5tZXRlclJlYWRpbmdzVXBkYXRlZEF0KWxvY2FsU3RvcmFnZS5zZXRJdGVtKE1FVEVSX01FVEFfS0VZLHBheWxvYWQubWV0ZXJSZWFkaW5nc1VwZGF0ZWRBdCk7c2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQub3N0cm9tTGl2ZXx8bnVsbCk7c2F2ZU9zdHJvbVByaWNlU3RhdHMocGF5bG9hZC5vc3Ryb21QcmljZVN0YXRzfHxbXSk7fWZpbmFsbHl7c3luY0FwcGx5aW5nPWZhbHNlO31yZW5kZXJBbGwoKTt9CiAgZnVuY3Rpb24gc2NoZWR1bGVDbG91ZFN5bmMoZGVsYXk9OTAwKXtjbGVhclRpbWVvdXQoc3luY0RlYm91bmNlVGltZXIpO2lmKCFzeW5jU3RhdGUuY29uZmlndXJlZHx8c3luY0FwcGx5aW5nKXJldHVybjtzeW5jRGVib3VuY2VUaW1lcj1zZXRUaW1lb3V0KCgpPT57aWYoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlIT09ImhpZGRlbiImJm5hdmlnYXRvci5vbkxpbmUhPT1mYWxzZSlzeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pO30sZGVsYXkpO30KICBmdW5jdGlvbiBzY2hlZHVsZVN5bmNQb2xsKCl7Y2xlYXJJbnRlcnZhbChzeW5jUG9sbFRpbWVyKTtzeW5jUG9sbFRpbWVyPW51bGw7aWYoIXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjtzeW5jUG9sbFRpbWVyPXNldEludGVydmFsKCgpPT57aWYoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlPT09InZpc2libGUiJiZuYXZpZ2F0b3Iub25MaW5lIT09ZmFsc2Upc3luY05vdyh7c2lsZW50OnRydWV9KTt9LDYwKjEwMDApO30KICBhc3luYyBmdW5jdGlvbiBjcmVhdGVTeW5jVmF1bHQoKXtpZihzeW5jQnVzeSlyZXR1cm47Y29uc3QgZGV2aWNlTmFtZT1TdHJpbmcoJCgic3luY0NyZWF0ZURldmljZU5hbWUiKS52YWx1ZXx8IiIpLnRyaW0oKTtpZihkZXZpY2VOYW1lLmxlbmd0aDwyKXt0b2FzdCgiR2Vyw6R0ZW5hbWVuIGVpbmdlYmVuIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtzeW5jU3RhdGU9e2NvbmZpZ3VyZWQ6dHJ1ZSx2YXVsdElkOnN5bmNHZW5lcmF0ZUlkKCJ2YXVsdCIsMTgpLGRldmljZUlkOnN5bmNHZW5lcmF0ZUlkKCJkZXZpY2UiLDE2KSxkZXZpY2VOYW1lLGRldmljZVRva2VuOnN5bmNHZW5lcmF0ZUlkKCJ0b2tlbiIsMzIpLHJlY292ZXJ5S2V5OnN5bmNHZW5lcmF0ZVJlY292ZXJ5S2V5KCkscm9sZToiYWRtaW4iLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtjb25zdCBzbmFwc2hvdD1zeW5jQ3VycmVudFBheWxvYWQoKTtjb25zdCBlbnZlbG9wZT1hd2FpdCBzeW5jRW5jcnlwdChzbmFwc2hvdCk7Y29uc3QgcmVzdWx0PWF3YWl0IHN5bmNBcGkoInZhdWx0L2NyZWF0ZSIse3ZhdWx0SWQ6c3luY1N0YXRlLnZhdWx0SWQsZGV2aWNlSWQ6c3luY1N0YXRlLmRldmljZUlkLGRldmljZU5hbWUsZGV2aWNlVG9rZW46c3luY1N0YXRlLmRldmljZVRva2VuLHNjb3BlOiJmdWxsIixlbnZlbG9wZX0pO3N5bmNTdGF0ZS5zZXJ2ZXJSZXZpc2lvbj1yZXN1bHQucmV2aXNpb247c3luY1N0YXRlLmxhc3RTeW5jQXQ9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO3NhdmVTeW5jU3RhdGUoKTtzY2hlZHVsZVN5bmNQb2xsKCk7cmVuZGVyQWxsKCk7dG9hc3QoIkdlcsOkdGUtU3luYyBlaW5nZXJpY2h0ZXQiKTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZT1sb2FkU3luY1N0YXRlKCk7c3luY1N0YXRlLmxhc3RFcnJvcj1lcnJvci5tZXNzYWdlO3NhdmVTeW5jU3RhdGUoKTthbGVydChgR2Vyw6R0ZS1TeW5jIGtvbm50ZSBuaWNodCBlaW5nZXJpY2h0ZXQgd2VyZGVuOiAke2Vycm9yLm1lc3NhZ2V9YCk7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBhc3luYyBmdW5jdGlvbiBjcmVhdGVTeW5jUGFpcmluZygpe2lmKHN5bmNCdXN5fHwhc3luY1N0YXRlLmNvbmZpZ3VyZWQpcmV0dXJuO2lmKHN5bmNTdGF0ZS5yb2xlIT09ImFkbWluIil7dG9hc3QoIk51ciBkYXMgZXJzdGUgVmVyd2FsdHVuZ3NnZXLDpHQga2FubiBuZXVlIEdlcsOkdGUga29wcGVsbiIpO3JldHVybjt9c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7Y29uc3QgcmVzdWx0PWF3YWl0IHN5bmNBcGkoInBhaXIvY3JlYXRlIixzeW5jQXV0aCh7c2NvcGU6ImZ1bGwifSkpOyQoInN5bmNQYWlyVmF1bHQiKS50ZXh0Q29udGVudD1zeW5jU3RhdGUudmF1bHRJZDskKCJzeW5jUGFpckNvZGUiKS50ZXh0Q29udGVudD1yZXN1bHQuY29kZTskKCJzeW5jUGFpclJlY292ZXJ5IikudGV4dENvbnRlbnQ9c3luY1JlY292ZXJ5Rm9ybWF0KHN5bmNTdGF0ZS5yZWNvdmVyeUtleSk7JCgic3luY1BhaXJFeHBpcnkiKS50ZXh0Q29udGVudD1gQ29kZSBnw7xsdGlnIGJpcyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUocmVzdWx0LmV4cGlyZXNBdCkpfWA7JCgic3luY1BhaXJSZXN1bHQiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTt9Y2F0Y2goZXJyb3Ipe3RvYXN0KGVycm9yLm1lc3NhZ2UpO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gam9pblN5bmNWYXVsdCgpe2lmKHN5bmNCdXN5KXJldHVybjtjb25zdCB2YXVsdElkPVN0cmluZygkKCJzeW5jSm9pblZhdWx0SWQiKS52YWx1ZXx8IiIpLnRyaW0oKSxjb2RlPVN0cmluZygkKCJzeW5jSm9pbkNvZGUiKS52YWx1ZXx8IiIpLnRyaW0oKSxyZWNvdmVyeUtleT1zeW5jUmVjb3ZlcnlOb3JtYWxpemUoJCgic3luY0pvaW5SZWNvdmVyeSIpLnZhbHVlKSxkZXZpY2VOYW1lPVN0cmluZygkKCJzeW5jSm9pbkRldmljZU5hbWUiKS52YWx1ZXx8IiIpLnRyaW0oKTtpZighdmF1bHRJZHx8IWNvZGV8fHJlY292ZXJ5S2V5Lmxlbmd0aCE9PTY0fHxkZXZpY2VOYW1lLmxlbmd0aDwyKXt0b2FzdCgiS29wcGx1bmdzZGF0ZW4gdm9sbHN0w6RuZGlnIGVpbmdlYmVuIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3RyeXtjb25zdCBkZXZpY2VJZD1zeW5jR2VuZXJhdGVJZCgiZGV2aWNlIiwxNiksZGV2aWNlVG9rZW49c3luY0dlbmVyYXRlSWQoInRva2VuIiwzMik7Y29uc3QgY2xhaW09YXdhaXQgc3luY0FwaSgicGFpci9jbGFpbSIse3ZhdWx0SWQsY29kZSxkZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VufSk7c3luY1N0YXRlPXtjb25maWd1cmVkOnRydWUsdmF1bHRJZCxkZXZpY2VJZCxkZXZpY2VOYW1lLGRldmljZVRva2VuLHJlY292ZXJ5S2V5LHJvbGU6Y2xhaW0ucm9sZXx8Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOjAsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6IiJ9O3NhdmVTeW5jU3RhdGUoKTtjb25zdCByZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSk7Y29uc3QgcmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUpO2NvbnN0IG1lcmdlZD1zeW5jTWVyZ2VQYXlsb2FkKHN5bmNDdXJyZW50UGF5bG9hZCgpLHJlbW90ZVBheWxvYWQpO3N5bmNBcHBseVBheWxvYWQobWVyZ2VkKTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cmVtb3RlLnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7aWYoc3luY0NvbXBhcmFibGUobWVyZ2VkKSE9PXN5bmNDb21wYXJhYmxlKHJlbW90ZVBheWxvYWQpKXtjb25zdCBlbnZlbG9wZT1hd2FpdCBzeW5jRW5jcnlwdChtZXJnZWQpO2NvbnN0IHB1c2hlZD1hd2FpdCBzeW5jQXBpKCJzbmFwc2hvdC9wdXNoIixzeW5jQXV0aCh7YmFzZVJldmlzaW9uOnJlbW90ZS5yZXZpc2lvbixlbnZlbG9wZX0pKTtzeW5jU3RhdGUuc2VydmVyUmV2aXNpb249cHVzaGVkLnJldmlzaW9uO3N5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzYXZlU3luY1N0YXRlKCk7fXNjaGVkdWxlU3luY1BvbGwoKTtyZW5kZXJBbGwoKTt0b2FzdCgiR2Vyw6R0IGdla29wcGVsdCB1bmQgYWt0dWFsaXNpZXJ0Iik7fWNhdGNoKGVycm9yKXtzeW5jU3RhdGU9e2NvbmZpZ3VyZWQ6ZmFsc2UsdmF1bHRJZDoiIixkZXZpY2VJZDoiIixkZXZpY2VOYW1lOiIiLGRldmljZVRva2VuOiIiLHJlY292ZXJ5S2V5OiIiLHJvbGU6Im1lbWJlciIsc2NvcGU6ImZ1bGwiLHNlcnZlclJldmlzaW9uOjAsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6ZXJyb3IubWVzc2FnZX07c2F2ZVN5bmNTdGF0ZSgpO2FsZXJ0KGBLb3BwbHVuZyBmZWhsZ2VzY2hsYWdlbjogJHtlcnJvci5tZXNzYWdlfWApO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgYXN5bmMgZnVuY3Rpb24gc3luY05vdyh7c2lsZW50PWZhbHNlLHJldHJ5PXRydWV9PXt9KXtpZihzeW5jQnVzeXx8IXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybiBmYWxzZTtzeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtjb25zdCByZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSk7Y29uc3QgcmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUpO2NvbnN0IGxvY2FsUGF5bG9hZD1zeW5jQ3VycmVudFBheWxvYWQoKTtjb25zdCBtZXJnZWQ9c3luY01lcmdlUGF5bG9hZChsb2NhbFBheWxvYWQscmVtb3RlUGF5bG9hZCk7c3luY0FwcGx5UGF5bG9hZChtZXJnZWQpO2xldCByZXZpc2lvbj1yZW1vdGUucmV2aXNpb247aWYoc3luY0NvbXBhcmFibGUobWVyZ2VkKSE9PXN5bmNDb21wYXJhYmxlKHJlbW90ZVBheWxvYWQpKXt0cnl7Y29uc3QgZW52ZWxvcGU9YXdhaXQgc3luY0VuY3J5cHQobWVyZ2VkKTtjb25zdCBwdXNoZWQ9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVzaCIsc3luY0F1dGgoe2Jhc2VSZXZpc2lvbjpyZW1vdGUucmV2aXNpb24sZW52ZWxvcGV9KSk7cmV2aXNpb249cHVzaGVkLnJldmlzaW9uO31jYXRjaChlcnJvcil7aWYoZXJyb3Iuc3RhdHVzPT09NDA5JiZyZXRyeSl7c3luY0J1c3k9ZmFsc2U7cmV0dXJuIGF3YWl0IHN5bmNOb3coe3NpbGVudCxyZXRyeTpmYWxzZX0pO310aHJvdyBlcnJvcjt9fXN5bmNTdGF0ZS5zZXJ2ZXJSZXZpc2lvbj1yZXZpc2lvbjtzeW5jU3RhdGUubGFzdFN5bmNBdD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7c3luY1N0YXRlLmxhc3RFcnJvcj0iIjtzYXZlU3luY1N0YXRlKCk7aWYoIXNpbGVudCl0b2FzdCgiQWxsZSBHZXLDpHRlIGF1ZiBha3R1ZWxsZW0gU3RhbmQiKTtyZXR1cm4gdHJ1ZTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZS5sYXN0RXJyb3I9ZXJyb3IubWVzc2FnZTtzYXZlU3luY1N0YXRlKCk7aWYoIXNpbGVudCl0b2FzdChgU3luYzogJHtlcnJvci5tZXNzYWdlfWApO3JldHVybiBmYWxzZTt9ZmluYWxseXtzeW5jQnVzeT1mYWxzZTtyZW5kZXJTeW5jUGFuZWwoKTt9fQogIGZ1bmN0aW9uIGRpc2Nvbm5lY3RTeW5jKCl7aWYoIWNvbmZpcm0oIkRpZXNlcyBHZXLDpHQgbG9rYWwgdm9tIEVsZGVob2YtU3luYyB0cmVubmVuPyBEaWUgRGF0ZW4gYXVmIGRlbSBHZXLDpHQgYmxlaWJlbiBlcmhhbHRlbi4iKSlyZXR1cm47c3luY1N0YXRlPXtjb25maWd1cmVkOmZhbHNlLHZhdWx0SWQ6IiIsZGV2aWNlSWQ6IiIsZGV2aWNlTmFtZToiIixkZXZpY2VUb2tlbjoiIixyZWNvdmVyeUtleToiIixyb2xlOiJtZW1iZXIiLHNjb3BlOiJmdWxsIixzZXJ2ZXJSZXZpc2lvbjowLGxhc3RTeW5jQXQ6IiIsbGFzdEVycm9yOiIifTtzYXZlU3luY1N0YXRlKCk7c2NoZWR1bGVTeW5jUG9sbCgpO3JlbmRlclN5bmNQYW5lbCgpO3RvYXN0KCJHZXLDpHQgdm9tIFN5bmMgZ2V0cmVubnQiKTt9CiAgZnVuY3Rpb24gcmVuZGVyU3luY1BhbmVsKCl7aWYoISQoInN5bmNQYW5lbCIpKXJldHVybjskKCJzeW5jU2V0dXBCb3giKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHN5bmNTdGF0ZS5jb25maWd1cmVkKTskKCJzeW5jQWN0aXZlQm94IikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc3luY1N0YXRlLmNvbmZpZ3VyZWQpO2NvbnN0IGJhZGdlPSQoInN5bmNCYWRnZSIpO2JhZGdlLmNsYXNzTmFtZT1gc3luYy1iYWRnZSAke3N5bmNCdXN5PyJidXN5IjpzeW5jU3RhdGUubGFzdEVycm9yPyJlcnJvciI6c3luY1N0YXRlLmNvbmZpZ3VyZWQ/Im9rIjoiIn1gO2JhZGdlLnRleHRDb250ZW50PXN5bmNCdXN5PyJzeW5jaHJvbmlzaWVydCDigKYiOnN5bmNTdGF0ZS5sYXN0RXJyb3I/IkZlaGxlciI6c3luY1N0YXRlLmNvbmZpZ3VyZWQ/InZlcmJ1bmRlbiI6Im5pY2h0IGVpbmdlcmljaHRldCI7aWYoIXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjskKCJzeW5jRGV2aWNlVGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5kZXZpY2VOYW1lfHwiZGllc2VzIEdlcsOkdCI7JCgic3luY1JvbGVUZXh0IikudGV4dENvbnRlbnQ9c3luY1N0YXRlLnJvbGU9PT0iYWRtaW4iPyJWZXJ3YWx0dW5nc2dlcsOkdCI6Imdla29wcGVsdGVzIEdlcsOkdCI7JCgic3luY1JldmlzaW9uVGV4dCIpLnRleHRDb250ZW50PVN0cmluZyhzeW5jU3RhdGUuc2VydmVyUmV2aXNpb258fDApOyQoInN5bmNMYXN0VGV4dCIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5sYXN0U3luY0F0P2B6dWxldHp0ICR7Zm9ybWF0RGF0ZVRpbWUoc3luY1N0YXRlLmxhc3RTeW5jQXQpfWA6Im5vY2ggbmllIjskKCJzeW5jU3RhdHVzIikudGV4dENvbnRlbnQ9c3luY1N0YXRlLmxhc3RFcnJvcj9gTGV0enRlciBGZWhsZXI6ICR7c3luY1N0YXRlLmxhc3RFcnJvcn1gOiLDhG5kZXJ1bmdlbiB3ZXJkZW4gYXV0b21hdGlzY2ggYWJnZWdsaWNoZW4uIjskKCJzeW5jU3RhdHVzIikuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke3N5bmNTdGF0ZS5sYXN0RXJyb3I/ImVycm9yIjoib2sifWA7JCgic3luY1BhaXJCdG4iKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLHN5bmNTdGF0ZS5yb2xlIT09ImFkbWluIik7fQoKICBmdW5jdGlvbiBzYXZlQ29zdFNldHRpbmdzKCl7IHNldHRpbmdzLmZhbGxiYWNrUHJpY2U9TWF0aC5tYXgoMCxOdW1iZXIoJCgiZmFsbGJhY2tQcmljZUlucHV0IikudmFsdWUpfHwwKTtzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZT1NYXRoLm1heCgwLE51bWJlcigkKCJkZWZhdWx0QmFzZUZlZUlucHV0IikudmFsdWUpfHwwKTtzYXZlU2V0dGluZ3MoKTtzY2hlZHVsZUNsb3VkU3luYygpO3JlbmRlckFsbCgpO3RvYXN0KCJLb3N0ZW4tRWluc3RlbGx1bmdlbiBnZXNwZWljaGVydCIpOyB9CgogIGZ1bmN0aW9uIHJlbmRlckFsbCgpeyB1cGRhdGVSZWNvdmVyeUJhbm5lcigpO3JlbmRlckRhc2hib2FyZCgpO3JlbmRlclJlY29yZHMoKTtyZW5kZXJBbmFseXNpcygpO3JlbmRlckRhdGEoKTsgfQogIGZ1bmN0aW9uIHJlc2l6ZUNoYXJ0cygpeyBjbGVhclRpbWVvdXQocmVzaXplVGltZXIpO3Jlc2l6ZVRpbWVyPXNldFRpbWVvdXQoKCk9PnsgaWYoY3VycmVudFZpZXc9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7IGlmKGN1cnJlbnRWaWV3PT09ImFuYWx5c2lzVmlldyIpcmVuZGVyQW5hbHlzaXMoKTsgfSwxMDApOyB9CgogIGZ1bmN0aW9uIGJpbmQoKXsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixldmVudD0+ewogICAgICBjb25zdCBuYXY9ZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLW5hdl0iKTsgaWYobmF2KXtzd2l0Y2hWaWV3KG5hdi5kYXRhc2V0Lm5hdik7cmV0dXJuO30KICAgICAgY29uc3QgZWRpdD1ldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtZWRpdC1tb250aF0iKTsgaWYoZWRpdCl7b3BlblJlY29yZE1vZGFsKGVkaXQuZGF0YXNldC5lZGl0TW9udGgpO3JldHVybjt9CiAgICAgIGlmKGV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWxdIikpe2Nsb3NlUmVjb3JkTW9kYWwoKTtyZXR1cm47fQogICAgICBpZihldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtY2xvc2UtbWV0ZXItbW9kYWxdIikpe2Nsb3NlTWV0ZXJNb2RhbCgpO3JldHVybjt9CiAgICB9KTsKICAgICQoImRhc2hib2FyZEFkZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZFJlY29yZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZE1ldGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLG9wZW5NZXRlck1vZGFsKTsKICAgICQoImVkaXRMYXRlc3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pm9wZW5SZWNvcmRNb2RhbCgkKCJlZGl0TGF0ZXN0QnRuIikuZGF0YXNldC5tb250aCkpOwogICAgJCgicmVjb3JkRm9ybSIpLmFkZEV2ZW50TGlzdGVuZXIoInN1Ym1pdCIsc2F2ZUVkaXRlZFJlY29yZCk7IFsicmVjb3JkVG90YWwiLCJyZWNvcmRIZWF0UHVtcCIsInJlY29yZEFubmV4Il0uZm9yRWFjaChpZD0+JChpZCkuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLHVwZGF0ZURlcml2ZWRQcmV2aWV3KSk7CiAgICAkKCJtZXRlckZvcm0iKS5hZGRFdmVudExpc3RlbmVyKCJzdWJtaXQiLHNhdmVNZXRlclJlYWRpbmdGcm9tRm9ybSk7IFsibWV0ZXJEYXRlIiwibWV0ZXJUb3RhbCIsIm1ldGVyQW5uZXgiXS5mb3JFYWNoKGlkPT4kKGlkKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsdXBkYXRlTWV0ZXJQcmV2aWV3KSk7CiAgICAkKCJ1bmRvTGF0ZXN0TWV0ZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsdW5kb0xhdGVzdE1ldGVyUmVhZGluZyk7CiAgICAkKCJyZWNvcmRZZWFyRmlsdGVyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJSZWNvcmRzKTsgJCgiYW5hbHlzaXNZZWFyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJBbmFseXNpcyk7CiAgICAkKCJyZXN0b3JlU2hhZG93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHJlc3RvcmVTaGFkb3cpOyAkKCJleHBvcnRCYWNrdXBCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXhwb3J0QmFja3VwKTsgJCgiZXhwb3J0Q3N2QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV4cG9ydENzdik7ICQoImltcG9ydEJhY2t1cElucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+e2NvbnN0IGY9JCgiaW1wb3J0QmFja3VwSW5wdXQiKS5maWxlcz8uWzBdO2lmKGYpaW1wb3J0QmFja3VwKGYpO30pOwogICAgJCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+aW1wb3J0VmFpbGxhbnRDc3ZGaWxlcygkKCJ2YWlsbGFudENzdkZpbGVzSW5wdXQiKS5maWxlcykpOwogICAgJCgic2F2ZU9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQW5kQ2hlY2tPc3Ryb20pOyAkKCJkaXNjb25uZWN0T3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGRpc2Nvbm5lY3RPc3Ryb20pOyAkKCJyZWZyZXNoT3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5yZWZyZXNoT3N0cm9tKHRydWUpKTsgJCgicmVmcmVzaE9zdHJvbUhpc3RvcnlCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PnJlZnJlc2hPc3Ryb21IaXN0b3J5KCkpOyAkKCJyZWZyZXNoT3N0cm9tUHJpY2VTdGF0c0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+cmVmcmVzaE9zdHJvbVByaWNlU3RhdHMoTnVtYmVyKCQoImFuYWx5c2lzWWVhciIpLnZhbHVlKXx8bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpKSk7ICQoImdvT3N0cm9tU2V0dGluZ3NCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pntzd2l0Y2hWaWV3KCJkYXRhVmlldyIpO3NldFRpbWVvdXQoKCk9PiQoIm9zdHJvbVNldHRpbmdzUGFuZWwiKS5zY3JvbGxJbnRvVmlldyh7YmVoYXZpb3I6InNtb290aCIsYmxvY2s6InN0YXJ0In0pLDEwMCk7fSk7CiAgICAkKCJzeW5jQ3JlYXRlQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGNyZWF0ZVN5bmNWYXVsdCk7ICQoInN5bmNKb2luQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGpvaW5TeW5jVmF1bHQpOyAkKCJzeW5jTm93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5zeW5jTm93KHtzaWxlbnQ6ZmFsc2V9KSk7ICQoInN5bmNQYWlyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGNyZWF0ZVN5bmNQYWlyaW5nKTsgJCgic3luY0Rpc2Nvbm5lY3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZGlzY29ubmVjdFN5bmMpOwogICAgJCgic2F2ZUNvc3RTZXR0aW5nc0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQ29zdFNldHRpbmdzKTsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJyZXNpemUiLHJlc2l6ZUNoYXJ0cyk7IGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoInZpc2liaWxpdHljaGFuZ2UiLCgpPT57aWYoZG9jdW1lbnQuaGlkZGVuKXJldHVybjtpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe2NvbnN0IGFnZT1EYXRlLm5vdygpLURhdGUucGFyc2Uob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKTtpZighTnVtYmVyLmlzRmluaXRlKGFnZSl8fGFnZT4xMCo2MGUzKXJlZnJlc2hPc3Ryb20oZmFsc2UpO31pZihzeW5jU3RhdGUuY29uZmlndXJlZClzeW5jTm93KHtzaWxlbnQ6dHJ1ZX0pO30pOwogICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsZXZlbnQ9PntpZihldmVudC5rZXkhPT0iRXNjYXBlIilyZXR1cm47aWYoISQoInJlY29yZE1vZGFsIikuY2xhc3NMaXN0LmNvbnRhaW5zKCJoaWRkZW4iKSljbG9zZVJlY29yZE1vZGFsKCk7ZWxzZSBpZighJCgibWV0ZXJNb2RhbCIpLmNsYXNzTGlzdC5jb250YWlucygiaGlkZGVuIikpY2xvc2VNZXRlck1vZGFsKCk7fSk7CiAgfQoKICBmdW5jdGlvbiBpbml0KCl7CiAgICBhcHBseUhpc3RvcmljYWxTZWVkKCk7ZW5zdXJlTWV0ZXJCYXNlbGluZSgpOwogICAgYmluZCgpO3JlbmRlckFsbCgpO3NjaGVkdWxlT3N0cm9tKCk7c2NoZWR1bGVTeW5jUG9sbCgpOwogICAgaWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXsgY29uc3QgYWdlPURhdGUubm93KCktRGF0ZS5wYXJzZShvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpOyBpZighb3N0cm9tTGl2ZXx8IU51bWJlci5pc0Zpbml0ZShhZ2UpfHxhZ2U+MTAqNjBlMylyZWZyZXNoT3N0cm9tKGZhbHNlKTsgc2V0VGltZW91dCgoKT0+cmVmcmVzaE9zdHJvbUhpc3Rvcnkoe3NpbGVudDp0cnVlLG9ubHlNaXNzaW5nOnRydWUsbWF4TW9udGhzOjJ9KSw0MjAwKTsgfQogICAgaWYoc3luY1N0YXRlLmNvbmZpZ3VyZWQpc2V0VGltZW91dCgoKT0+c3luY05vdyh7c2lsZW50OnRydWV9KSw2NTApOwogICAgaWYoInNlcnZpY2VXb3JrZXIiIGluIG5hdmlnYXRvcil3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigibG9hZCIsKCk9Pm5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLnJlZ2lzdGVyKCJzdy5qcz92PTYuMi4xIikuY2F0Y2goKCk9Pnt9KSk7CiAgICBjb25zb2xlLmluZm8oYEVsZGVob2YgJHtBUFBfQlVJTER9YCk7CiAgfQogIGluaXQoKTsKfSkoKTsK","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/sw.js":{"body":"Y29uc3QgQ0FDSEU9ImVsZGVob2YtdjYtMi0xLXN5bmNmaXgtMjAyNjEwMzEiOwpjb25zdCBDT1JFPVsiLi8iLCIuLz92PTYuMi4xIiwiLi9pbmRleC5odG1sIiwiLi9zdHlsZXMuY3NzP3Y9Ni4yLjEiLCIuL2FwcC5qcz92PTYuMi4xLXN5bmNmaXgtMjAyNjEwMzEiLCIuL21hbmlmZXN0LndlYm1hbmlmZXN0IiwiLi9pY29uLTE5Mi5wbmciLCIuL2ljb24tNTEyLnBuZyJdOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImluc3RhbGwiLGV2ZW50PT57ZXZlbnQud2FpdFVudGlsKGNhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMuYWRkQWxsKENPUkUpKS50aGVuKCgpPT5zZWxmLnNraXBXYWl0aW5nKCkpKX0pOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImFjdGl2YXRlIixldmVudD0+e2V2ZW50LndhaXRVbnRpbChjYWNoZXMua2V5cygpLnRoZW4oa2V5cz0+UHJvbWlzZS5hbGwoa2V5cy5maWx0ZXIoaz0+ayE9PUNBQ0hFKS5tYXAoaz0+Y2FjaGVzLmRlbGV0ZShrKSkpKS50aGVuKCgpPT5zZWxmLmNsaWVudHMuY2xhaW0oKSkpfSk7CnNlbGYuYWRkRXZlbnRMaXN0ZW5lcigiZmV0Y2giLGV2ZW50PT57CiAgY29uc3QgdXJsPW5ldyBVUkwoZXZlbnQucmVxdWVzdC51cmwpOwogIGlmKGV2ZW50LnJlcXVlc3QubWV0aG9kIT09IkdFVCJ8fHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCIvYXBpLyIpKXJldHVybjsKICBldmVudC5yZXNwb25kV2l0aChmZXRjaChldmVudC5yZXF1ZXN0KS50aGVuKHJlc3BvbnNlPT57Y29uc3QgY29weT1yZXNwb25zZS5jbG9uZSgpO2NhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMucHV0KGV2ZW50LnJlcXVlc3QsY29weSkpO3JldHVybiByZXNwb25zZTt9KS5jYXRjaCgoKT0+Y2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4oY2FjaGVkPT5jYWNoZWR8fGNhY2hlcy5tYXRjaCgiLi9pbmRleC5odG1sIikpKSk7Cn0pOwo=","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/manifest.webmanifest":{"body":"ewogICJuYW1lIjogIkVsZGVob2YgNi4yLjEg4oCTIFZlcmJyYXVjaHNidWNoIiwKICAic2hvcnRfbmFtZSI6ICJFbGRlaG9mIiwKICAiZGVzY3JpcHRpb24iOiAiU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4g4oCTIG1pdCBrb21wYWt0ZXIgT3N0cm9tLVByZWlzw7xiZXJzaWNodC4iLAogICJzdGFydF91cmwiOiAiLi8/dj02LjIuMSIsCiAgInNjb3BlIjogIi4vIiwKICAiZGlzcGxheSI6ICJzdGFuZGFsb25lIiwKICAib3JpZW50YXRpb24iOiAicG9ydHJhaXQtcHJpbWFyeSIsCiAgImJhY2tncm91bmRfY29sb3IiOiAiIzA2MTAxYyIsCiAgInRoZW1lX2NvbG9yIjogIiMwNzExMWYiLAogICJpY29ucyI6IFsKICAgIHsic3JjIjoiaWNvbi0xOTIucG5nIiwic2l6ZXMiOiIxOTJ4MTkyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifSwKICAgIHsic3JjIjoiaWNvbi01MTIucG5nIiwic2l6ZXMiOiI1MTJ4NTEyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifQogIF0KfQo=","type":"application/manifest+json; charset=utf-8","cache":"no-cache"},"/icon-192.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFk0lEQVR42u3du24TQRiG4fVoBShpkKJ0hi6iTEqKKAURJbdASZcqN5AbSJWOkkuAEoUiSkFLSW/RWC6RKFxQWFrlZO96ZnbmP7xfGeWwh8ffzOx6ncnOwVFDbGU5XxT7W4HDbS/t/h6AiI4AiBICEKGBiNISAhCGAEQYwojSEgIQARCpV0IAIgAi9UoIQARApF4JAYgAiNQrIQARABEAEaWjGIAIgEi9EgIQSeOobotPLqe2T8nN+UzR1k7kPxdmXkwVTLmeHZMLaJ2b27OZYTHHV9MykiwDekzHNpqtPOWSZBPQXTpu0QyRlIVRFkNSAEEnQlIiIyOAoFOLkQVAnR7opDCKM6QbEHQkVFG6oTqA0COkitIBBfQYSHcky190Ld1Aqz2EzqhVNLyHlDUQespU0fAeSr8zH9Dj3JAOQOixaiigB0OiAaHHtqFQQA+pm81nIXEeHYq9FEitEtLaQAxeHgaygB4MKVjGE6sZBRD146eEaCAiDBD146qEaCCSdCkoMyDqx1sJ0UBEDCCT9fPp+g0lRAMl6TFmiEl0he7B0NoJeN7xy/Cwtfri59PfNvbx5HKa5fnozA1kYAK0uWwMVFHec8QQtrUPhjMApcrAEIBSTWAoJyDtV4DiNNz9qT9fD9VNg7Kse1rnL6DEIjG2NGMIK6pHaf0ASJYe5kDoScrF3xeeRQb00GoAqnaOu/pxa6iFzkh/yMnSLKAnY/04rKKAHhZ6KZ9TFtAzRv346aGAHnoIQKXP3MD68WCohQ5LMxqoqJ5t68d2FQX0sIUAKnduUurHpKGAHudbm/hh9QE9hevHWA+10GFp5reBSurJWz9mXgMBPeyLR0CFj/h49VPXUPq/e2rRUx3Zxe6/br/UzYcCeurWT6dH6VjWQqdmad3Xo3FpFtBTffaj+tUS0COqftTtdUBPlfrp1aPFUECPwO5RdAQCegrXz1Z65BtqoaNoFihwaRbQI7x+hL+uAnpkTn20HB9xQ9iQlpb8rudEPdzKIGN1D5Noy+d7Q2kZ1kMDiZ5xA4gYrx9rQ9jV2+/Dv/ns5/ux62fv9FuZbaCBSuuJ+P5t06unwDYASOvsZ4ge5kCEAIj6AZCouNIDoMz1400PgLKSsn7JB0Cjz34ARKif7cLN1HsZcmVvcf0BPTRQpJ4nJ84GLigDqJCeB/XTLbvcGgIQAVBUIu6Er6ufktsAIBEg0s/ck3oKbwOrsPqlElc/G7rHBguGsBHj8H4FgLLVD3oARABE/QCIqQ+AHNUPegBE9wCo3uyHAIj6AVDx+kEPgOgeABEAEQARAiACIAIgAiBCsgM6vppyQFVkdaZ+fPwlBdDN+azk/qv+R+vG9oshjLgEZK+ElO5R4Iivkvg4TuKP6309THYOjnL9rpPLadM0t2ezwvuQ8X+vxD3inqKnPJ2MM+jGxoOFGc/B893XjKfbDWHL+YKZIEmaAy3niyyMVot5rgZJTt7x694kmioiqaswDJHUZXzicMYo5mr8atZdB6KKSBKglCqihPzUT9N7JZoqIkmA4qqIEnJSP83we2FxVYQhOXqqNVBcFRV+hxDpzRj100TcjR/OiIHM9uAVCSiijTBkVU+T+H6gXkYMZFanPnkADWHEQGZy6pMTUC8jDJkcvFaZPHv5aozf2+7vPfhKrfcrokdHA/UWEj1kT8+IDbSukOihArPmYnrKAboraWUIRgb0NOUf61nOF90eMpxp11Ohgbq8+3JID6mmUxkQjAzoqQ/oriEYRdCpq0cEIBgppSMLEIyGuxFCRyKgx4ycY3q8UJVDRy6gdYw8YFp3aUOaGwWAeiV5iFg3mgC58iRfjHpARFT4jEQCIAIgAiACIEIARABEAEQARAiACIAIgAiACAEQARABEAEQIQAiACIAIgAibvMfGKe/xgpKwHYAAAAASUVORK5CYII=","type":"image/png","cache":"public, max-age=31536000, immutable"},"/icon-512.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAPpUlEQVR42u3dvW5UVxcG4OORFUWkiYToSIkooaRAFEEucwsp6VxxA9wAlTvKXEJSIlIgCtqU9CiN5TJSChcpiCw09gwz4/Oz93qfp8ynLzFnznnftc62zdGdB48HgIouzy9chC1WLgGAAgAo5fjeXRdBAQCgAABLAAoA0AEKAAAFAGAJUAAAOkABAKAAACwBCgAABQBgCVAAACgAAEuAAgDQAQoAAAUAYAlQAAAoAABLgAIAQAEAWAIUAAAKAMASoAAAUAAAlgAFAKADFAAACgAgfglQAAA2AABLgAIAQAEAoAAAqot6C6QAAGwAACQtAQoAwAYAQNISoAAAbAAAJC0BCgDABgBA0hKgAABsAAAoAACG6m+BFACADQCApCVAAQDYAABIWgIUAIANAAAFAMDXSr4FUgAANgAAFAAAa+q9BVIAADYAAJKWAAUAYAMAQAEAcKNKb4EUAEBqmbkEIZ69vu8isKP3Lz+7CAmO7jx47CrIelAMe7k8v1AAiHv0gQJQAAh9lIECUADIfZSBDlAACH00gQJQACyd+x9OneCxk6dnI99+JZtAAdBi9At6mm2FYk3QewcogAq5L/HprhJqNIECYJnoF/oUKIPea0ABMF/0C31KNkHXNdB1BygAuQ9NlEGnNaAAmCT65T5qQAEogLj0F/2EN0FfNdBvByiAhqJf7qMJeqwBBYDoh9AaUACIfpiqBhrvAAXA3ukv+qFMDXTaAQpA9IMaUABMn/6iH25fAw12gAIQ/aIfcmugxw5QAJOnv+iHhA5QANJf+sOsNdBOBygA0S/6IbQGeiyAlRtL+kP7tj9TLfzNqcf37toA0tNf9MNSq8Die0B3S4ACMPiDDlAASH/ovwMWrAEFkJj+oh+sAj12gENg6Q+92vL0tXAsrACkP6ADGuUV0IHpL/qhHe28C+rrFZACkP5QvAbm7ABnANIfWMCmZ3POd0F9/TiYApD+oANCKQDpDzpAASD9QQcoAOkv/UEHKADpL/1BB+yho3NgBSD9QQfYAKS/9IeYDkABuG8g9Fm2BCiAjfeB9AcdoACkP5CVALfXyznwymcPxC4B4TngFZDxHzzdCsD47/6AyA6IXQJCC0D6gw7QAYkF4NU/IBkGZwDGf/C8T6GLbwSKKwAvf4DBi6DAApD+gA7I3QAAiCsA4z9gCUgsAOkP6IDcDQCAuAIw/gPzLwHtfyfoyucNYAMIGv8BZlgCFIDxH5AMCsD4D8gQBbDUJ2f8BywBERsAgCUgrgCM/4AlwAYAsMwS0PiPAgQVgPEfkBX1C8A3/wBSxQZg/AckRkwBGP8B2WIDMP4DciOmAIz/gISxARj/AemRXQAA1C8A738AOWMDSNngABmiAIz/gLSxARj/gWaSpOVfB+QQmGgv3j10EYhVpAC8/+Hg9NcBxGZO2Q3A+x92n/11AJl5cuyjJTn61/7hm+efXB9yOANA+u/6v4ICaM71l3He/3BwvusAbnQ9VQocA9gAkP46ABsASH8dQJLuD4F9AygTRbljYXbJn/cvO37hXHADcADAiIO8VYDC2eIVENJfBxBKASD9dQAKoEMOAJgtr3UA9VKo2k8COwAQ/VP/yx0LJ/tw+vnpmb8QBsLS3ypAPQoA6a8DUAAg/XUACgCkvw6gvKM7Dx53+qX7HXA0EsGOhdNcPwfe/vPAl+cXNgCoOYBbBeiUAkD6z/H1/P37I58aCgBqTtz2ABQA5Obspq/N+E+b/J3AiP7xv0jHwtgAICv9b/xqjf8ogJH5NXDS39eMRLIB/M8PAUj/Br9y439JZdLGKyCkP4RSAEj/qbz653sfIi3zXUCIfrABgPSfcvzXaigAyJ39dQAKAIrn45a3/zoABQC5yagDojT7u6AHh8AIxDnH/7U/st8YgQ0A6e/PDgoACRgw/usAFADSX/a5DigApF7k+K8DWJZDYER/Q5fFsTA2AKR/0PivHVEASH9cJRQAci1y/NcBKACkP64Yc3AIjCBra/xfu3SOhbEBIP1dQ/rT8i8CUgBIrkbHfx2AAkD643qiAJBWkeO/DmA6DoERUp1dXsfC2ACQ/kHjv5ZFASD9cbVRAMijyPFfB6AAkP648q1r/IcABofACKAex/+1j8CxMDYApL/PAhQAEidg/PeJoACQNfhcUABImcjx36fDYRwCI1wKfkyOhbEBIP2Dxn+fV1Pa/x5QBYA08alhAwA5UmX899mhAJAg+ATZxiEwgqPm+L/2UToWxgaA9PeZggJAUgSM/z7ZRXTxLUAKABnh88UGANKh9PjvU+Y6h8AIhdCP27EwNgCkf9D473NHASAF8OlPpZcTYAXg+ff8h47/7gEUgPQHd0Iuh8AeeHLH/7VbwrGwDQDpj3sDBYAn3PjvDmEfHZ0AKwDPNrhPbAB4qokf/90taRwCe5hh423jWNgGgPQ3/rt/UAB4enEXsUFfJ8CDV0CeW2Yb/1teL1798O/2e8m7IBsA0p+Kzbc1/d1RCgDpb/zPTX/3VVVeAYl+2O8G8zroRt0dANgApD/Gf3daLgUg/UmtvYPS3/2mAJD+xv/c9HfXKQCkP7np796rwSGw6Df+S//b3oSOhW0ASH/cjSgAPG/G/4Dx3z2pAJD+pKe/O1MBIP2N/7np7/7skUNg0Y/0H/9GdSxsA0D6G/+z0t8dqwDwLIH7VgHgKTL+543/7l4FgOeH6PR3D7fPIbDoN/5L/zluZsfCNgCkP1np765WAHhOjP/R6e/eVgB4QnCHu8MVAJ4N43/Y+O8+b5BDYI8E0n+ZG96xsA0A6W/8z0p/d74CwDNAdPq7/1vgFdDCJt2CPV0h4//U6e9djQ0AAAUAxv+Y8R8FAEh/FAAY/6U/JTgExoDcZRVJf2wAkLiISH8UAAAKAIz/oACgcp1IfxQABI7/0h8FAGZ/UACQMf5LfxQAAAoAjP9wO34SmG87e/J2hv/K6ccTl/q6u8//cIWxAVA5/ef8D3U0/o+Y/sWuMAqAaqEsoaZLf1cYBUDrYVEgoUYZ/6dIfx2AAqD1mJBQrjAKAIz/oAAghvRHAUDi+C/9UQBg9gcFABnjv/RHAQCgAMD4DwoACpP+KABIHP+lPwoAzP6gACBj/Jf+KAAAFADEjP/+ki8UAETWhvRHAUDg+C/9UQBg9gcFADHjPygAMP6DAoCM8V/6owDA7A8KADLGf+lPs45dAoo5e/J22gJ494v0xwYAcel/sU/6z/D1gAKA4ezJ29bS9suve9MBKADo3l7j/9e/7FMHoABgwvG/wdm/5a8QFADSf/zxf9Mv+tcBKACozF/zggKAUvb95h9QAGD8BwUA1cd/6Y8CALM/KAA4yOnHk77G/+7Sv6krjAJARsTN/q4wCgAd0Pf47wqjANABidl0+5c/rjAKgPQOOP140lo2fXP8H+vVf+wVZnH+PgCMjcvM/q4wNgBo0fbx3zd9ogDA7A8KAGLGf1AAYPwHBQAZ47/0RwGA2R8UAGSM/9IfBQBmf1AAEDP+gwIA4z8oAMgY/6U/CgDM/qAAIGP8l/4oADD7gwKAmPEfFAAY/0EBQMb4L/1RAGD2BwUAGeO/9EcBgNkfFADEjP+gAMD4DwoAMsZ/6Y8CALM/KADIGP+lPygAzP6gACBm/AcUAMZ/UACQMf5Lf1AAmP1BAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAK45v3Lz2v/5OnZfR8nMIPrafPnr38pAAAUAAAKAAAFAIACAEABAKAAbsV3gq558/yTi4C7SM4ULIDrPwoAML9Ofwhg8AoIIJYCsL+D+0cBAKAAMMSBO0cBNM2vhPMk456ZU5lfA2cDAKS/DQCPdM9OP574Ot0qKAA82LhJ2NXRnQePe/8zPHu9/lbuw6mfEdvmxbuH9f5QZ0/eGv+l/6SKHQDYAEx5dbScsNIfBUBbT3u9B77NnG0//UveDOyi5iugwVugPVV6KdTOu6DGo1/o7+XGbzHv/RVQhQIYHAMAsxdA7+k/DMPq8vzCRwsQaDUMgw4ACC2AAh3gd0IA0yn5/mf4+ruA7AEAiRtAyQ6wBACSZNcC+NIBndaAvyESmEeN9z/Dph8E8zoIoLyNPwlcowO8BQJkyN4FMHT4OshbIGBqZd7/DLv8LiCvgwDjf9wGUKMDvAUCjP+HF8DQz+sgb4EARi6ArlcBSwAgN25bAF10gCUAmEKx9z/DYX8hTI8/LGYJACTGCAXQ/ipgCQCM/xMWQHergCUAkBWjFUDLq4AlADD+T14AHa0ClgBASoxcAG2uApYAwPg/UwF0sQpYAgD5MEkBtLYKWAIA4/+sBdD4KmAJACTDhAXQTg3cuAToAOCbmVB7/J+8AK5qwO0FkFgAi68ClgDA+L9YASxeA06DAem/ZAFc1UDLHzxAiNUi/9VFVgEvggDj//IFsGANAEj/5Qtg/hqwBAA0VAAz14AOAIz/bRXAVQ00dTcA0l8BlFoFfEsoSH9aLIB5asCLICB8/G+3AGaoAR0Axv/k9G+9AObZBnQASH8FEFcDmw4DdACEpH+4VV9f7ug14EAYktM/efwfhuHoux9/6verP753d5R/z7PXN9wcH051A0h/G0D1hcCBMKSR/t0XwLg1oAMgZPyX/nUKYJQacCAMIenPlb7PALY47HjgxsOAwXkAFEp/43/BDWCUhcAeANLfBhC9ENgDQPrbAEIXAnsASH8bQPRCYA+AGtEv/RXAIU2gA0D6K4DcJtjUAWoApH/vVi7BF5sOCbb8siBHAiD9bQD1dwJ7AEh/BZDbBDoAeol+6a8Axvfzb4+2/K9qAAz+CiC3BnQASH8FoAOAWaNf+iuAJjpADYD0VwA6ABD9CkANANJfAaR1gBqAKaJf+isAHQAGfxSAGgCDPwqg5Q5QAyD6FYAaUAOwa/RLfwVQrQPUAIh+BaAG1ACiX/orADUAcl/0K4DMGtAEiH7RrwDUgBogK/dFvwJQA5oA0Y8CUAOagNKhL/oVgBp4dMD/SxnQe+6LfgXArWpAGdBd6Mt9BcAkTaAPaDDuRb8CYO4aUAwsm/VyXwHQYhPAPOS+AkAZIPdRAGgChD4KAGWA0EcBoBKQ+CgAtAKCHgUAwKRWLgGAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgAABQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAEv6D8v4I+AK37xrAAAAAElFTkSuQmCC","type":"image/png","cache":"public, max-age=31536000, immutable"}};

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
