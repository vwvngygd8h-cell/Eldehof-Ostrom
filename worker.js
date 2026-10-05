const ELDEHOF_BUILD = "6.2.0-GERAETE-SYNC-JAHRESVERGLEICH-OSTROM-HISTORIE-20261005";
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
          consumptionComponents: "total-heatpump-annex-schlee-klus",
          analysis: "annual-allocation-comparison-cost-cop",
          ostromDashboard: "current-price-best-window-worst-window",
          ostromAutoRefreshMinutes: 10,
          ostromWindowHours: "one-to-four-user-selectable",
          ostromCredentials: "existing-local-app-key-preserved",
          localShadowBackup: true,
          emptyStartupOverwriteProtection: true,
          privateBackup: "records-vaillant-relevant-settings",
          csvExport: true,
          automaticDeviceSync: "encrypted-durable-object-active-app",
          multiYearComparison: "all-years-current-solid-past-dashed",
          ostromHistoricalCosts: "hourly-price-plus-consumption-where-available",
          historicalMonthBoundary: "Europe/Berlin",
          legacyFeatureDataDeleted: false,
          legacyFeaturesVisible: false,
          syncBackendRetainedButHidden: false,
          syncUi: "data-view-device-sync",
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
          mergeMode: "client-side-three-way-record-level",
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

function zonedBerlinToUtcIso(year, month, day, hour = 0) {
  const target = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(guess));
    const get = type => Number(parts.find(part => part.type === type)?.value);
    const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}

function monthRange(month) {
  const [year, m] = month.split("-").map(Number);
  const nextYear = m === 12 ? year + 1 : year;
  const nextMonth = m === 12 ? 1 : m + 1;
  return {
    startDate: zonedBerlinToUtcIso(year, m, 1, 0),
    endDate: zonedBerlinToUtcIso(nextYear, nextMonth, 1, 0)
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

const EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjIuMCDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPGxpbmsgcmVsPSJpY29uIiBocmVmPSJpY29uLTE5Mi5wbmciPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0ic3R5bGVzLmNzcz92PTYuMi4wIj4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwLXNoZWxsIj4KICA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPgogICAgPGRpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPjxzcGFuIGNsYXNzPSJicmFuZC1tYXJrIj7ijII8L3NwYW4+PHNwYW4+RWxkZWhvZjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3VidGl0bGUiPlZlcmJyYXVjaHNidWNoPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJidWlsZC1waWxsIj42LjIuMDwvc3Bhbj4KICA8L2hlYWRlcj4KCiAgPG1haW4+CiAgICA8ZGl2IGlkPSJyZWNvdmVyeUJhbm5lciIgY2xhc3M9ImJhbm5lciB3YXJuaW5nIGhpZGRlbiIgcm9sZT0ic3RhdHVzIj4KICAgICAgPGRpdj48c3Ryb25nPkxva2FsZSBTaWNoZXJoZWl0c2tvcGllIGdlZnVuZGVuPC9zdHJvbmc+PHNwYW4+RGVyIG5vcm1hbGUgTW9uYXRzZGF0ZW5zcGVpY2hlciBpc3QgbGVlciwgYWJlciBlaW5lIGZyw7xoZXJlIGxva2FsZSBLb3BpZSBpc3Qgdm9yaGFuZGVuLjwvc3Bhbj48L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0icmVzdG9yZVNoYWRvd0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldpZWRlcmhlcnN0ZWxsZW48L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IGFjdGl2ZSIgaWQ9ImRhc2hib2FyZFZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGFzaGJvYXJkVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPsOcQkVSU0lDSFQ8L3NwYW4+PGgxIGlkPSJkYXNoYm9hcmRUaXRsZSI+VmVyYnJhdWNoIGF1ZiBlaW5lbiBCbGljazwvaDE+PHA+TnVyIGRhcyBXZXNlbnRsaWNoZTogWsOkaGxlcnN0w6RuZGUsIFfDpHJtZXB1bXBlIHVuZCBPc3Ryb20tUHJlaXNlLjwvcD48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBpZD0iZGFzaGJvYXJkQWRkQnRuIiB0eXBlPSJidXR0b24iPisgWsOkaGxlcnN0w6RuZGU8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgbGF0ZXN0LXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5MRVRaVEVSIE1PTkFUPC9zcGFuPjxoMiBpZD0ibGF0ZXN0TW9udGhUaXRsZSI+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZTwvaDI+PC9kaXY+PGJ1dHRvbiBpZD0iZWRpdExhdGVzdEJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IGhpZGRlbiIgdHlwZT0iYnV0dG9uIj5CZWFyYmVpdGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQiIGlkPSJsYXRlc3RNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0iY29tcGFyaXNvbi1saW5lIiBpZD0ibGF0ZXN0Q29tcGFyaXNvbiI+PC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgb3N0cm9tLXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj4KICAgICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0PC9oMj48c21hbGwgaWQ9Im9zdHJvbVN0YXR1cyI+Tm9jaCBuaWNodCBnZWxhZGVuPC9zbWFsbD48L2Rpdj4KICAgICAgICAgIDxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5Ba3R1YWxpc2llcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0ib3N0cm9tU2V0dXBIaW50IiBjbGFzcz0iZW1wdHktc3RhdGUgaGlkZGVuIj48c3Ryb25nPk9zdHJvbSBpc3Qgbm9jaCBuaWNodCBlaW5nZXJpY2h0ZXQuPC9zdHJvbmc+PHNwYW4+RGVuIEVsZGVob2YtQXBwLVNjaGzDvHNzZWwgZmluZGVzdCBkdSB1bnRlciBEYXRlbiDihpIgT3N0cm9tLjwvc3Bhbj48YnV0dG9uIGlkPSJnb09zdHJvbVNldHRpbmdzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+RWlucmljaHRlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9Im9zdHJvbURhc2hib2FyZCIgY2xhc3M9Im9zdHJvbS1ncmlkIj4KICAgICAgICAgIDxhcnRpY2xlIGNsYXNzPSJwcmljZS1jYXJkIGN1cnJlbnQiPjxzcGFuPkFrdHVlbGxlciBQcmVpczwvc3Bhbj48c3Ryb25nIGlkPSJvc3Ryb21DdXJyZW50UHJpY2UiPuKAkzwvc3Ryb25nPjxzbWFsbCBpZD0ib3N0cm9tQ3VycmVudE1ldGEiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgPGFydGljbGUgY2xhc3M9InByaWNlLWNhcmQgYmVzdCI+PHNwYW4gaWQ9Im9zdHJvbUJlc3RMYWJlbCI+QmVzdGVzIFplaXRmZW5zdGVyPC9zcGFuPjxzdHJvbmcgaWQ9Im9zdHJvbUJlc3RQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21CZXN0TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8YXJ0aWNsZSBjbGFzcz0icHJpY2UtY2FyZCB3b3JzdCI+PHNwYW4gaWQ9Im9zdHJvbVdvcnN0TGFiZWwiPlNjaGxlY2h0ZXN0ZXMgWmVpdGZlbnN0ZXI8L3NwYW4+PHN0cm9uZyBpZD0ib3N0cm9tV29yc3RQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21Xb3JzdE1ldGEiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgcHJpY2UtY2hhcnQtd3JhcCI+PGNhbnZhcyBpZD0ib3N0cm9tTWluaUNoYXJ0IiBhcmlhLWxhYmVsPSJPc3Ryb20gUHJlaXN2ZXJsYXVmIj48L2NhbnZhcz48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGRhc2hib2FyZC1jaGFydC1wYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+VkVSTEFVRjwvc3Bhbj48aDI+R2VzYW10dmVyYnJhdWNoPC9oMj48L2Rpdj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgZGF0YS1uYXY9ImFuYWx5c2lzVmlldyIgdHlwZT0iYnV0dG9uIj5BdXN3ZXJ0dW5nIMO2ZmZuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC13cmFwIj48Y2FudmFzIGlkPSJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IiBhcmlhLWxhYmVsPSJHZXNhbXR2ZXJicmF1Y2ggZGVyIGxldHp0ZW4gTW9uYXRlIj48L2NhbnZhcz48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iY29uc3VtcHRpb25WaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImNvbnN1bXB0aW9uVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlZFUkJSQVVDSDwvc3Bhbj48aDEgaWQ9ImNvbnN1bXB0aW9uVGl0bGUiPk1vbmF0c3dlcnRlPC9oMT48cD5HZXNhbXQtIHVuZCBBbHRlbnRlaWwtVmVyYnJhdWNoIGVudHN0ZWhlbiBhdXMgZGVuIFrDpGhsZXJzdMOkbmRlbi4gV8Okcm1lcHVtcGUga29tbXQgYXVzIGRlciBteVZBSUxMQU5ULUNTVjsgU2NobGVlL0tsdXMgd2lyZCBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJhZGRSZWNvcmRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdG9vbGJhciI+PHN0cm9uZyBpZD0icmVjb3JkQ291bnQiPjAgTW9uYXRlPC9zdHJvbmc+PHNlbGVjdCBpZD0icmVjb3JkWWVhckZpbHRlciIgYXJpYS1sYWJlbD0iSmFociBmaWx0ZXJuIj48b3B0aW9uIHZhbHVlPSJhbGwiPkFsbGUgSmFocmU8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJyZWNvcmRMaXN0IiBjbGFzcz0icmVjb3JkLWxpc3QiPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJhbmFseXNpc1ZpZXciIGFyaWEtbGFiZWxsZWRieT0iYW5hbHlzaXNUaXRsZSI+CiAgICAgIDxkaXYgY2xhc3M9InBhZ2UtaGVhZCI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+QVVTV0VSVFVORzwvc3Bhbj48aDEgaWQ9ImFuYWx5c2lzVGl0bGUiPlZlcmJyYXVjaCB2ZXJzdGVoZW48L2gxPjxwPkphaHJlc3dlcnRlLCBBdWZ0ZWlsdW5nLCBLb3N0ZW4gdW5kIFfDpHJtZXB1bXBlbi1FZmZpemllbnouPC9wPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGZpbHRlci1wYW5lbCI+CiAgICAgICAgPGxhYmVsPkphaHIgZsO8ciBLZW5uemFobGVuPHNlbGVjdCBpZD0iYW5hbHlzaXNZZWFyIj48L3NlbGVjdD48L2xhYmVsPgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCBmaWx0ZXItbm90ZSI+SW0gSmFocmVzdmVyZ2xlaWNoIHdlcmRlbiBhdXRvbWF0aXNjaCBhbGxlIHZvcmhhbmRlbmVuIEphaHJlIGFuZ2V6ZWlndC4gRGFzIGFrdHVlbGxlIEphaHIgaXN0IGR1cmNoZ2V6b2dlbiwgdmVyZ2FuZ2VuZSBKYWhyZSBzaW5kIGZhcmJpZyBnZXN0cmljaGVsdC48L3A+CiAgICAgIDwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9Im1ldHJpYy1ncmlkIGFuYWx5c2lzLW1ldHJpY3MiIGlkPSJhbmFseXNpc01ldHJpY3MiPjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5BVUZURUlMVU5HPC9zcGFuPjxoMj5Xw6RybWVwdW1wZSDCtyBBbHRlbnRlaWwgwrcgU2NobGVlL0tsdXM8L2gyPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImxlZ2VuZCI+PHNwYW4gY2xhc3M9ImhlYXQiPlfDpHJtZXB1bXBlPC9zcGFuPjxzcGFuIGNsYXNzPSJhbm5leCI+QWx0ZW50ZWlsPC9zcGFuPjxzcGFuIGNsYXNzPSJyZXN0Ij5TY2hsZWUvS2x1czwvc3Bhbj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJhbGxvY2F0aW9uQ2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5WRVJHTEVJQ0g8L3NwYW4+PGgyPkFsbGUgSmFocmUgwrcgR2VzYW10dmVyYnJhdWNoPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGlkPSJ5ZWFyQ29tcGFyaXNvbkxlZ2VuZCIgY2xhc3M9InllYXItY29tcGFyaXNvbi1sZWdlbmQiPjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9InRvdGFsQ2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5LT1NURU48L3NwYW4+PGgyPk1vbmF0bGljaGUgU3Ryb21rb3N0ZW48L2gyPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImNvc3RDaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJjb3BQYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+V8OEUk1FUFVNUEU8L3NwYW4+PGgyPkFyYmVpdHN6YWhsPC9oMj48L2Rpdj48L2Rpdj48cCBjbGFzcz0ibXV0ZWQiPldpcmQgbnVyIGF1cyBNb25hdGVuIG1pdCBkb2t1bWVudGllcnRlciBlcnpldWd0ZXIgV8Okcm1lIGJlcmVjaG5ldC48L3A+PGRpdiBjbGFzcz0iY2hhcnQtd3JhcCBsYXJnZSI+PGNhbnZhcyBpZD0iY29wQ2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj48ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5NT05BVEU8L3NwYW4+PGgyPkphaHJlc8O8YmVyc2ljaHQ8L2gyPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9InRhYmxlLXNjcm9sbCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk1vbmF0PC90aD48dGg+R2VzYW10PC90aD48dGg+V1A8L3RoPjx0aD5BbHRlbnRlaWw8L3RoPjx0aD5TY2hsZWUvS2x1czwvdGg+PHRoPktvc3RlbjwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0iYW5hbHlzaXNUYWJsZSI+PC90Ym9keT48L3RhYmxlPjwvZGl2Pjwvc2VjdGlvbj4KICAgIDwvc2VjdGlvbj4KCiAgICA8c2VjdGlvbiBjbGFzcz0idmlldyIgaWQ9ImRhdGFWaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImRhdGFUaXRsZSI+CiAgICAgIDxkaXYgY2xhc3M9InBhZ2UtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+REFURU48L3NwYW4+PGgxIGlkPSJkYXRhVGl0bGUiPkJhY2t1cCAmIEVpbnN0ZWxsdW5nZW48L2gxPjxwPlrDpGhsZXJzdMOkbmRlLCBteVZBSUxMQU5ULUltcG9ydCwgU2ljaGVydW5nIHVuZCBPc3Ryb20uPC9wPjwvZGl2PjwvZGl2PgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5EQVRFTlFVQUxJVMOEVDwvc3Bhbj48aDI+TW9uYXRzd2VydGUgcHLDvGZlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQgY29tcGFjdC1tZXRyaWNzIiBpZD0icXVhbGl0eU1ldHJpY3MiPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9InF1YWxpdHlJc3N1ZXMiIGNsYXNzPSJpc3N1ZS1saXN0Ij48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9ImRldmljZVN5bmNQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+R0VSw4RURS1TWU5DPC9zcGFuPjxoMj5BdWYgYWxsZW4gR2Vyw6R0ZW4gZGVyc2VsYmUgU3RhbmQ8L2gyPjwvZGl2PjxzcGFuIGNsYXNzPSJzeW5jLWJhZGdlIj52ZXJzY2hsw7xzc2VsdDwvc3Bhbj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkVpbm1hbCBlaW5yaWNodGVuLCBkYW5hY2ggbMOkZHQgRWxkZWhvZiBiZWltIMOWZmZuZW4gdW5kIHfDpGhyZW5kIGRlciBOdXR6dW5nIGF1dG9tYXRpc2NoIGRlbiBuZXVlc3RlbiBTdGFuZC4gTW9uYXRzd2VydGUsIFrDpGhsZXJzdMOkbmRlLCBWYWlsbGFudC1EYXRlbiB1bmQgZGllIHJlbGV2YW50ZW4gT3N0cm9tLUVpbnN0ZWxsdW5nZW4gd2VyZGVuIGNsaWVudHNlaXRpZyB2ZXJzY2hsw7xzc2VsdCBzeW5jaHJvbmlzaWVydC48L3A+CiAgICAgICAgPGRpdiBpZD0ic3luY1NldHVwQXJlYSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJjcmVhdGVTeW5jQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5BdWYgZGllc2VtIEdlcsOkdCBlaW5yaWNodGVuPC9idXR0b24+PC9kaXY+CiAgICAgICAgICA8ZGV0YWlscyBjbGFzcz0iZGV0YWlscy1jYXJkIj48c3VtbWFyeT5EaWVzZXMgR2Vyw6R0IG1pdCBlaW5lbSBiZXN0ZWhlbmRlbiBFbGRlaG9mIGtvcHBlbG48L3N1bW1hcnk+PGRpdiBjbGFzcz0ic3luYy1qb2luLWJveCI+PGxhYmVsIGNsYXNzPSJmaWVsZCI+S29wcGx1bmdzc2NobMO8c3NlbDx0ZXh0YXJlYSBpZD0ic3luY0pvaW5CdW5kbGUiIHJvd3M9IjMiIGF1dG9jb21wbGV0ZT0ib2ZmIiBzcGVsbGNoZWNrPSJmYWxzZSIgcGxhY2Vob2xkZXI9IktvcHBsdW5nc3NjaGzDvHNzZWwgdm9tIEhhdXB0Z2Vyw6R0IGVpbmbDvGdlbiI+PC90ZXh0YXJlYT48L2xhYmVsPjxidXR0b24gaWQ9ImpvaW5TeW5jQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkdlcsOkdCBrb3BwZWxuPC9idXR0b24+PC9kaXY+PC9kZXRhaWxzPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9InN5bmNBY3RpdmVBcmVhIiBjbGFzcz0iaGlkZGVuIj4KICAgICAgICAgIDxkaXYgY2xhc3M9InN5bmMtZGV2aWNlLWxpbmUiPjxkaXY+PHNwYW4+RGllc2VzIEdlcsOkdDwvc3Bhbj48c3Ryb25nIGlkPSJzeW5jRGV2aWNlTmFtZSI+4oCTPC9zdHJvbmc+PC9kaXY+PGRpdj48c3Bhbj5TdGF0dXM8L3NwYW4+PHN0cm9uZyBpZD0ic3luY1JvbGUiPuKAkzwvc3Ryb25nPjwvZGl2PjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+PGJ1dHRvbiBpZD0ic3luY05vd0J0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+SmV0enQgc3luY2hyb25pc2llcmVuPC9idXR0b24+PGJ1dHRvbiBpZD0iY3JlYXRlUGFpckJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5XZWl0ZXJlcyBHZXLDpHQga29wcGVsbjwvYnV0dG9uPjwvZGl2PgogICAgICAgICAgPGRpdiBpZD0ic3luY1BhaXJSZXN1bHQiIGNsYXNzPSJzeW5jLXBhaXItcmVzdWx0IGhpZGRlbiI+PGxhYmVsIGNsYXNzPSJmaWVsZCI+S29wcGx1bmdzc2NobMO8c3NlbDx0ZXh0YXJlYSBpZD0ic3luY1BhaXJCdW5kbGUiIHJvd3M9IjMiIHJlYWRvbmx5PjwvdGV4dGFyZWE+PC9sYWJlbD48YnV0dG9uIGlkPSJjb3B5UGFpckJ0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPktvcGllcmVuPC9idXR0b24+PHNtYWxsPkF1ZiBkZW0gbmV1ZW4gR2Vyw6R0IHVudGVyIERhdGVuIOKGkiBHZXLDpHRlLVN5bmMgZWluZsO8Z2VuLiBEZXIgc2VydmVyc2VpdGlnZSBLb3BwbHVuZ3N0ZWlsIGlzdCAxMCBNaW51dGVuIGfDvGx0aWcuPC9zbWFsbD48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0ic3luY1N0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im1ldGVyUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlrDhEhMRVJTVMOETkRFPC9zcGFuPjxoMj5HZXNhbXQgJiBBbHRlbnRlaWw8L2gyPjwvZGl2PjxidXR0b24gaWQ9ImFkZE1ldGVyQnRuIiBjbGFzcz0icHJpbWFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPisgRWludHJhZ2VuPC9idXR0b24+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EdSB0csOkZ3N0IG51ciBkaWUgYmVpZGVuIGFrdHVlbGxlbiBaw6RobGVyc3TDpG5kZSBlaW4uIEVsZGVob2YgYmVyZWNobmV0IGRhcmF1cyBhdXRvbWF0aXNjaCBkZW4gTW9uYXRzdmVyYnJhdWNoLiBBdXNnYW5nc3B1bmt0IGlzdCBkZXIgMDEuMTAuMjAyNiBtaXQgR2VzYW10IDM0LjI1NSBrV2ggdW5kIEFsdGVudGVpbCA5LjA0NSBrV2guPC9wPgogICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIG1ldGVyLWxhdGVzdCIgaWQ9Im1ldGVyTGF0ZXN0Ij48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJtZXRlckhpc3RvcnkiIGNsYXNzPSJtZXRlci1oaXN0b3J5Ij48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93IG1ldGVyLWFjdGlvbnMiPjxidXR0b24gaWQ9InVuZG9MYXRlc3RNZXRlckJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5MZXR6dGVuIFrDpGhsZXJzdGFuZCB6dXLDvGNrbmVobWVuPC9idXR0b24+PC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9InZhaWxsYW50SW1wb3J0UGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlfDhFJNRVBVTVBFPC9zcGFuPjxoMj5teVZBSUxMQU5ULURhdGVuIGltcG9ydGllcmVuPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPlfDpGhsZSBkaWUgZXhwb3J0aWVydGVuIENTVi1EYXRlaWVuIHZvbiBhcm9USEVSTSB1bmQgdW5pVE9XRVIuIERhcmF1cyDDvGJlcm5pbW10IEVsZGVob2YgZGVuIFfDpHJtZXB1bXBlbnZlcmJyYXVjaCB1bmQgZGllIFfDpHJtZW1lbmdlbi4gR2VzYW10IHVuZCBBbHRlbnRlaWwga29tbWVuIGF1c3NjaGxpZcOfbGljaCBhdXMgZGVpbmVuIFrDpGhsZXJzdMOkbmRlbi48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpbGUtYnV0dG9uIHByaW1hcnkiPkNTVi1EYXRlaWVuIGF1c3fDpGhsZW48aW5wdXQgaWQ9InZhaWxsYW50Q3N2RmlsZXNJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSIuY3N2LHRleHQvY3N2LHRleHQvcGxhaW4iIG11bHRpcGxlIGhpZGRlbj48L2xhYmVsPgogICAgICAgIDwvZGl2PgogICAgICAgIDxwIGlkPSJ2YWlsbGFudEltcG9ydFN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij5Ob2NoIGtlaW5lIERhdGVpZW4gYXVzZ2V3w6RobHQuPC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlNJQ0hFUlVORzwvc3Bhbj48aDI+UHJpdmF0ZXMgQmFja3VwPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0ibXV0ZWQiPkRhcyBwcml2YXRlIEJhY2t1cCBlbnRow6RsdCBkZWluZSBWZXJicmF1Y2hzZGF0ZW4gdW5kIOKAkyBzb2Zlcm4gZ2VzcGVpY2hlcnQg4oCTIGF1Y2ggZGVuIE9zdHJvbS1BcHAtU2NobMO8c3NlbC4gTmljaHQgw7ZmZmVudGxpY2ggaG9jaGxhZGVuLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij4KICAgICAgICAgIDxidXR0b24gaWQ9ImV4cG9ydEJhY2t1cEJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+QmFja3VwIGV4cG9ydGllcmVuPC9idXR0b24+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpbGUtYnV0dG9uIHNlY29uZGFyeSI+QmFja3VwIGltcG9ydGllcmVuPGlucHV0IGlkPSJpbXBvcnRCYWNrdXBJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSJhcHBsaWNhdGlvbi9qc29uLC5qc29uIiBoaWRkZW4+PC9sYWJlbD4KICAgICAgICAgIDxidXR0b24gaWQ9ImV4cG9ydENzdkJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5DU1YgZXhwb3J0aWVyZW48L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0iYmFja3VwU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0ib3N0cm9tU2V0dGluZ3NQYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+T1NUUk9NPC9zcGFuPjxoMj5QcmVpc8O8YmVyc2ljaHQgdmVyYmluZGVuPC9oMj48L2Rpdj48L2Rpdj4KICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5FbGRlaG9mLUFwcC1TY2hsw7xzc2VsPGlucHV0IGlkPSJvc3Ryb21BcHBLZXlJbnB1dCIgdHlwZT0icGFzc3dvcmQiIGF1dG9jb21wbGV0ZT0ib2ZmIiBwbGFjZWhvbGRlcj0iQXBwLVNjaGzDvHNzZWwiPjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5aZWl0ZmVuc3RlcjxzZWxlY3QgaWQ9InByZWZlcnJlZFdpbmRvd0hvdXJzSW5wdXQiPjxvcHRpb24gdmFsdWU9IjEiPjEgU3R1bmRlPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iMiI+MiBTdHVuZGVuPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iMyI+MyBTdHVuZGVuPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iNCI+NCBTdHVuZGVuPC9vcHRpb24+PC9zZWxlY3Q+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0ic3dpdGNoLXJvdyI+PGlucHV0IGlkPSJvc3Ryb21BdXRvUmVmcmVzaElucHV0IiB0eXBlPSJjaGVja2JveCI+PHNwYW4+QXV0b21hdGlzY2ggYWxsZSAxMCBNaW51dGVuIGFrdHVhbGlzaWVyZW48L3NwYW4+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb24tcm93Ij48YnV0dG9uIGlkPSJzYXZlT3N0cm9tQnRuIiBjbGFzcz0icHJpbWFyeSIgdHlwZT0iYnV0dG9uIj5TcGVpY2hlcm4gJiBwcsO8ZmVuPC9idXR0b24+PGJ1dHRvbiBpZD0iZGlzY29ubmVjdE9zdHJvbUJ0biIgY2xhc3M9InNlY29uZGFyeSIgdHlwZT0iYnV0dG9uIj5WZXJiaW5kdW5nIGVudGZlcm5lbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGlkPSJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiBjbGFzcz0ic3RhdHVzLXRleHQiPjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJvc3Ryb20taGlzdG9yeS1ib3giPjxkaXY+PHN0cm9uZz5IaXN0b3Jpc2NoZSBQcmVpc2UgJiBLb3N0ZW48L3N0cm9uZz48c21hbGw+RsO8ciB2ZXJmw7xnYmFyZSBNb25hdGUga29tYmluaWVydCBFbGRlaG9mIGRpZSBzdMO8bmRsaWNoZW4gT3N0cm9tLVByZWlzZSBtaXQgZGVuIHN0w7xuZGxpY2hlbiBWZXJicmF1Y2hzd2VydGVuLiBTbyB3ZXJkZW4gZ2V3aWNodGV0ZXIgQXJiZWl0c3ByZWlzIHVuZCB0YXRzw6RjaGxpY2hlIE1vbmF0c2tvc3RlbiBtw7ZnbGljaHN0IGdlbmF1IGJlcmVjaG5ldC48L3NtYWxsPjwvZGl2PjxidXR0b24gaWQ9InN5bmNPc3Ryb21IaXN0b3J5QnRuIiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iPkhpc3RvcmllIGFrdHVhbGlzaWVyZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBpZD0ib3N0cm9tSGlzdG9yeVN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5GYWxsYmFjay1XZXJ0ZTwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BcmJlaXRzcHJlaXMg4oKsL2tXaDxpbnB1dCBpZD0iZmFsbGJhY2tQcmljZUlucHV0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5Nb25hdGxpY2hlIEZpeGtvc3RlbiDigqw8aW5wdXQgaWQ9ImRlZmF1bHRCYXNlRmVlSW5wdXQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAxIj48L2xhYmVsPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9InNhdmVDb3N0U2V0dGluZ3NCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuPC9idXR0b24+CiAgICAgIDwvc2VjdGlvbj4KICAgIDwvc2VjdGlvbj4KICA8L21haW4+CgogIDxuYXYgY2xhc3M9ImJvdHRvbS1uYXYiIGFyaWEtbGFiZWw9IkhhdXB0bmF2aWdhdGlvbiI+CiAgICA8YnV0dG9uIGNsYXNzPSJhY3RpdmUiIGRhdGEtbmF2PSJkYXNoYm9hcmRWaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKMgjwvc3Bhbj7DnGJlcnNpY2h0PC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtbmF2PSJjb25zdW1wdGlvblZpZXciIHR5cGU9ImJ1dHRvbiI+PHNwYW4+4pakPC9zcGFuPlZlcmJyYXVjaDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iYW5hbHlzaXNWaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKWpTwvc3Bhbj5BdXN3ZXJ0dW5nPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtbmF2PSJkYXRhVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7impk8L3NwYW4+RGF0ZW48L2J1dHRvbj4KICA8L25hdj4KPC9kaXY+Cgo8ZGl2IGlkPSJyZWNvcmRNb2RhbCIgY2xhc3M9Im1vZGFsIGhpZGRlbiIgcm9sZT0iZGlhbG9nIiBhcmlhLW1vZGFsPSJ0cnVlIiBhcmlhLWxhYmVsbGVkYnk9InJlY29yZE1vZGFsVGl0bGUiPgogIDxkaXYgY2xhc3M9Im1vZGFsLWJhY2tkcm9wIiBkYXRhLWNsb3NlLXJlY29yZC1tb2RhbD48L2Rpdj4KICA8Zm9ybSBjbGFzcz0ibW9kYWwtY2FyZCIgaWQ9InJlY29yZEZvcm0iPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+TU9OQVQgQkVBUkJFSVRFTjwvc3Bhbj48aDIgaWQ9InJlY29yZE1vZGFsVGl0bGUiPk1vbmF0IGJlYXJiZWl0ZW48L2gyPjwvZGl2PjxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iaWNvbi1idXR0b24iIGRhdGEtY2xvc2UtcmVjb3JkLW1vZGFsIGFyaWEtbGFiZWw9IlNjaGxpZcOfZW4iPsOXPC9idXR0b24+PC9kaXY+CiAgICA8aW5wdXQgaWQ9ImVkaXRpbmdNb250aE9yaWdpbmFsIiB0eXBlPSJoaWRkZW4iPgogICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+TW9uYXQ8aW5wdXQgaWQ9InJlY29yZE1vbnRoIiB0eXBlPSJtb250aCIgcmVhZG9ubHk+PC9sYWJlbD4KICAgICAgPHNwYW4+PC9zcGFuPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5HZXNhbXR2ZXJicmF1Y2gga1doPGlucHV0IGlkPSJyZWNvcmRUb3RhbCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkFsdGVudGVpbCBrV2g8aW5wdXQgaWQ9InJlY29yZEFubmV4IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+V8Okcm1lcHVtcGUga1doPGlucHV0IGlkPSJyZWNvcmRIZWF0UHVtcCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPsOYIFN0cm9tcHJlaXMgY3Qva1doPGlucHV0IGlkPSJyZWNvcmRQcmljZUN0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+Rml4a29zdGVuIOKCrDxpbnB1dCBpZD0icmVjb3JkQmFzZUZlZSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDEiIGlucHV0bW9kZT0iZGVjaW1hbCI+PC9sYWJlbD4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0iZGVyaXZlZFByZXZpZXciIGNsYXNzPSJkZXJpdmVkLXByZXZpZXciPlNjaGxlZS9LbHVzOiDigJM8L2Rpdj4KICAgIDxwIGlkPSJyZWNvcmRTb3VyY2VIaW50IiBjbGFzcz0ibXV0ZWQgY29tcGFjdC1ub3RlIj48L3A+CiAgICA8ZGV0YWlscyBjbGFzcz0iZGV0YWlscy1jYXJkIj48c3VtbWFyeT5Xw6RybWVwdW1wZW4tRGV0YWlscyAob3B0aW9uYWwpPC9zdW1tYXJ5PjxkaXYgY2xhc3M9ImZvcm0tZ3JpZCBkZXRhaWwtZ3JpZCI+PGxhYmVsIGNsYXNzPSJmaWVsZCI+RXJ6ZXVndGUgV8Okcm1lIGtXaDxpbnB1dCBpZD0icmVjb3JkSGVhdEdlbmVyYXRlZCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPkhlaXpzdHJvbSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIj48L2xhYmVsPjxsYWJlbCBjbGFzcz0iZmllbGQiPldhcm13YXNzZXJzdHJvbSBrV2g8aW5wdXQgaWQ9InJlY29yZERod0VsZWN0cmljaXR5IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PGxhYmVsIGNsYXNzPSJmaWVsZCI+SGVpenfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZEhlYXRpbmdIZWF0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+PGxhYmVsIGNsYXNzPSJmaWVsZCI+V2FybXdhc3NlcnfDpHJtZSBrV2g8aW5wdXQgaWQ9InJlY29yZERod0hlYXQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSI+PC9sYWJlbD48L2Rpdj48L2RldGFpbHM+CiAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5Ob3Rpejx0ZXh0YXJlYSBpZD0icmVjb3JkTm90ZSIgcm93cz0iMyIgbWF4bGVuZ3RoPSI4MDAiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgIDxwIGlkPSJyZWNvcmRWYWxpZGF0aW9uIiBjbGFzcz0idmFsaWRhdGlvbi10ZXh0Ij48L3A+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj48c3BhbiBjbGFzcz0ic3BhY2VyIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iIGRhdGEtY2xvc2UtcmVjb3JkLW1vZGFsPkFiYnJlY2hlbjwvYnV0dG9uPjxidXR0b24gY2xhc3M9InByaW1hcnkiIHR5cGU9InN1Ym1pdCI+w4RuZGVydW5nZW4gc3BlaWNoZXJuPC9idXR0b24+PC9kaXY+CiAgPC9mb3JtPgo8L2Rpdj4KCjxkaXYgaWQ9Im1ldGVyTW9kYWwiIGNsYXNzPSJtb2RhbCBoaWRkZW4iIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbGxlZGJ5PSJtZXRlck1vZGFsVGl0bGUiPgogIDxkaXYgY2xhc3M9Im1vZGFsLWJhY2tkcm9wIiBkYXRhLWNsb3NlLW1ldGVyLW1vZGFsPjwvZGl2PgogIDxmb3JtIGNsYXNzPSJtb2RhbC1jYXJkIiBpZD0ibWV0ZXJGb3JtIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlrDhEhMRVJTVMOETkRFPC9zcGFuPjxoMiBpZD0ibWV0ZXJNb2RhbFRpdGxlIj5OZXVlIEFibGVzdW5nPC9oMj48L2Rpdj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9Imljb24tYnV0dG9uIiBkYXRhLWNsb3NlLW1ldGVyLW1vZGFsIGFyaWEtbGFiZWw9IlNjaGxpZcOfZW4iPsOXPC9idXR0b24+PC9kaXY+CiAgICA8cCBpZD0ibWV0ZXJQcmV2aW91cyIgY2xhc3M9Im1ldGVyLXByZXZpb3VzIj48L3A+CiAgICA8cCBpZD0ibWV0ZXJUYXJnZXRNb250aCIgY2xhc3M9Im11dGVkIj48L3A+CiAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BYmxlc2VkYXR1bTxpbnB1dCBpZD0ibWV0ZXJEYXRlIiB0eXBlPSJkYXRlIiByZXF1aXJlZD48L2xhYmVsPgogICAgICA8c3Bhbj48L3NwYW4+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkdlc2FtdC1aw6RobGVyc3RhbmQga1doPGlucHV0IGlkPSJtZXRlclRvdGFsIiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2g8aW5wdXQgaWQ9Im1ldGVyQW5uZXgiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAwMSIgaW5wdXRtb2RlPSJkZWNpbWFsIiByZXF1aXJlZD48L2xhYmVsPgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJtZXRlclByZXZpZXciIGNsYXNzPSJkZXJpdmVkLXByZXZpZXciPk1vbmF0c3ZlcmJyw6R1Y2hlIHdlcmRlbiBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9kaXY+CiAgICA8cCBjbGFzcz0ibXV0ZWQgY29tcGFjdC1ub3RlIj5EaWUgV8Okcm1lcHVtcGUgd2lyZCBuaWNodCBoaWVyIGVpbmdldHJhZ2VuLiBTaWUga29tbXQgYXVzc2NobGllw59saWNoIGF1cyBkZW0gbXlWQUlMTEFOVC1DU1YtSW1wb3J0LjwvcD4KICAgIDxwIGlkPSJtZXRlclZhbGlkYXRpb24iIGNsYXNzPSJ2YWxpZGF0aW9uLXRleHQiPjwvcD4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWFjdGlvbnMiPjxzcGFuIGNsYXNzPSJzcGFjZXIiPjwvc3Bhbj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbD5BYmJyZWNoZW48L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJzdWJtaXQiPlrDpGhsZXJzdMOkbmRlIHNwZWljaGVybjwvYnV0dG9uPjwvZGl2PgogIDwvZm9ybT4KPC9kaXY+Cgo8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9InRvYXN0IGhpZGRlbiIgcm9sZT0ic3RhdHVzIiBhcmlhLWxpdmU9InBvbGl0ZSI+PC9kaXY+CjxzY3JpcHQgc3JjPSJhcHAuanM/dj02LjIuMCI+PC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=","type":"text/html; charset=utf-8","cache":"no-cache"},"/styles.css":{"body":"OnJvb3R7CiAgY29sb3Itc2NoZW1lOmRhcms7CiAgLS1iZzojMDYxMDFjOwogIC0tcGFuZWw6IzBjMWEyYTsKICAtLXBhbmVsMjojMTAyMjM1OwogIC0tbGluZTpyZ2JhKDE3MSwxOTgsMjIwLC4xNCk7CiAgLS10ZXh0OiNmNGY4ZmI7CiAgLS1tdXRlZDojOTRhOGJhOwogIC0tZ3JlZW46IzcyZGM1NzsKICAtLW9yYW5nZTojZmY5ZjQzOwogIC0tYmx1ZTojNGQ5Y2ZmOwogIC0teWVsbG93OiNmMmQxNWY7CiAgLS1yZWQ6I2ZmNmI2YjsKICAtLXNoYWRvdzowIDE4cHggNTVweCByZ2JhKDAsMCwwLC4yNCk7CiAgLS1yYWRpdXM6MjBweDsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbHtiYWNrZ3JvdW5kOnZhcigtLWJnKTttaW4taGVpZ2h0OjEwMCU7Zm9udC1mYW1pbHk6SW50ZXIsLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixzYW5zLXNlcmlmOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQpib2R5e21hcmdpbjowO2JhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCB0b3AgcmlnaHQscmdiYSg2MCwxMjAsMTcwLC4xMCksdHJhbnNwYXJlbnQgMzUlKSx2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7bWluLWhlaWdodDoxMDB2aH0KYnV0dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXR9CmJ1dHRvbntjdXJzb3I6cG9pbnRlcn0KYnV0dG9uOmRpc2FibGVke29wYWNpdHk6LjQ4O2N1cnNvcjpub3QtYWxsb3dlZH0KLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQouYXBwLXNoZWxse21heC13aWR0aDoxMTgwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjAgMjJweCAxMTJweH0KLnRvcGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6Y2FsYygxNnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKSAwIDE4cHg7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MzA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQodG8gYm90dG9tLHJnYmEoNiwxNiwyOCwuOTgpLHJnYmEoNiwxNiwyOCwuODYpLHJnYmEoNiwxNiwyOCwwKSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCl9Ci5icmFuZHtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0Ojg1MDtsZXR0ZXItc3BhY2luZzotLjAzZW19LmJyYW5kLW1hcmt7ZGlzcGxheTppbmxpbmUtZ3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6MzZweDtoZWlnaHQ6MzZweDtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxZTYzMzMsIzJmOGU0OSk7Ym94LXNoYWRvdzowIDZweCAyNHB4IHJnYmEoNTMsMTkwLDkxLC4xOCl9Ci5zdWJ0aXRsZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWxlZnQ6NDZweDttYXJnaW4tdG9wOi00cHh9LmJ1aWxkLXBpbGx7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4xMik7Y29sb3I6I2I5ZjVhYTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTE0LDIyMCw4NywuMjIpO3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLXJhZGl1czo5OTlweH0KbWFpbntkaXNwbGF5OmJsb2NrfS52aWV3e2Rpc3BsYXk6bm9uZTthbmltYXRpb246ZmFkZSAuMThzIGVhc2V9LnZpZXcuYWN0aXZle2Rpc3BsYXk6YmxvY2t9QGtleWZyYW1lcyBmYWRle2Zyb217b3BhY2l0eTouNTt0cmFuc2Zvcm06dHJhbnNsYXRlWSg0cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5wYWdlLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDoyMnB4O21hcmdpbjoxOHB4IDAgMjRweH0ucGFnZS1oZWFkIGgxe2ZvbnQtc2l6ZTpjbGFtcCgyOHB4LDV2dyw0NHB4KTttYXJnaW46M3B4IDAgN3B4O2xpbmUtaGVpZ2h0OjEuMDU7bGV0dGVyLXNwYWNpbmc6LS4wNGVtfS5wYWdlLWhlYWQgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7bWF4LXdpZHRoOjY4MHB4O2xpbmUtaGVpZ2h0OjEuNX0uZXllYnJvd3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xNmVtO2ZvbnQtd2VpZ2h0Ojg1MDtjb2xvcjojN2Y5ZGI0O21hcmdpbi1ib3R0b206NXB4fQoucGFuZWx7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHJnYmEoMTUsMzEsNDgsLjk2KSxyZ2JhKDEwLDI0LDM5LC45OCkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjE4cHg7Ym94LXNoYWRvdzp2YXIoLS1zaGFkb3cpfQoucGFuZWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE4cHh9LnBhbmVsLWhlYWQgaDJ7bWFyZ2luOjJweCAwIDJweDtmb250LXNpemU6MjFweDtsZXR0ZXItc3BhY2luZzotLjAyNWVtfS5wYW5lbC1oZWFkIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0KLnByaW1hcnksLnNlY29uZGFyeSwuZGFuZ2VyLC5maWxlLWJ1dHRvbnthcHBlYXJhbmNlOm5vbmU7Ym9yZGVyLXJhZGl1czoxM3B4O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnQ7cGFkZGluZzoxMXB4IDE1cHg7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLXRleHQpO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjhweDt0ZXh0LWRlY29yYXRpb246bm9uZTttaW4taGVpZ2h0OjQ0cHh9LnByaW1hcnl7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyZjhlNDksIzFmNmMzOCk7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMjgpO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDQ0LDE2MSw3NywuMTgpfS5wcmltYXJ5OmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMDYpfS5zZWNvbmRhcnksLmZpbGUtYnV0dG9ue2JhY2tncm91bmQ6IzEyMjYzYTtib3JkZXItY29sb3I6cmdiYSgxNzAsMjAwLDIyNCwuMTQpO2NvbG9yOiNkY2U5ZjN9LnNlY29uZGFyeTpob3ZlciwuZmlsZS1idXR0b246aG92ZXJ7YmFja2dyb3VuZDojMTczMDQ5fS5kYW5nZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xMCk7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjI1KTtjb2xvcjojZmZhYWE5fS5jb21wYWN0e21pbi1oZWlnaHQ6MzZweDtwYWRkaW5nOjhweCAxMXB4O2ZvbnQtc2l6ZToxM3B4fS5pY29uLWJ1dHRvbntib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjOWQ3ZTI7Zm9udC1zaXplOjMwcHg7bGluZS1oZWlnaHQ6MTtwYWRkaW5nOjAgNnB4fQoubWV0cmljLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNSxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxNnB4O21pbi13aWR0aDowfS5tZXRyaWMtZ3JpZCBhcnRpY2xlIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbTo3cHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZTpjbGFtcCgxOXB4LDN2dywyNnB4KTtsaW5lLWhlaWdodDoxLjE7ZGlzcGxheTpibG9jazt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Lm1ldHJpYy1ncmlkIGFydGljbGUgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojN2Y5NmFhO2ZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NnB4O2xpbmUtaGVpZ2h0OjEuMzV9LmNvbXBhcmlzb24tbGluZXttYXJnaW46MTVweCAwIDA7Y29sb3I6I2I4YzhkNTtmb250LXNpemU6MTNweH0uY29tcGFyaXNvbi1saW5lLnBvc2l0aXZle2NvbG9yOiNmZmIxYTh9LmNvbXBhcmlzb24tbGluZS5uZWdhdGl2ZXtjb2xvcjojYTVlNjlhfS5jb21wYXJpc29uLWxpbmUubmV1dHJhbHtjb2xvcjojYjhjOGQ1fQoub3N0cm9tLXBhbmVse292ZXJmbG93OmhpZGRlbn0ub3N0cm9tLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ucHJpY2UtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMGIxYjJiO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MThweH0ucHJpY2UtY2FyZDpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowIGF1dG8gMCAwO3dpZHRoOjRweDtiYWNrZ3JvdW5kOiM2ZDg1OTl9LnByaWNlLWNhcmQuYmVzdDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ncmVlbil9LnByaWNlLWNhcmQud29yc3Q6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tcmVkKX0ucHJpY2UtY2FyZC5jdXJyZW50OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLWJsdWUpfS5wcmljZS1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9LnByaWNlLWNhcmQgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjI3cHg7bWFyZ2luOjhweCAwIDRweH0ucHJpY2UtY2FyZCBzbWFsbHtjb2xvcjojOWNiMGMwfS5lbXB0eS1zdGF0ZXtib3JkZXI6MXB4IGRhc2hlZCByZ2JhKDE3MCwyMDAsMjI0LC4yKTtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjAyKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6OXB4IDE0cHg7YWxpZ24taXRlbXM6Y2VudGVyfS5lbXB0eS1zdGF0ZSBzdHJvbmd7d2lkdGg6MTAwJX0uZW1wdHktc3RhdGUgc3Bhbntjb2xvcjp2YXIoLS1tdXRlZCk7ZmxleDoxO21pbi13aWR0aDoyMDBweH0ucHJpY2UtY2hhcnQtd3JhcHttYXJnaW4tdG9wOjE2cHh9Ci5jaGFydC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDoyNjBweDt3aWR0aDoxMDAlO21pbi13aWR0aDowfS5jaGFydC13cmFwLmxhcmdle2hlaWdodDozNDBweH0uY2hhcnQtd3JhcCBjYW52YXN7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtkaXNwbGF5OmJsb2NrfS5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjI2MHB4fS5sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNXB4O21hcmdpbjotNnB4IDAgMTRweDtjb2xvcjojYjhjNmQyO2ZvbnQtc2l6ZToxMnB4fS5sZWdlbmQgc3BhbjpiZWZvcmV7Y29udGVudDoiIjtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjNweDttYXJnaW4tcmlnaHQ6NnB4fS5sZWdlbmQgLmhlYXQ6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tb3JhbmdlKX0ubGVnZW5kIC5hbm5leDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ibHVlKX0ubGVnZW5kIC5yZXN0OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyl9Ci5yZWNvcmQtdG9vbGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MTRweH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0LC5maWx0ZXItcGFuZWwgc2VsZWN0e2JhY2tncm91bmQ6IzBiMWEyYTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEwcHggMTJweH0ucmVjb3JkLWxpc3R7ZGlzcGxheTpncmlkO2dhcDoxMHB4fS5yZWNvcmQtcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6bWlubWF4KDE1MHB4LDEuM2ZyKSByZXBlYXQoNCxtaW5tYXgoOTBweCwuODVmcikpIGF1dG87Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGExOTI4O2JvcmRlci1yYWRpdXM6MTVweDtwYWRkaW5nOjEzcHggMTRweH0ucmVjb3JkLXJvdzpob3ZlcntiYWNrZ3JvdW5kOiMwZTIwMzJ9LnJlY29yZC1tb250aCBzdHJvbmd7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTVweH0ucmVjb3JkLW1vbnRoIHNtYWxse2Rpc3BsYXk6YmxvY2s7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6M3B4fS5yZWNvcmQtdmFsdWUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOiM3Zjk2YWE7Zm9udC1zaXplOjEwcHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wOGVtfS5yZWNvcmQtdmFsdWUgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kfS5yZWNvcmQtcm93LmludmFsaWR7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjMpfQouZmlsdGVyLXBhbmVse2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczplbmR9LmZpbHRlci1wYW5lbCBsYWJlbHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWluLXdpZHRoOjE1MHB4fS5hbmFseXNpcy1tZXRyaWNze21hcmdpbi1ib3R0b206MThweH0uYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDUsbWlubWF4KDAsMWZyKSl9Ci50YWJsZS1zY3JvbGx7b3ZlcmZsb3c6YXV0bztib3JkZXItcmFkaXVzOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzIwcHh9dGgsdGR7cGFkZGluZzoxMnB4IDEzcHg7dGV4dC1hbGlnbjpyaWdodDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmb250LXNpemU6MTNweH10aDpmaXJzdC1jaGlsZCx0ZDpmaXJzdC1jaGlsZHt0ZXh0LWFsaWduOmxlZnR9dGh7Zm9udC1zaXplOjExcHg7Y29sb3I6Izg4YTBiNTtsZXR0ZXItc3BhY2luZzouMDVlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7YmFja2dyb3VuZDojMGExOTI4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MH10Ym9keSB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLmNvbXBhY3QtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSl9Lmlzc3VlLWxpc3R7ZGlzcGxheTpncmlkO2dhcDo4cHg7bWFyZ2luLXRvcDoxNHB4fS5pc3N1ZXtkaXNwbGF5OmZsZXg7Z2FwOjEycHg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTJweCAxM3B4O2JvcmRlci1yYWRpdXM6MTNweDtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0uaXNzdWUud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yMil9Lmlzc3VlLmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4yNSl9Lmlzc3VlIGRpdnttaW4td2lkdGg6MH0uaXNzdWUgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEzcHh9Lmlzc3VlIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6M3B4fS5tdXRlZHtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS41NX0uYWN0aW9uLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5zdGF0dXMtdGV4dHttaW4taGVpZ2h0OjEuNGVtO21hcmdpbjoxMnB4IDAgMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHh9LnN0YXR1cy10ZXh0Lm9re2NvbG9yOiNhNWU2OWF9LnN0YXR1cy10ZXh0LmVycm9ye2NvbG9yOiNmZmFhYTl9LnNldHRpbmdzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTNweDttYXJnaW46MTRweCAwfS5maWVsZHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjojOWRiMGMwO2ZvbnQtc2l6ZToxMnB4fS5maWVsZCBpbnB1dCwuZmllbGQgc2VsZWN0LC5maWVsZCB0ZXh0YXJlYXt3aWR0aDoxMDAlO2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTcxLDE5OCwyMjAsLjE2KTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEycHg7b3V0bGluZTpub25lfS5maWVsZCBpbnB1dDpmb2N1cywuZmllbGQgc2VsZWN0OmZvY3VzLC5maWVsZCB0ZXh0YXJlYTpmb2N1c3tib3JkZXItY29sb3I6cmdiYSg3NywxNTYsMjU1LC41NSk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NywxNTYsMjU1LC4wOCl9LnN3aXRjaC1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjExcHggMTNweDtjb2xvcjojYzdkNWRmfS5zd2l0Y2gtcm93IGlucHV0e3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7YWNjZW50LWNvbG9yOiMzYzlhNTN9Ci5iYW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTZweDttYXJnaW46MTJweCAwIDE4cHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxNXB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGQyMDMyfS5iYW5uZXIud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yOCk7YmFja2dyb3VuZDpyZ2JhKDI0MiwyMDksOTUsLjA2KX0uYmFubmVyIHN0cm9uZywuYmFubmVyIHNwYW57ZGlzcGxheTpibG9ja30uYmFubmVyIHNwYW57Y29sb3I6I2IzYzBjYTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjNweH0KLmJvdHRvbS1uYXZ7cG9zaXRpb246Zml4ZWQ7ei1pbmRleDo0MDtsZWZ0OjUwJTtib3R0b206bWF4KDEycHgsZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7d2lkdGg6bWluKDYyMHB4LGNhbGMoMTAwJSAtIDI0cHgpKTtiYWNrZ3JvdW5kOnJnYmEoOCwyMCwzMywuOTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTYpO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjdweDtib3gtc2hhZG93OjAgMTZweCA1MHB4IHJnYmEoMCwwLDAsLjQyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxNnB4KX0uYm90dG9tLW5hdiBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojODU5OWFhO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjlweCA4cHg7ZGlzcGxheTpncmlkO2dhcDozcHg7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MDttaW4td2lkdGg6MH0uYm90dG9tLW5hdiBidXR0b24gc3Bhbntmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfS5ib3R0b20tbmF2IGJ1dHRvbi5hY3RpdmV7YmFja2dyb3VuZDojMTUzMTQ3O2NvbG9yOiNmNGY4ZmJ9Ci5tb2RhbHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7cGFkZGluZzoxOHB4fS5tb2RhbC1iYWNrZHJvcHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNzIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDVweCl9Lm1vZGFsLWNhcmR7cG9zaXRpb246cmVsYXRpdmU7d2lkdGg6bWluKDc2MHB4LDEwMCUpO21heC1oZWlnaHQ6Y2FsYygxMDB2aCAtIDM2cHgpO292ZXJmbG93OmF1dG87YmFja2dyb3VuZDojMGIxYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTgpO2JvcmRlci1yYWRpdXM6MjJweDtwYWRkaW5nOjIycHg7Ym94LXNoYWRvdzowIDMwcHggOTBweCByZ2JhKDAsMCwwLC41NSl9Lm1vZGFsLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxOHB4fS5tb2RhbC1oZWFkIGgye21hcmdpbjoycHggMCAwfS5mb3JtLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0uZGVyaXZlZC1wcmV2aWV3e21hcmdpbjoxNHB4IDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTJweCAxNHB4O2ZvbnQtd2VpZ2h0OjgwMH0uZGVyaXZlZC1wcmV2aWV3LmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zNSk7Y29sb3I6I2ZmYWFhOX0uZGV0YWlscy1jYXJke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbjoxMnB4IDA7YmFja2dyb3VuZDojMDgxNzI1fS5kZXRhaWxzLWNhcmQgc3VtbWFyeXtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjEycHggMTRweDtjb2xvcjojYzdkNWRmO2ZvbnQtd2VpZ2h0OjcwMH0uZGV0YWlscy1jYXJkIC5kZXRhaWwtZ3JpZHtwYWRkaW5nOjAgMTRweCAxNHB4fS52YWxpZGF0aW9uLXRleHR7bWluLWhlaWdodDoxLjJlbTtjb2xvcjojZmZhYWE5O2ZvbnQtc2l6ZToxMnB4fS5tb2RhbC1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OXB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjE2cHh9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntmbGV4OjF9Ci50b2FzdHtwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjE1MDtsZWZ0OjUwJTtib3R0b206MTAwcHg7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7YmFja2dyb3VuZDojMTkzNjRkO2NvbG9yOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIwMCwyMjAsMjM2LC4xNik7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTFweCAxNXB4O2JveC1zaGFkb3c6MCAxNnB4IDUwcHggcmdiYSgwLDAsMCwuNCk7bWF4LXdpZHRoOm1pbig5MHZ3LDU2MHB4KTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpey5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9LnJlY29yZC1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxNTBweCwxLjJmcikgcmVwZWF0KDIsbWlubWF4KDk1cHgsLjhmcikpIGF1dG99LnJlY29yZC1yb3cgLnJlY29yZC12YWx1ZTpudGgtb2YtdHlwZSg0KSwucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVlOm50aC1vZi10eXBlKDUpe2Rpc3BsYXk6bm9uZX0ub3N0cm9tLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnByaWNlLWNhcmQuY3VycmVudHtncmlkLWNvbHVtbjoxLy0xfS5jb21wYWN0LW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfX0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmFwcC1zaGVsbHtwYWRkaW5nOjAgMTJweCAxMDRweH0udG9wYmFye3BhZGRpbmctbGVmdDo0cHg7cGFkZGluZy1yaWdodDo0cHh9LmJyYW5ke2ZvbnQtc2l6ZToyMXB4fS5icmFuZC1tYXJre3dpZHRoOjMzcHg7aGVpZ2h0OjMzcHh9LnN1YnRpdGxle21hcmdpbi1sZWZ0OjQzcHh9LnBhZ2UtaGVhZHthbGlnbi1pdGVtczpzdHJldGNoO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjttYXJnaW4tdG9wOjlweH0ucGFnZS1oZWFkIC5wcmltYXJ5e3dpZHRoOjEwMCV9LnBhZ2UtaGVhZCBoMXtmb250LXNpemU6MzFweH0ucGFuZWx7cGFkZGluZzoxNnB4O2JvcmRlci1yYWRpdXM6MTdweDttYXJnaW4tYm90dG9tOjEzcHh9LnBhbmVsLWhlYWR7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5wYW5lbC1oZWFkIGgye2ZvbnQtc2l6ZToxOHB4fS5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsbWlubWF4KDAsMWZyKSk7Z2FwOjlweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtwYWRkaW5nOjEzcHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZToyMHB4fS5vc3Ryb20tZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5wcmljZS1jYXJkLmN1cnJlbnR7Z3JpZC1jb2x1bW46YXV0b30ucHJpY2UtY2FyZHtwYWRkaW5nOjE1cHh9LnByaWNlLWNhcmQgc3Ryb25ne2ZvbnQtc2l6ZToyNHB4fS5jaGFydC13cmFwLC5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjIyNXB4fS5jaGFydC13cmFwLmxhcmdle2hlaWdodDoyNzBweH0ucmVjb3JkLXRvb2xiYXJ7YWxpZ24taXRlbXM6c3RyZXRjaH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0e21heC13aWR0aDoxNDVweH0ucmVjb3JkLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjlweH0ucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVle2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9LnJlY29yZC1yb3cgLmVkaXQtcmVjb3Jke2dyaWQtY29sdW1uOjI7Z3JpZC1yb3c6MX0ucmVjb3JkLW1vbnRoIHNtYWxse21heC13aWR0aDoyMzBweH0uZmlsdGVyLXBhbmVse2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtwYWRkaW5nOjE0cHh9LmZpbHRlci1wYW5lbCBsYWJlbHttaW4td2lkdGg6MH0uc2V0dGluZ3MtZ3JpZCwuZm9ybS1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmRldGFpbHMtY2FyZCAuZGV0YWlsLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uYWN0aW9uLXJvdz4qe2ZsZXg6MSAxIDE1MHB4fS5ib3R0b20tbmF2e3dpZHRoOmNhbGMoMTAwJSAtIDE2cHgpO2JvdHRvbTptYXgoOHB4LGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7Ym9yZGVyLXJhZGl1czoxN3B4fS5ib3R0b20tbmF2IGJ1dHRvbntmb250LXNpemU6MTBweDtwYWRkaW5nOjhweCAzcHh9LmJvdHRvbS1uYXYgYnV0dG9uIHNwYW57Zm9udC1zaXplOjE4cHh9Lm1vZGFse3BhZGRpbmc6OHB4fS5tb2RhbC1jYXJke3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE4cHg7bWF4LWhlaWdodDpjYWxjKDEwMHZoIC0gMTZweCl9Lm1vZGFsLWFjdGlvbnN7ZmxleC13cmFwOndyYXB9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntkaXNwbGF5Om5vbmV9Lm1vZGFsLWFjdGlvbnMgYnV0dG9ue2ZsZXg6MSAxIDEyMHB4fS5iYW5uZXJ7YWxpZ24taXRlbXM6c3RyZXRjaDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59LmJhbm5lciBidXR0b257YWxpZ24tc2VsZjpmbGV4LXN0YXJ0fX0KQG1lZGlhKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsqe3Njcm9sbC1iZWhhdmlvcjphdXRvIWltcG9ydGFudDthbmltYXRpb246bm9uZSFpbXBvcnRhbnQ7dHJhbnNpdGlvbjpub25lIWltcG9ydGFudH19CgovKiBFbGRlaG9mIDYuMC4xIOKAkyBsb2thbGVyIG15VkFJTExBTlQtSW1wb3J0ICovCiN2YWlsbGFudEltcG9ydFBhbmVsIC5hY3Rpb24tcm93e21hcmdpbi10b3A6MTRweH0KI3ZhaWxsYW50SW1wb3J0U3RhdHVzLm9re2NvbG9yOiNhNWU2OWF9CiN2YWlsbGFudEltcG9ydFN0YXR1cy5lcnJvcntjb2xvcjojZmZhYWE5fQoKLyogRWxkZWhvZiA2LjEuMCDigJMgWsOkaGxlcnN0w6RuZGUgYWxzIGVpbnppZ2UgbWFudWVsbGUgVmVyYnJhdWNoc2VpbmdhYmUgKi8KLnJlY29yZC1zdGF0dXMtYmFkZ2V7anVzdGlmeS1zZWxmOmVuZDtmb250LXNpemU6MTFweDtjb2xvcjojOWRiMGMwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzo2cHggOHB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDojMDgxNzI1fQoubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfQoubWV0ZXItaGlzdG9yeXtkaXNwbGF5OmdyaWQ7Z2FwOjdweDttYXJnaW46MTRweCAwfS5tZXRlci1oaXN0b3J5LXJvd3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxMDBweCwxZnIpIHJlcGVhdCgyLG1pbm1heCgxMTBweCwxZnIpKSBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjEwcHggMTJweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiMwODE3MjU7Zm9udC1zaXplOjEycHh9Lm1ldGVyLWhpc3Rvcnktcm93IHNwYW4sLm1ldGVyLWhpc3Rvcnktcm93IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0ubWV0ZXItaGlzdG9yeS1yb3cgc3Ryb25ne2ZvbnQtc2l6ZToxMnB4fS5tZXRlci1hY3Rpb25ze21hcmdpbi10b3A6MTJweH0ubWV0ZXItcHJldmlvdXN7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1O2NvbG9yOiNiOWM3ZDI7bGluZS1oZWlnaHQ6MS41fS5jb21wYWN0LW5vdGV7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfS5tZXRlci1sYXRlc3QubWV0cmljLWdyaWQgYXJ0aWNsZTpmaXJzdC1jaGlsZHtncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0ubWV0ZXItaGlzdG9yeS1yb3cgc3BhbntncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvdyBzbWFsbHtkaXNwbGF5Om5vbmV9LnJlY29yZC1zdGF0dXMtYmFkZ2V7Zm9udC1zaXplOjEwcHh9fQoKLyogRWxkZWhvZiA2LjEuMSDigJMgTW9uYXRzd2VydGUgd2llZGVyIGJlYXJiZWl0YmFyICovCi5maWVsZCBpbnB1dFtyZWFkb25seV17b3BhY2l0eTouNzI7Y3Vyc29yOmRlZmF1bHQ7YmFja2dyb3VuZDojMGIxNzIyfS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kO3doaXRlLXNwYWNlOm5vd3JhcH0KCgovKiBFbGRlaG9mIDYuMi4wIOKAkyBhdXRvbWF0aXNjaGVyIEdlcsOkdGUtU3luYywgSmFocmVzdmVyZ2xlaWNoLCBPc3Ryb20tSGlzdG9yaWUgKi8KLmZpbHRlci1ub3Rle21hcmdpbjowO2FsaWduLXNlbGY6Y2VudGVyO21heC13aWR0aDo2MjBweDtmb250LXNpemU6MTJweH0ueWVhci1jb21wYXJpc29uLWxlZ2VuZHtkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHggMTZweDttYXJnaW46LTRweCAwIDEycHg7Y29sb3I6I2I4YzZkMjtmb250LXNpemU6MTJweH0ueWVhci1sZWdlbmQtaXRlbXtkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4fS55ZWFyLWxlZ2VuZC1pdGVtIGl7ZGlzcGxheTppbmxpbmUtYmxvY2s7d2lkdGg6MjhweDtoZWlnaHQ6MDtib3JkZXItdG9wLXdpZHRoOjNweDtib3JkZXItdG9wLXN0eWxlOnNvbGlkfQouc3luYy1iYWRnZXtmb250LXNpemU6MTFweDtjb2xvcjojYjlmNWFhO2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4wOCk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDExNCwyMjAsODcsLjIyKTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6NnB4IDlweDtmb250LXdlaWdodDo4MDB9LnN5bmMtZGV2aWNlLWxpbmV7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTBweDttYXJnaW46MTJweCAwfS5zeW5jLWRldmljZS1saW5lPmRpdntiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEzcHh9LnN5bmMtZGV2aWNlLWxpbmUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6MTFweH0uc3luYy1kZXZpY2UtbGluZSBzdHJvbmd7ZGlzcGxheTpibG9jazttYXJnaW4tdG9wOjRweH0uc3luYy1qb2luLWJveHtwYWRkaW5nOjAgMTRweCAxNHB4fS5zeW5jLXBhaXItcmVzdWx0e21hcmdpbi10b3A6MTJweDtwYWRkaW5nOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDc3LDE1NiwyNTUsLjIyKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDpyZ2JhKDc3LDE1NiwyNTUsLjA1KX0uc3luYy1wYWlyLXJlc3VsdCBzbWFsbHtkaXNwbGF5OmJsb2NrO2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjlweDtsaW5lLWhlaWdodDoxLjQ1fS5vc3Ryb20taGlzdG9yeS1ib3h7ZGlzcGxheTpmbGV4O2dhcDoxNnB4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjttYXJnaW4tdG9wOjE2cHg7cGFkZGluZzoxM3B4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1fS5vc3Ryb20taGlzdG9yeS1ib3ggc3Ryb25nLC5vc3Ryb20taGlzdG9yeS1ib3ggc21hbGx7ZGlzcGxheTpibG9ja30ub3N0cm9tLWhpc3RvcnktYm94IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjRweDtsaW5lLWhlaWdodDoxLjQ1O21heC13aWR0aDo3MDBweH0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmZpbHRlci1wYW5lbHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5maWx0ZXItbm90ZXtwYWRkaW5nLXRvcDoycHh9LnN5bmMtZGV2aWNlLWxpbmV7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0ub3N0cm9tLWhpc3RvcnktYm94e2FsaWduLWl0ZW1zOnN0cmV0Y2g7ZmxleC1kaXJlY3Rpb246Y29sdW1ufS5vc3Ryb20taGlzdG9yeS1ib3ggYnV0dG9ue3dpZHRoOjEwMCV9fQo=","type":"text/css; charset=utf-8","cache":"no-cache"},"/app.js":{"body":"KCgpID0+IHsKICAidXNlIHN0cmljdCI7CgogIGNvbnN0IEFQUF9CVUlMRCA9ICI2LjIuMC1HRVJBRVRFLVNZTkMtSkFIUkVTVkVSR0xFSUNILU9TVFJPTS1ISVNUT1JJRS0yMDI2MTAwNSI7CiAgY29uc3QgREFUQV9LRVkgPSAiZWxkZWhvZi12My1yZWNvcmRzIjsKICBjb25zdCBTRVRUSU5HU19LRVkgPSAiZWxkZWhvZi12My1zZXR0aW5ncyI7CiAgY29uc3QgVkFJTExBTlRfTU9OVEhTX0tFWSA9ICJlbGRlaG9mLXYzLXZhaWxsYW50LW1vbnRocy12MzgwIjsKICBjb25zdCBPU1RST01fQ0FDSEVfS0VZID0gImVsZGVob2YtdjMtb3N0cm9tLWxpdmUtY2FjaGUiOwogIGNvbnN0IE9TVFJPTV9DT05UUk9MX0tFWSA9ICJlbGRlaG9mLXY1LW9zdHJvbS1jb250cm9sLXY1NDEiOwogIGNvbnN0IFNIQURPV19LRVkgPSAiZWxkZWhvZi12Ni1yZWNvcmRzLXNoYWRvdyI7CiAgY29uc3QgU0hBRE9XX01FVEFfS0VZID0gImVsZGVob2YtdjYtcmVjb3Jkcy1zaGFkb3ctbWV0YSI7CiAgY29uc3QgTEFTVF9CQUNLVVBfS0VZID0gImVsZGVob2YtdjYtbGFzdC1iYWNrdXAtYXQiOwogIGNvbnN0IE1FVEVSX0tFWSA9ICJlbGRlaG9mLXY2LW1ldGVyLXJlYWRpbmdzLXY2MTAiOwogIGNvbnN0IEhJU1RPUllfU0VFRF9LRVkgPSAiZWxkZWhvZi12Ni1oaXN0b3J5LXNlZWQtdjYxMCI7CiAgY29uc3QgU1lOQ19TVEFURV9LRVkgPSAiZWxkZWhvZi12Ni1zeW5jLXN0YXRlLXY2MjAiOwogIGNvbnN0IFNZTkNfU0VDUkVUX0tFWSA9ICJlbGRlaG9mLXY2LXN5bmMtc2VjcmV0LXY2MjAiOwogIGNvbnN0IFNZTkNfRU5WRUxPUEVfU0NIRU1BID0gImVsZGVob2YtZW5jcnlwdGVkLXN5bmMtdjEiOwogIGNvbnN0IFNZTkNfUEFZTE9BRF9TQ0hFTUEgPSAiZWxkZWhvZi1zeW5jLXBheWxvYWQtdjYyMCI7CiAgY29uc3QgU0VUVElOR1NfVVBEQVRFRF9LRVkgPSAiZWxkZWhvZi12Ni1zZXR0aW5ncy11cGRhdGVkLXY2MjAiOwogIGNvbnN0IE9TVFJPTV9ISVNUT1JZX1NZTkNfS0VZID0gImVsZGVob2YtdjYtb3N0cm9tLWhpc3Rvcnktc3luYy12NjIwIjsKICBjb25zdCBNT05USFMgPSBbIkphbiIsIkZlYiIsIk3DpHIiLCJBcHIiLCJNYWkiLCJKdW4iLCJKdWwiLCJBdWciLCJTZXAiLCJPa3QiLCJOb3YiLCJEZXoiXTsKICBjb25zdCBDT0xPUlMgPSB7IHRvdGFsOiIjNzJkYzU3IiwgaGVhdDoiI2ZmOWY0MyIsIGFubmV4OiIjNGQ5Y2ZmIiwgcmVzdDoiI2YyZDE1ZiIsIGNvbXBhcmU6IiM5YzdkZmYiLCBjb3N0OiIjNWZjN2MyIiwgZ3JpZDoicmdiYSgxNzEsMTk4LDIyMCwuMTQpIiwgdGV4dDoiIzk0YThiYSIgfTsKICBjb25zdCBISVNUT1JJQ0FMX1NFRUQgPSB7ImhlYXRQdW1wIjp7IjIwMjMtMTIiOjE1NTAsIjIwMjQtMDEiOjE5ODAsIjIwMjQtMDIiOjExMTMsIjIwMjQtMDMiOjkwNywiMjAyNC0wNCI6NTM1LCIyMDI0LTA1IjoxNTYsIjIwMjQtMDYiOjExMCwiMjAyNC0wNyI6MTEwLCIyMDI0LTA4IjoxMDgsIjIwMjQtMDkiOjE5OCwiMjAyNC0xMCI6NDkwLCIyMDI0LTExIjoxMDAzLCIyMDI0LTEyIjoxMzA1LCIyMDI1LTAxIjoxNjk0LCIyMDI1LTAyIjoxNDc4LCIyMDI1LTAzIjoxMDA1LCIyMDI1LTA0Ijo0OTgsIjIwMjUtMDUiOjM2NywiMjAyNS0wNiI6MTM3LCIyMDI1LTA3IjoxMDYsIjIwMjUtMDgiOjEyOCwiMjAyNS0wOSI6MTg1LCIyMDI1LTEwIjo2MDcsIjIwMjUtMTEiOjEwNDAsIjIwMjUtMTIiOjEyNjUsIjIwMjYtMDEiOjE4NTUsIjIwMjYtMDIiOjE0ODgsIjIwMjYtMDMiOjg5NSwiMjAyNi0wNCI6NjU2LCIyMDI2LTA1IjozMDAsIjIwMjYtMDYiOjEyNiwiMjAyNi0wNyI6MTI4LCIyMDI2LTA4IjoxMjEsIjIwMjYtMDkiOjEzN30sImFubmV4Ijp7IjIwMjQtMDEiOjIxMCwiMjAyNC0wMiI6MjEwLCIyMDI0LTAzIjoyMTksIjIwMjQtMDQiOjIwMCwiMjAyNC0wNSI6MjIyLCIyMDI0LTA2IjoxNjQsIjIwMjQtMDciOjIxOSwiMjAyNC0wOCI6MjAxLCIyMDI0LTA5IjoxOTIsIjIwMjQtMTAiOjIzNywiMjAyNC0xMSI6MjI3LCIyMDI0LTEyIjoyNjYsIjIwMjUtMDEiOjI2MSwiMjAyNS0wMiI6MjM1LCIyMDI1LTAzIjoyMjEsIjIwMjUtMDQiOjIzOCwiMjAyNS0wNSI6MjIxLCIyMDI1LTA2IjoyMzcsIjIwMjUtMDciOjI0MCwiMjAyNS0wOCI6MjMyLCIyMDI1LTA5IjozMDgsIjIwMjUtMTAiOjIyMCwiMjAyNS0xMSI6MjM3LCIyMDI1LTEyIjoyNzMsIjIwMjYtMDEiOjI0MCwiMjAyNi0wMiI6MjI1LCIyMDI2LTAzIjoyNzAsIjIwMjYtMDQiOjIxNSwiMjAyNi0wNSI6MjIwLCIyMDI2LTA2IjoyNTAsIjIwMjYtMDciOjIxMCwiMjAyNi0wOCI6MjQwLCIyMDI2LTA5IjoyNjV9LCJ0b3RhbCI6eyIyMDI0LTAxIjoyNDUwLCIyMDI0LTAyIjoxNjE1LCIyMDI0LTAzIjoxMzIwLCIyMDI0LTA0Ijo5MzMsIjIwMjQtMDUiOjczMSwiMjAyNC0wNiI6NTg3LCIyMDI0LTA3Ijo2MjAsIjIwMjQtMDgiOjU0MCwiMjAyNC0wOSI6NjEyLCIyMDI0LTEwIjoxMDE5LCIyMDI0LTExIjoxNTIxLCIyMDI0LTEyIjoxODU3LCIyMDI1LTAxIjoyMjgyLCIyMDI1LTAyIjoyMDIzLCIyMDI1LTAzIjoxNDE0LCIyMDI1LTA0Ijo5NjAsIjIwMjUtMDUiOjkzMywiMjAyNS0wNiI6NzUxLCIyMDI1LTA3Ijo2ODAsIjIwMjUtMDgiOjY3NiwiMjAyNS0wOSI6ODE0LCIyMDI1LTEwIjoxMTA1LCIyMDI1LTExIjoxNjE1LCIyMDI1LTEyIjoxODUwLCIyMDI2LTAxIjoyNDUwLCIyMDI2LTAyIjoyMDYwLCIyMDI2LTAzIjoxNTk3LCIyMDI2LTA0IjoxMDUxLCIyMDI2LTA1Ijo3NjcsIjIwMjYtMDYiOjY2MiwiMjAyNi0wNyI6NjA4LCIyMDI2LTA4Ijo2ODUsIjIwMjYtMDkiOjY1NX19OwogIGNvbnN0IEJBU0VMSU5FX01FVEVSX1JFQURJTkcgPSB7ZGF0ZToiMjAyNi0xMC0wMSIsdG90YWw6MzQyNTUsYW5uZXg6OTA0NSxub3RlOiJTdGFydHdlcnQgZsO8ciBkaWUgYXV0b21hdGlzY2hlIEJlcmVjaG51bmcgYWIgT2t0b2JlciAyMDI2Iix1cGRhdGVkQXQ6IjIwMjYtMTAtMDVUMDA6MDA6MDAuMDAwWiJ9OwogIGNvbnN0ICQgPSBpZCA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CgogIGxldCBzZXR0aW5ncyA9IGxvYWRTZXR0aW5ncygpOwogIGxldCByZWNvcmRzID0gbG9hZFJlY29yZHMoKTsKICBsZXQgdmFpbGxhbnRNb250aHMgPSBsb2FkVmFpbGxhbnRNb250aHMoKTsKICBsZXQgb3N0cm9tTGl2ZSA9IGxvYWRPc3Ryb21DYWNoZSgpOwogIGxldCBvc3Ryb21CdXN5ID0gZmFsc2U7CiAgbGV0IG9zdHJvbVRpbWVyID0gbnVsbDsKICBsZXQgdG9hc3RUaW1lciA9IG51bGw7CiAgbGV0IHJlc2l6ZVRpbWVyID0gbnVsbDsKICBsZXQgY3VycmVudFZpZXcgPSAiZGFzaGJvYXJkVmlldyI7CiAgbGV0IG1ldGVyUmVhZGluZ3MgPSBsb2FkTWV0ZXJSZWFkaW5ncygpOwogIGxldCBzeW5jU3RhdGUgPSBsb2FkU3luY1N0YXRlKCk7CiAgbGV0IHN5bmNCdXN5ID0gZmFsc2U7CiAgbGV0IHN5bmNUaW1lciA9IG51bGw7CiAgbGV0IHN5bmNQb2xsVGltZXIgPSBudWxsOwogIGxldCBvc3Ryb21IaXN0b3J5QnVzeSA9IGZhbHNlOwoKICBmdW5jdGlvbiBzYWZlSnNvblBhcnNlKHZhbHVlLCBmYWxsYmFjaz1udWxsKXsgdHJ5e3JldHVybiBKU09OLnBhcnNlKHZhbHVlKTt9Y2F0Y2h7cmV0dXJuIGZhbGxiYWNrO30gfQogIGZ1bmN0aW9uIG51bGxhYmxlTnVtYmVyKHZhbHVlKXsgaWYodmFsdWU9PT0iInx8dmFsdWU9PT1udWxsfHx2YWx1ZT09PXVuZGVmaW5lZClyZXR1cm4gbnVsbDsgY29uc3Qgbj1OdW1iZXIodmFsdWUpOyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pP246bnVsbDsgfQogIGZ1bmN0aW9uIHNvcnRlZChpdGVtcz1yZWNvcmRzKXsgcmV0dXJuIFsuLi5pdGVtc10uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsgfQogIGZ1bmN0aW9uIGN1cnJlbnRNb250aEtleSgpeyBjb25zdCBkPW5ldyBEYXRlKCk7IHJldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9YDsgfQogIGZ1bmN0aW9uIG1vbnRoTGFiZWwobW9udGgsbG9uZz10cnVlKXsgY29uc3QgW3ksbV09U3RyaW5nKG1vbnRoKS5zcGxpdCgiLSIpLm1hcChOdW1iZXIpOyBpZigheXx8IW0pcmV0dXJuIG1vbnRoOyByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIixsb25nP3ttb250aDoibG9uZyIseWVhcjoibnVtZXJpYyJ9Onttb250aDoic2hvcnQiLHllYXI6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHksbS0xLDEpKTsgfQogIGZ1bmN0aW9uIG51bSh2YWx1ZSxkaWdpdHM9MCl7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHZhbHVlKSk/bmV3IEludGwuTnVtYmVyRm9ybWF0KCJkZS1ERSIse21pbmltdW1GcmFjdGlvbkRpZ2l0czpkaWdpdHMsbWF4aW11bUZyYWN0aW9uRGlnaXRzOmRpZ2l0c30pLmZvcm1hdChOdW1iZXIodmFsdWUpKToi4oCTIjsgfQogIGZ1bmN0aW9uIGV1cm8odmFsdWUpeyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcih2YWx1ZSkpP25ldyBJbnRsLk51bWJlckZvcm1hdCgiZGUtREUiLHtzdHlsZToiY3VycmVuY3kiLGN1cnJlbmN5OiJFVVIifSkuZm9ybWF0KE51bWJlcih2YWx1ZSkpOiLigJMiOyB9CiAgZnVuY3Rpb24gcGN0KHZhbHVlKXsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIodmFsdWUpKT9gJHt2YWx1ZT4wPyIrIjoiIn0ke251bSh2YWx1ZSwxKX0gJWA6IuKAkyI7IH0KICBmdW5jdGlvbiBlc2NhcGVIdG1sKHZhbHVlKXsgcmV0dXJuIFN0cmluZyh2YWx1ZT8/IiIpLnJlcGxhY2UoL1smPD4iJ10vZyxjaD0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsIlwiIjoiJnF1b3Q7IiwiJyI6IiYjMzk7In1bY2hdKSk7IH0KICBmdW5jdGlvbiBjc3ZDZWxsKHZhbHVlKXsgY29uc3Qgcz1TdHJpbmcodmFsdWU/PyIiKTsgcmV0dXJuIGAiJHtzLnJlcGxhY2UoLyIvZywnIiInKX0iYDsgfQogIGZ1bmN0aW9uIGRhdGVTdGFtcCgpeyBjb25zdCBkPW5ldyBEYXRlKCk7IHJldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKGQuZ2V0RGF0ZSgpKS5wYWRTdGFydCgyLCIwIil9YDsgfQoKICBmdW5jdGlvbiBzYW5pdGl6ZVJlY29yZChyYXcpewogICAgY29uc3QgbW9udGg9U3RyaW5nKHJhdz8ubW9udGh8fCIiKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9JC8udGVzdChtb250aCkpcmV0dXJuIG51bGw7CiAgICByZXR1cm4gewogICAgICBtb250aCwKICAgICAgaGVhdFB1bXA6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRQdW1wKSwKICAgICAgYW5uZXg6bnVsbGFibGVOdW1iZXIocmF3LmFubmV4KSwKICAgICAgdG90YWw6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsKSwKICAgICAgcHJpY2VDdDpudWxsYWJsZU51bWJlcihyYXcucHJpY2VDdCA/PyByYXcuYXZlcmFnZVByaWNlQ3QpLAogICAgICBiYXNlRmVlOm51bGxhYmxlTnVtYmVyKHJhdy5iYXNlRmVlKSwKICAgICAgbm90ZTpTdHJpbmcocmF3Lm5vdGV8fCIiKS50cmltKCkuc2xpY2UoMCw4MDApLAogICAgICBoZWF0R2VuZXJhdGVkOm51bGxhYmxlTnVtYmVyKHJhdy5oZWF0R2VuZXJhdGVkKSwKICAgICAgaGVhdGluZ0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKHJhdy5oZWF0aW5nRWxlY3RyaWNpdHkpLAogICAgICBkaHdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcihyYXcuZGh3RWxlY3RyaWNpdHkpLAogICAgICBoZWF0aW5nSGVhdDpudWxsYWJsZU51bWJlcihyYXcuaGVhdGluZ0hlYXQpLAogICAgICBkaHdIZWF0Om51bGxhYmxlTnVtYmVyKHJhdy5kaHdIZWF0KSwKICAgICAgaGVhdFB1bXBTb3VyY2U6U3RyaW5nKHJhdy5oZWF0UHVtcFNvdXJjZXx8IiIpLnNsaWNlKDAsNjApLAogICAgICBoZWF0UHVtcFVwZGF0ZWRBdDpyYXcuaGVhdFB1bXBVcGRhdGVkQXQ/U3RyaW5nKHJhdy5oZWF0UHVtcFVwZGF0ZWRBdCk6bnVsbCwKICAgICAgbWV0ZXJSZWFkaW5nRGF0ZTpyYXcubWV0ZXJSZWFkaW5nRGF0ZT9TdHJpbmcocmF3Lm1ldGVyUmVhZGluZ0RhdGUpOm51bGwsCiAgICAgIHByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZTpyYXcucHJldmlvdXNNZXRlclJlYWRpbmdEYXRlP1N0cmluZyhyYXcucHJldmlvdXNNZXRlclJlYWRpbmdEYXRlKTpudWxsLAogICAgICB0b3RhbE1ldGVyUmVhZGluZzpudWxsYWJsZU51bWJlcihyYXcudG90YWxNZXRlclJlYWRpbmcpLAogICAgICBhbm5leE1ldGVyUmVhZGluZzpudWxsYWJsZU51bWJlcihyYXcuYW5uZXhNZXRlclJlYWRpbmcpLAogICAgICBtZXRlclNvdXJjZTpTdHJpbmcocmF3Lm1ldGVyU291cmNlfHwiIikuc2xpY2UoMCw2MCksCiAgICAgIHVwZGF0ZWRBdDpyYXcudXBkYXRlZEF0P1N0cmluZyhyYXcudXBkYXRlZEF0KTpudWxsLAogICAgICBwcmljZVNvdXJjZTpTdHJpbmcocmF3LnByaWNlU291cmNlfHwiIikuc2xpY2UoMCw4MCksCiAgICAgIHByaWNlVXBkYXRlZEF0OnJhdy5wcmljZVVwZGF0ZWRBdD9TdHJpbmcocmF3LnByaWNlVXBkYXRlZEF0KTpudWxsLAogICAgICBvc3Ryb21Ub3RhbEtXaDpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tVG90YWxLV2gpLAogICAgICBvc3Ryb21WYXJpYWJsZUNvc3RFdXI6bnVsbGFibGVOdW1iZXIocmF3Lm9zdHJvbVZhcmlhYmxlQ29zdEV1ciksCiAgICAgIG9zdHJvbVRvdGFsQ29zdEV1cjpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tVG90YWxDb3N0RXVyKSwKICAgICAgb3N0cm9tQ29uc3VtcHRpb25JbnRlcnZhbHM6bnVsbGFibGVOdW1iZXIocmF3Lm9zdHJvbUNvbnN1bXB0aW9uSW50ZXJ2YWxzKSwKICAgICAgb3N0cm9tTWF0Y2hlZEludGVydmFsczpudWxsYWJsZU51bWJlcihyYXcub3N0cm9tTWF0Y2hlZEludGVydmFscyksCiAgICAgIG9zdHJvbUNvbXBsZXRlOkJvb2xlYW4ocmF3Lm9zdHJvbUNvbXBsZXRlKSwKICAgICAgY2xvc2VkOkJvb2xlYW4ocmF3LmNsb3NlZCksCiAgICAgIGNsb3NlZEF0OnJhdy5jbG9zZWRBdD9TdHJpbmcocmF3LmNsb3NlZEF0KTpudWxsCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZVJlY29yZHMoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10peyBjb25zdCByPXNhbml0aXplUmVjb3JkKHJhdyk7IGlmKHIpbWFwLnNldChyLm1vbnRoLHIpOyB9CiAgICByZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsKICB9CiAgZnVuY3Rpb24gZGVyaXZlZChyKXsgaWYoIVtyPy5oZWF0UHVtcCxyPy5hbm5leCxyPy50b3RhbF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSlyZXR1cm4gbnVsbDsgcmV0dXJuIHIudG90YWwtci5oZWF0UHVtcC1yLmFubmV4OyB9CiAgZnVuY3Rpb24gY29tcGxldGUocil7IGNvbnN0IHJlc3Q9ZGVyaXZlZChyKTsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdD49MDsgfQogIGZ1bmN0aW9uIHJlY29yZENvc3Qocil7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUocj8ub3N0cm9tVG90YWxDb3N0RXVyKSYmcj8ub3N0cm9tQ29tcGxldGUpcmV0dXJuIE51bWJlcihyLm9zdHJvbVRvdGFsQ29zdEV1cik7CiAgICBpZighTnVtYmVyLmlzRmluaXRlKHI/LnRvdGFsKSlyZXR1cm4gbnVsbDsKICAgIGNvbnN0IHByaWNlPU51bWJlci5pc0Zpbml0ZShyLnByaWNlQ3QpP3IucHJpY2VDdC8xMDA6TnVtYmVyKHNldHRpbmdzLmZhbGxiYWNrUHJpY2V8fDAuMzIpOwogICAgY29uc3QgYmFzZT1OdW1iZXIuaXNGaW5pdGUoci5iYXNlRmVlKT9yLmJhc2VGZWU6TnVtYmVyKHNldHRpbmdzLmRlZmF1bHRCYXNlRmVlfHwwKTsKICAgIHJldHVybiByLnRvdGFsKnByaWNlK2Jhc2U7CiAgfQogIGZ1bmN0aW9uIHJlY29yZENvcChyKXsgcmV0dXJuIE51bWJlcihyPy5oZWF0UHVtcCk+MCYmTnVtYmVyLmlzRmluaXRlKE51bWJlcihyPy5oZWF0R2VuZXJhdGVkKSk/TnVtYmVyKHIuaGVhdEdlbmVyYXRlZCkvTnVtYmVyKHIuaGVhdFB1bXApOm51bGw7IH0KCiAgZnVuY3Rpb24gcmF3U2V0dGluZ3MoKXsgY29uc3Qgdj1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNFVFRJTkdTX0tFWSkse30pOyByZXR1cm4gdiYmdHlwZW9mIHY9PT0ib2JqZWN0IiYmIUFycmF5LmlzQXJyYXkodik/djp7fTsgfQogIGZ1bmN0aW9uIGxvYWRTZXR0aW5ncygpewogICAgY29uc3QgcmF3PXJhd1NldHRpbmdzKCk7CiAgICByZXR1cm4gewogICAgICAuLi5yYXcsCiAgICAgIGZhbGxiYWNrUHJpY2U6TnVtYmVyLmlzRmluaXRlKE51bWJlcihyYXcuZmFsbGJhY2tQcmljZSkpP051bWJlcihyYXcuZmFsbGJhY2tQcmljZSk6TnVtYmVyLmlzRmluaXRlKE51bWJlcihyYXcucHJpY2UpKT9OdW1iZXIocmF3LnByaWNlKTowLjMyLAogICAgICBkZWZhdWx0QmFzZUZlZTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5kZWZhdWx0QmFzZUZlZSkpP051bWJlcihyYXcuZGVmYXVsdEJhc2VGZWUpOjAsCiAgICAgIG9zdHJvbUFwcEtleTpTdHJpbmcocmF3Lm9zdHJvbUFwcEtleXx8IiIpLAogICAgICBvc3Ryb21BdXRvUmVmcmVzaDpyYXcub3N0cm9tQXV0b1JlZnJlc2ghPT1mYWxzZSwKICAgICAgcHJlZmVycmVkV2luZG93SG91cnM6WzEsMiwzLDRdLmluY2x1ZGVzKE51bWJlcihyYXcucHJlZmVycmVkV2luZG93SG91cnMpKT9OdW1iZXIocmF3LnByZWZlcnJlZFdpbmRvd0hvdXJzKTozCiAgICB9OwogIH0KICBmdW5jdGlvbiBzYXZlU2V0dGluZ3Moe3NraXBTeW5jPWZhbHNlfT17fSl7CiAgICBjb25zdCBwcmV2aW91cz1yYXdTZXR0aW5ncygpOwogICAgY29uc3QgbWVyZ2VkPXsuLi5wcmV2aW91cywKICAgICAgZmFsbGJhY2tQcmljZTpOdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZSl8fDAsCiAgICAgIGRlZmF1bHRCYXNlRmVlOk51bWJlcihzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZSl8fDAsCiAgICAgIG9zdHJvbUFwcEtleTpTdHJpbmcoc2V0dGluZ3Mub3N0cm9tQXBwS2V5fHwiIiksCiAgICAgIG9zdHJvbUF1dG9SZWZyZXNoOnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoIT09ZmFsc2UsCiAgICAgIHByZWZlcnJlZFdpbmRvd0hvdXJzOlsxLDIsMyw0XS5pbmNsdWRlcyhOdW1iZXIoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnMpKT9OdW1iZXIoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnMpOjMKICAgIH07CiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTRVRUSU5HU19LRVksSlNPTi5zdHJpbmdpZnkobWVyZ2VkKSk7CiAgICBzZXR0aW5ncz17Li4uc2V0dGluZ3MsLi4ubWVyZ2VkfTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNFVFRJTkdTX1VQREFURURfS0VZLG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7CiAgICBpZighc2tpcFN5bmMpc2NoZWR1bGVDbG91ZFB1c2goKTsKICB9CgogIGZ1bmN0aW9uIHJlYWRQcmltYXJ5UmVjb3JkcygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShEQVRBX0tFWSksbnVsbCk7IHJldHVybiBBcnJheS5pc0FycmF5KHJhdyk/c2FuaXRpemVSZWNvcmRzKHJhdyk6bnVsbDsgfQogIGZ1bmN0aW9uIHJlYWRTaGFkb3dSZWNvcmRzKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNIQURPV19LRVkpLG51bGwpOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3Nhbml0aXplUmVjb3JkcyhyYXcpOltdOyB9CiAgZnVuY3Rpb24gbG9hZFJlY29yZHMoKXsKICAgIGNvbnN0IHByaW1hcnk9cmVhZFByaW1hcnlSZWNvcmRzKCk7CiAgICBpZihwcmltYXJ5IT09bnVsbClyZXR1cm4gcHJpbWFyeTsKICAgIGZvcihjb25zdCBrZXkgb2YgWyJlbGRlaG9mLXYxLWRhdGEiLCJlbmVyaGF1cy12MS1kYXRhIl0pewogICAgICBjb25zdCBsZWdhY3k9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpLG51bGwpOwogICAgICBpZihBcnJheS5pc0FycmF5KGxlZ2FjeSkpewogICAgICAgIGNvbnN0IG1pZ3JhdGVkPXNhbml0aXplUmVjb3JkcyhsZWdhY3kpOwogICAgICAgIGlmKG1pZ3JhdGVkLmxlbmd0aClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShEQVRBX0tFWSxKU09OLnN0cmluZ2lmeShtaWdyYXRlZCkpOwogICAgICAgIHJldHVybiBtaWdyYXRlZDsKICAgICAgfQogICAgfQogICAgcmV0dXJuIFtdOwogIH0KICBmdW5jdGlvbiBzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb249IsOEbmRlcnVuZyIsYWxsb3dFbXB0eT1mYWxzZSxza2lwU3luYz1mYWxzZX09e30pewogICAgY29uc3QgY2xlYW49c2FuaXRpemVSZWNvcmRzKG5leHQpOwogICAgY29uc3QgcHJldmlvdXM9cmVhZFByaW1hcnlSZWNvcmRzKCl8fFtdOwogICAgaWYoIWFsbG93RW1wdHkgJiYgcHJldmlvdXMubGVuZ3RoPjAgJiYgY2xlYW4ubGVuZ3RoPT09MCl0aHJvdyBuZXcgRXJyb3IoIkxlZXJlciBNb25hdHNiZXN0YW5kIHdpcmQgYXVzIFNpY2hlcmhlaXRzZ3LDvG5kZW4gbmljaHQgYXV0b21hdGlzY2ggZ2VzcGVpY2hlcnQuIik7CiAgICBpZihwcmV2aW91cy5sZW5ndGgpewogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTSEFET1dfS0VZLEpTT04uc3RyaW5naWZ5KHByZXZpb3VzKSk7CiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNIQURPV19NRVRBX0tFWSxKU09OLnN0cmluZ2lmeSh7c2F2ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkscmVhc29uLHJlY29yZHM6cHJldmlvdXMubGVuZ3RofSkpOwogICAgfQogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkoY2xlYW4pKTsKICAgIHJlY29yZHM9Y2xlYW47CiAgICB1cGRhdGVSZWNvdmVyeUJhbm5lcigpOwogICAgaWYoIXNraXBTeW5jKXNjaGVkdWxlQ2xvdWRQdXNoKCk7CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplTWV0ZXJSZWFkaW5nKHJhdyl7CiAgICBjb25zdCBkYXRlPVN0cmluZyhyYXc/LmRhdGV8fCIiKTsKICAgIGNvbnN0IHRvdGFsPW51bGxhYmxlTnVtYmVyKHJhdz8udG90YWwpLGFubmV4PW51bGxhYmxlTnVtYmVyKHJhdz8uYW5uZXgpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0tXGR7Mn0kLy50ZXN0KGRhdGUpfHwhTnVtYmVyLmlzRmluaXRlKHRvdGFsKXx8IU51bWJlci5pc0Zpbml0ZShhbm5leCl8fHRvdGFsPDB8fGFubmV4PDApcmV0dXJuIG51bGw7CiAgICByZXR1cm4ge2RhdGUsdG90YWwsYW5uZXgsbm90ZTpTdHJpbmcocmF3Py5ub3RlfHwiIikuc2xpY2UoMCwxODApLHVwZGF0ZWRBdDpyYXc/LnVwZGF0ZWRBdD9TdHJpbmcocmF3LnVwZGF0ZWRBdCk6bnVsbH07CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplTWV0ZXJSZWFkaW5ncyhpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHJhdyBvZiBBcnJheS5pc0FycmF5KGl0ZW1zKT9pdGVtczpbXSl7Y29uc3Qgcj1zYW5pdGl6ZU1ldGVyUmVhZGluZyhyYXcpO2lmKHIpbWFwLnNldChyLmRhdGUscik7fQogICAgcmV0dXJuIFsuLi5tYXAudmFsdWVzKCldLnNvcnQoKGEsYik9PmEuZGF0ZS5sb2NhbGVDb21wYXJlKGIuZGF0ZSkpOwogIH0KICBmdW5jdGlvbiBsb2FkTWV0ZXJSZWFkaW5ncygpe3JldHVybiBzYW5pdGl6ZU1ldGVyUmVhZGluZ3Moc2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShNRVRFUl9LRVkpLFtdKSk7fQogIGZ1bmN0aW9uIHNhdmVNZXRlclJlYWRpbmdzKG5leHQse3NraXBTeW5jPWZhbHNlfT17fSl7bWV0ZXJSZWFkaW5ncz1zYW5pdGl6ZU1ldGVyUmVhZGluZ3MobmV4dCk7bG9jYWxTdG9yYWdlLnNldEl0ZW0oTUVURVJfS0VZLEpTT04uc3RyaW5naWZ5KG1ldGVyUmVhZGluZ3MpKTtpZighc2tpcFN5bmMpc2NoZWR1bGVDbG91ZFB1c2goKTt9CiAgZnVuY3Rpb24gbGF0ZXN0TWV0ZXJSZWFkaW5nKCl7cmV0dXJuIG1ldGVyUmVhZGluZ3MuYXQoLTEpfHxudWxsO30KICBmdW5jdGlvbiBkYXRlTGFiZWwodmFsdWUpe2NvbnN0IGQ9bmV3IERhdGUoYCR7dmFsdWV9VDEyOjAwOjAwYCk7cmV0dXJuIE51bWJlci5pc05hTihkLnZhbHVlT2YoKSk/dmFsdWU6bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7ZGF5OiIyLWRpZ2l0Iixtb250aDoiMi1kaWdpdCIseWVhcjoibnVtZXJpYyJ9KS5mb3JtYXQoZCk7fQogIGZ1bmN0aW9uIG5leHRNb250aEZpcnN0KGRhdGUpe2NvbnN0IFt5LG1dPVN0cmluZyhkYXRlKS5zcGxpdCgiLSIpLm1hcChOdW1iZXIpO2NvbnN0IGQ9bmV3IERhdGUoeSxtLDEpO3JldHVybiBgJHtkLmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKGQuZ2V0TW9udGgoKSsxKS5wYWRTdGFydCgyLCIwIil9LTAxYDt9CiAgZnVuY3Rpb24gYXBwbHlIaXN0b3JpY2FsU2VlZCgpewogICAgaWYobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWV9TRUVEX0tFWSkpcmV0dXJuOwogICAgY29uc3QgbWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgY29uc3QgbW9udGhzPVsuLi5uZXcgU2V0KFsuLi5PYmplY3Qua2V5cyhISVNUT1JJQ0FMX1NFRUQudG90YWwpLC4uLk9iamVjdC5rZXlzKEhJU1RPUklDQUxfU0VFRC5hbm5leCksLi4uT2JqZWN0LmtleXMoSElTVE9SSUNBTF9TRUVELmhlYXRQdW1wKV0pXS5zb3J0KCk7CiAgICBmb3IoY29uc3QgbW9udGggb2YgbW9udGhzKXsKICAgICAgY29uc3Qgcj1tYXAuZ2V0KG1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRofSk7CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELnRvdGFsLG1vbnRoKSlyLnRvdGFsPUhJU1RPUklDQUxfU0VFRC50b3RhbFttb250aF07CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELmFubmV4LG1vbnRoKSlyLmFubmV4PUhJU1RPUklDQUxfU0VFRC5hbm5leFttb250aF07CiAgICAgIGlmKE9iamVjdC5oYXNPd24oSElTVE9SSUNBTF9TRUVELmhlYXRQdW1wLG1vbnRoKSl7CiAgICAgICAgY29uc3Qgc2VlZD1ISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXBbbW9udGhdOwogICAgICAgIGNvbnN0IGtlZXBFeGlzdGluZz1OdW1iZXIuaXNGaW5pdGUoci5oZWF0UHVtcCkmJk1hdGguYWJzKHIuaGVhdFB1bXAtc2VlZCk8PTI7CiAgICAgICAgaWYoIWtlZXBFeGlzdGluZylyLmhlYXRQdW1wPXNlZWQ7CiAgICAgICAgaWYoIXIuaGVhdFB1bXBTb3VyY2Upci5oZWF0UHVtcFNvdXJjZT0iaGlzdG9yaWNhbC11c2VyLWRhdGEiOwogICAgICB9CiAgICAgIGlmKG1vbnRoPT09IjIwMjQtMDMiKXsKICAgICAgICBjb25zdCBub3RlPSJaw6RobGVyd2VjaHNlbCBHZXNhbXRzdHJvbSBhbSAwMS4wNC4yMDI0OiBhbHRlciBaw6RobGVyIDYyLjI5NiBrV2gsIG5ldWVyIFrDpGhsZXIgMTk3IGtXaDsgTW9uYXRzdmVyYnJhdWNoIGtvcnJla3QgbWl0IDEuMzIwIGtXaCBiZXLDvGNrc2ljaHRpZ3QuIjsKICAgICAgICBpZighU3RyaW5nKHIubm90ZXx8IiIpLmluY2x1ZGVzKCJaw6RobGVyd2VjaHNlbCBHZXNhbXRzdHJvbSIpKXIubm90ZT1yLm5vdGU/YCR7ci5ub3RlfSDigKIgJHtub3RlfWA6bm90ZTsKICAgICAgfQogICAgICBpZihtb250aD09PSIyMDIzLTEyIiYmIXIubm90ZSlyLm5vdGU9Ikhpc3RvcmlzY2ggaXN0IGbDvHIgRGV6ZW1iZXIgMjAyMyBudXIgZGVyIFfDpHJtZXB1bXBlbnZlcmJyYXVjaCBkb2t1bWVudGllcnQuIjsKICAgICAgbWFwLnNldChtb250aCxyKTsKICAgIH0KICAgIHNhdmVSZWNvcmRzKFsuLi5tYXAudmFsdWVzKCldLHtyZWFzb246Ikhpc3RvcmlzY2hlIFZlcmJyYXVjaHNkYXRlbiAyMDI04oCTMDkvMjAyNiDDvGJlcm5vbW1lbiJ9KTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUllfU0VFRF9LRVksbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTsKICB9CiAgZnVuY3Rpb24gZW5zdXJlTWV0ZXJCYXNlbGluZSgpewogICAgaWYobWV0ZXJSZWFkaW5ncy5zb21lKHI9PnIuZGF0ZT09PUJBU0VMSU5FX01FVEVSX1JFQURJTkcuZGF0ZSkpcmV0dXJuOwogICAgaWYobWV0ZXJSZWFkaW5ncy5sZW5ndGg9PT0wKXNhdmVNZXRlclJlYWRpbmdzKFtCQVNFTElORV9NRVRFUl9SRUFESU5HXSk7CiAgfQogIGZ1bmN0aW9uIGxvYWRWYWlsbGFudE1vbnRocygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShWQUlMTEFOVF9NT05USFNfS0VZKSxbXSk7IHJldHVybiBBcnJheS5pc0FycmF5KHJhdyk/cmF3OltdOyB9CiAgZnVuY3Rpb24gc2F2ZVZhaWxsYW50TW9udGhzKHtza2lwU3luYz1mYWxzZX09e30peyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShWQUlMTEFOVF9NT05USFNfS0VZLEpTT04uc3RyaW5naWZ5KEFycmF5LmlzQXJyYXkodmFpbGxhbnRNb250aHMpP3ZhaWxsYW50TW9udGhzOltdKSk7IGlmKCFza2lwU3luYylzY2hlZHVsZUNsb3VkUHVzaCgpOyB9CiAgZnVuY3Rpb24gbG9hZE9zdHJvbUNhY2hlKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE9TVFJPTV9DQUNIRV9LRVkpLG51bGwpOyByZXR1cm4gcmF3JiZyYXcuZ2VuZXJhdGVkQXQ/cmF3Om51bGw7IH0KICBmdW5jdGlvbiBzYXZlT3N0cm9tQ2FjaGUocGF5bG9hZCl7IG9zdHJvbUxpdmU9cGF5bG9hZHx8bnVsbDsgaWYocGF5bG9hZClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShPU1RST01fQ0FDSEVfS0VZLEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTsgZWxzZSBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShPU1RST01fQ0FDSEVfS0VZKTsgfQoKICBmdW5jdGlvbiB1cGRhdGVSZWNvdmVyeUJhbm5lcigpewogICAgY29uc3QgcHJpbWFyeT1yZWFkUHJpbWFyeVJlY29yZHMoKTsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgY29uc3Qgc2hvdz0oIXByaW1hcnl8fHByaW1hcnkubGVuZ3RoPT09MCkmJnNoYWRvdy5sZW5ndGg+MDsKICAgICQoInJlY292ZXJ5QmFubmVyIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIHJlc3RvcmVTaGFkb3coKXsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgaWYoIXNoYWRvdy5sZW5ndGgpcmV0dXJuOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkoc2hhZG93KSk7CiAgICByZWNvcmRzPXNoYWRvdzsKICAgIHRvYXN0KGAke3NoYWRvdy5sZW5ndGh9IE1vbmF0c3dlcnRlIHdpZWRlcmhlcmdlc3RlbGx0YCk7CiAgICByZW5kZXJBbGwoKTsKICB9CgogIGZ1bmN0aW9uIHRvYXN0KG1lc3NhZ2UpeyBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7ICQoInRvYXN0IikudGV4dENvbnRlbnQ9bWVzc2FnZTsgJCgidG9hc3QiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsgdG9hc3RUaW1lcj1zZXRUaW1lb3V0KCgpPT4kKCJ0b2FzdCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpLDI2MDApOyB9CiAgZnVuY3Rpb24gc2V0U3RhdHVzKGlkLHRleHQsa2luZD0iIil7IGNvbnN0IGVsPSQoaWQpOyBlbC50ZXh0Q29udGVudD10ZXh0fHwiIjsgZWwuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke2tpbmR9YC50cmltKCk7IH0KCiAgZnVuY3Rpb24gc3dpdGNoVmlldyhpZCl7CiAgICBjdXJyZW50Vmlldz1pZDsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi52aWV3IikuZm9yRWFjaCh2PT52LmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsdi5pZD09PWlkKSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIuYm90dG9tLW5hdiBbZGF0YS1uYXZdIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsYi5kYXRhc2V0Lm5hdj09PWlkKSk7CiAgICB3aW5kb3cuc2Nyb2xsVG8oe3RvcDowLGJlaGF2aW9yOiJpbnN0YW50In0pOwogICAgaWYoaWQ9PT0iYW5hbHlzaXNWaWV3IilyZW5kZXJBbmFseXNpcygpOwogICAgaWYoaWQ9PT0iY29uc3VtcHRpb25WaWV3IilyZW5kZXJSZWNvcmRzKCk7CiAgICBpZihpZD09PSJkYXRhVmlldyIpcmVuZGVyRGF0YSgpOwogICAgaWYoaWQ9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7CiAgfQoKICBmdW5jdGlvbiB5ZWFycygpeyByZXR1cm4gWy4uLm5ldyBTZXQocmVjb3Jkcy5tYXAocj0+TnVtYmVyKHIubW9udGguc2xpY2UoMCw0KSkpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKV0uc29ydCgoYSxiKT0+Yi1hKTsgfQogIGZ1bmN0aW9uIGxhdGVzdFJlY29yZCgpeyByZXR1cm4gc29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkuYXQoLTEpfHxzb3J0ZWQoKS5hdCgtMSl8fG51bGw7IH0KICBmdW5jdGlvbiByZWNvcmRGb3JNb250aChtb250aCl7IHJldHVybiByZWNvcmRzLmZpbmQocj0+ci5tb250aD09PW1vbnRoKXx8bnVsbDsgfQoKICBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmQoKXsKICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RSZWNvcmQoKTsKICAgICQoImxhdGVzdE1vbnRoVGl0bGUiKS50ZXh0Q29udGVudD1sYXRlc3Q/bW9udGhMYWJlbChsYXRlc3QubW9udGgpOiJOb2NoIGtlaW5lIE1vbmF0c3dlcnRlIjsKICAgICQoImVkaXRMYXRlc3RCdG4iKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFsYXRlc3QpOwogICAgaWYobGF0ZXN0KSQoImVkaXRMYXRlc3RCdG4iKS5kYXRhc2V0Lm1vbnRoPWxhdGVzdC5tb250aDsKICAgIGNvbnN0IHJlc3Q9bGF0ZXN0P2Rlcml2ZWQobGF0ZXN0KTpudWxsOwogICAgY29uc3QgbWV0cmljcz1sYXRlc3Q/WwogICAgICBbIkdlc2FtdCIsYCR7bnVtKGxhdGVzdC50b3RhbCwxKX0ga1doYCxsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZT9gYXVzIFrDpGhsZXJzdGFuZCAke2RhdGVMYWJlbChsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZSl9YDoiZG9rdW1lbnRpZXJ0Il0sCiAgICAgIFsiV8Okcm1lcHVtcGUiLGAke251bShsYXRlc3QuaGVhdFB1bXAsMSl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LmhlYXRQdW1wKT9gJHtudW0obGF0ZXN0LmhlYXRQdW1wL2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoi4oCTIl0sCiAgICAgIFsiQWx0ZW50ZWlsIixgJHtudW0obGF0ZXN0LmFubmV4LDEpfSBrV2hgLGxhdGVzdC5tZXRlclJlYWRpbmdEYXRlP2Baw6RobGVyICR7bnVtKGxhdGVzdC5hbm5leE1ldGVyUmVhZGluZywwKX0ga1doYDpOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmbGF0ZXN0LnRvdGFsPjAmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QuYW5uZXgpP2Ake251bShsYXRlc3QuYW5uZXgvbGF0ZXN0LnRvdGFsKjEwMCwxKX0gJSBBbnRlaWxgOiLigJMiXSwKICAgICAgWyJTY2hsZWUvS2x1cyIsYCR7bnVtKHJlc3QsMSl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmbGF0ZXN0LnRvdGFsPjA/YCR7bnVtKHJlc3QvbGF0ZXN0LnRvdGFsKjEwMCwxKX0gJSBBbnRlaWxgOiJhdXRvbWF0aXNjaCJdLAogICAgICBbIktvc3RlbiIsZXVybyhyZWNvcmRDb3N0KGxhdGVzdCkpLE51bWJlci5pc0Zpbml0ZShsYXRlc3QucHJpY2VDdCk/YCR7bnVtKGxhdGVzdC5wcmljZUN0LDIpfSBjdC9rV2hgOiJGYWxsYmFjay1QcmVpcyJdCiAgICBdOltbIkdlc2FtdCIsIuKAkyIsIk1vbmF0IGVpbnRyYWdlbiJdLFsiV8Okcm1lcHVtcGUiLCLigJMiLCIiXSxbIkFsdGVudGVpbCIsIuKAkyIsIiJdLFsiU2NobGVlL0tsdXMiLCLigJMiLCIiXSxbIktvc3RlbiIsIuKAkyIsIiJdXTsKICAgICQoImxhdGVzdE1ldHJpY3MiKS5pbm5lckhUTUw9bWV0cmljcy5tYXAoKFtsYWJlbCx2YWx1ZSxzbWFsbF0pPT5gPGFydGljbGU+PHNwYW4+JHtsYWJlbH08L3NwYW4+PHN0cm9uZz4ke3ZhbHVlfTwvc3Ryb25nPjxzbWFsbD4ke3NtYWxsfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgY29uc3QgY29tcGFyZT1sYXRlc3Q/cmVjb3JkRm9yTW9udGgoYCR7TnVtYmVyKGxhdGVzdC5tb250aC5zbGljZSgwLDQpKS0xfS0ke2xhdGVzdC5tb250aC5zbGljZSg1LDcpfWApOm51bGw7CiAgICBjb25zdCBkZWx0YT1sYXRlc3QmJmNvbXBhcmUmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoY29tcGFyZS50b3RhbCkmJmNvbXBhcmUudG90YWwhPT0wPyhsYXRlc3QudG90YWwtY29tcGFyZS50b3RhbCkvY29tcGFyZS50b3RhbCoxMDA6bnVsbDsKICAgIGNvbnN0IGNvbXA9JCgibGF0ZXN0Q29tcGFyaXNvbiIpOwogICAgY29tcC5jbGFzc05hbWU9ImNvbXBhcmlzb24tbGluZSBuZXV0cmFsIjsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShkZWx0YSkpewogICAgICBjb21wLnRleHRDb250ZW50PWBadW0gZ2xlaWNoZW4gTW9uYXQgZGVzIFZvcmphaHJlczogJHtwY3QoZGVsdGEpfSAoJHtudW0obGF0ZXN0LnRvdGFsLWNvbXBhcmUudG90YWwsMSl9IGtXaCkuYDsKICAgICAgY29tcC5jbGFzc05hbWU9YGNvbXBhcmlzb24tbGluZSAke2RlbHRhPjA/InBvc2l0aXZlIjpkZWx0YTwwPyJuZWdhdGl2ZSI6Im5ldXRyYWwifWA7CiAgICB9ZWxzZSBjb21wLnRleHRDb250ZW50PWxhdGVzdD8iRsO8ciBkaWVzZW4gTW9uYXQgaXN0IG5vY2gga2VpbiB2b2xsc3TDpG5kaWdlciBWb3JqYWhyZXN2ZXJnbGVpY2ggdm9yaGFuZGVuLiI6IlRyYWdlIGRlbiBlcnN0ZW4gTW9uYXRzd2VydCBlaW4uIjsKICAgIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpOwogICAgcmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJSZWNvcmRzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3Qgc2VsZWN0PSQoInJlY29yZFllYXJGaWx0ZXIiKTsKICAgIGNvbnN0IGN1cnJlbnQ9c2VsZWN0LnZhbHVlfHwiYWxsIjsKICAgIHNlbGVjdC5pbm5lckhUTUw9JzxvcHRpb24gdmFsdWU9ImFsbCI+QWxsZSBKYWhyZTwvb3B0aW9uPicreXMubWFwKHk9PmA8b3B0aW9uIHZhbHVlPSIke3l9Ij4ke3l9PC9vcHRpb24+YCkuam9pbigiIik7CiAgICBzZWxlY3QudmFsdWU9eXMuaW5jbHVkZXMoTnVtYmVyKGN1cnJlbnQpKT9jdXJyZW50OiJhbGwiOwogICAgY29uc3QgZmlsdGVyZWQ9c29ydGVkKCkucmV2ZXJzZSgpLmZpbHRlcihyPT5zZWxlY3QudmFsdWU9PT0iYWxsInx8ci5tb250aC5zdGFydHNXaXRoKGAke3NlbGVjdC52YWx1ZX0tYCkpOwogICAgJCgicmVjb3JkQ291bnQiKS50ZXh0Q29udGVudD1gJHtmaWx0ZXJlZC5sZW5ndGh9ICR7ZmlsdGVyZWQubGVuZ3RoPT09MT8iTW9uYXQiOiJNb25hdGUifWA7CiAgICBpZighZmlsdGVyZWQubGVuZ3RoKXsgJCgicmVjb3JkTGlzdCIpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPjxzdHJvbmc+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZSBpbiBkaWVzZXIgQXVzd2FobC48L3N0cm9uZz48c3Bhbj5aw6RobGVyc3TDpG5kZSB1bmQgbXlWQUlMTEFOVC1DU1YgZXJ6ZXVnZW4gZGllIE1vbmF0c3dlcnRlIGF1dG9tYXRpc2NoLjwvc3Bhbj48L2Rpdj4nOyByZXR1cm47IH0KICAgICQoInJlY29yZExpc3QiKS5pbm5lckhUTUw9ZmlsdGVyZWQubWFwKHI9PnsKICAgICAgY29uc3QgcmVzdD1kZXJpdmVkKHIpLCBpbnZhbGlkPU51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwOwogICAgICBjb25zdCBzdGF0dXM9aW52YWxpZD8iVW5wbGF1c2liZWwiOmNvbXBsZXRlKHIpPyJ2b2xsc3TDpG5kaWciOiJ1bnZvbGxzdMOkbmRpZyI7CiAgICAgIGNvbnN0IHNvdXJjZT1yLm1ldGVyUmVhZGluZ0RhdGU/YCDigKIgWsOkaGxlciBiaXMgJHtkYXRlTGFiZWwoci5tZXRlclJlYWRpbmdEYXRlKX1gOnIuaGVhdFB1bXBTb3VyY2U/LnN0YXJ0c1dpdGgoIm15dmFpbGxhbnQiKT8iIOKAoiBXw6RybWVwdW1wZSBhdXMgQ1NWIjoiIjsKICAgICAgcmV0dXJuIGA8YXJ0aWNsZSBjbGFzcz0icmVjb3JkLXJvdyAke2ludmFsaWQ/ImludmFsaWQiOiIifSI+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLW1vbnRoIj48c3Ryb25nPiR7ZXNjYXBlSHRtbChtb250aExhYmVsKHIubW9udGgpKX08L3N0cm9uZz48c21hbGw+JHtzdGF0dXN9JHtzb3VyY2V9JHtyLm5vdGU/YCDigKIgJHtlc2NhcGVIdG1sKHIubm90ZS5zbGljZSgwLDcwKSl9YDoiIn08L3NtYWxsPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+R2VzYW10PC9zcGFuPjxzdHJvbmc+JHtudW0oci50b3RhbCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5Xw6RybWVwdW1wZTwvc3Bhbj48c3Ryb25nPiR7bnVtKHIuaGVhdFB1bXAsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+QWx0ZW50ZWlsPC9zcGFuPjxzdHJvbmc+JHtudW0oci5hbm5leCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5TY2hsZWUvS2x1czwvc3Bhbj48c3Ryb25nPiR7bnVtKHJlc3QsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IGVkaXQtcmVjb3JkIiB0eXBlPSJidXR0b24iIGRhdGEtZWRpdC1tb250aD0iJHtyLm1vbnRofSI+QmVhcmJlaXRlbjwvYnV0dG9uPgogICAgICA8L2FydGljbGU+YDsKICAgIH0pLmpvaW4oIiIpOwogIH0KCiAgZnVuY3Rpb24gb3BlblJlY29yZE1vZGFsKG1vbnRoKXsKICAgIGNvbnN0IHI9cmVjb3JkRm9yTW9udGgobW9udGgpOwogICAgaWYoIXIpe3RvYXN0KCJNb25hdCBuaWNodCBnZWZ1bmRlbiIpO3JldHVybjt9CiAgICAkKCJyZWNvcmRNb2RhbFRpdGxlIikudGV4dENvbnRlbnQ9bW9udGhMYWJlbChyLm1vbnRoKTsKICAgICQoImVkaXRpbmdNb250aE9yaWdpbmFsIikudmFsdWU9ci5tb250aDsKICAgICQoInJlY29yZE1vbnRoIikudmFsdWU9ci5tb250aDsKICAgICQoInJlY29yZFRvdGFsIikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIudG90YWwpP3IudG90YWw6IiI7CiAgICAkKCJyZWNvcmRIZWF0UHVtcCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKT9yLmhlYXRQdW1wOiIiOwogICAgJCgicmVjb3JkQW5uZXgiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5hbm5leCk/ci5hbm5leDoiIjsKICAgICQoInJlY29yZFByaWNlQ3QiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5wcmljZUN0KT9yLnByaWNlQ3Q6IiI7CiAgICAkKCJyZWNvcmRCYXNlRmVlIikudmFsdWU9TnVtYmVyLmlzRmluaXRlKHIuYmFzZUZlZSk/ci5iYXNlRmVlOiIiOwogICAgJCgicmVjb3JkSGVhdEdlbmVyYXRlZCIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmhlYXRHZW5lcmF0ZWQpP3IuaGVhdEdlbmVyYXRlZDoiIjsKICAgICQoInJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmhlYXRpbmdFbGVjdHJpY2l0eSk/ci5oZWF0aW5nRWxlY3RyaWNpdHk6IiI7CiAgICAkKCJyZWNvcmREaHdFbGVjdHJpY2l0eSIpLnZhbHVlPU51bWJlci5pc0Zpbml0ZShyLmRod0VsZWN0cmljaXR5KT9yLmRod0VsZWN0cmljaXR5OiIiOwogICAgJCgicmVjb3JkSGVhdGluZ0hlYXQiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5oZWF0aW5nSGVhdCk/ci5oZWF0aW5nSGVhdDoiIjsKICAgICQoInJlY29yZERod0hlYXQiKS52YWx1ZT1OdW1iZXIuaXNGaW5pdGUoci5kaHdIZWF0KT9yLmRod0hlYXQ6IiI7CiAgICAkKCJyZWNvcmROb3RlIikudmFsdWU9ci5ub3RlfHwiIjsKICAgICQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iIjsKICAgICQoInJlY29yZFNvdXJjZUhpbnQiKS50ZXh0Q29udGVudD1yLm1ldGVyUmVhZGluZ0RhdGUKICAgICAgPyBgRGllc2VyIE1vbmF0IHd1cmRlIGF1cyBaw6RobGVyc3TDpG5kZW4gYmVyZWNobmV0LiBFaW5lIEtvcnJla3R1ciBoaWVyIMOkbmRlcnQgbnVyIGRlbiBNb25hdHN3ZXJ0OyBkaWUgZ2VzcGVpY2hlcnRlbiBaw6RobGVyc3TDpG5kZSBiaXMgJHtkYXRlTGFiZWwoci5tZXRlclJlYWRpbmdEYXRlKX0gYmxlaWJlbiBlcmhhbHRlbi5gCiAgICAgIDogci5oZWF0UHVtcFNvdXJjZT8uc3RhcnRzV2l0aCgibXl2YWlsbGFudCIpCiAgICAgICAgPyAiRGllIFfDpHJtZXB1bXBlbndlcnRlIHN0YW1tZW4gYXVzIGVpbmVyIG15VkFJTExBTlQtQ1NWLiBNYW51ZWxsZSDDhG5kZXJ1bmdlbiBrw7ZubmVuIGJlaSBlaW5lbSBzcMOkdGVyZW4gZXJuZXV0ZW4gQ1NWLUltcG9ydCB3aWVkZXIgZXJzZXR6dCB3ZXJkZW4uIgogICAgICAgIDogIk1hbnVlbGxlIEtvcnJla3R1ciBlaW5lcyBnZXNwZWljaGVydGVuIE1vbmF0c3dlcnRlcy4iOwogICAgdXBkYXRlRGVyaXZlZFByZXZpZXcoKTsKICAgICQoInJlY29yZE1vZGFsIikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7CiAgICBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSJoaWRkZW4iOwogIH0KICBmdW5jdGlvbiBjbG9zZVJlY29yZE1vZGFsKCl7ICQoInJlY29yZE1vZGFsIikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7IGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9IiI7IH0KICBmdW5jdGlvbiB1cGRhdGVEZXJpdmVkUHJldmlldygpewogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkVG90YWwiKS52YWx1ZSksaGVhdD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0UHVtcCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRBbm5leCIpLnZhbHVlKTsKICAgIGNvbnN0IGVsPSQoImRlcml2ZWRQcmV2aWV3Iik7CiAgICBpZihbdG90YWwsaGVhdCxhbm5leF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSl7CiAgICAgIGNvbnN0IHJlc3Q9dG90YWwtaGVhdC1hbm5leDsKICAgICAgZWwudGV4dENvbnRlbnQ9YFNjaGxlZS9LbHVzOiAke251bShyZXN0LDMpfSBrV2hgOwogICAgICBlbC5jbGFzc0xpc3QudG9nZ2xlKCJlcnJvciIscmVzdDwwKTsKICAgIH1lbHNlewogICAgICBlbC50ZXh0Q29udGVudD0iU2NobGVlL0tsdXM6IOKAkyAod2lyZCBhdXMgR2VzYW10IOKIkiBXw6RybWVwdW1wZSDiiJIgQWx0ZW50ZWlsIGJlcmVjaG5ldCkiOwogICAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCJlcnJvciIpOwogICAgfQogIH0KICBmdW5jdGlvbiBzYXZlRWRpdGVkUmVjb3JkKGV2ZW50KXsKICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICBjb25zdCBtb250aD0kKCJlZGl0aW5nTW9udGhPcmlnaW5hbCIpLnZhbHVlOwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgobW9udGgpOwogICAgaWYoIWV4aXN0aW5nKXskKCJyZWNvcmRWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkRlciBNb25hdCB3dXJkZSBuaWNodCBnZWZ1bmRlbi4iO3JldHVybjt9CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRUb3RhbCIpLnZhbHVlKSxoZWF0UHVtcD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRIZWF0UHVtcCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJyZWNvcmRBbm5leCIpLnZhbHVlKTsKICAgIGlmKFt0b3RhbCxoZWF0UHVtcCxhbm5leF0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKSYmdG90YWwtaGVhdFB1bXAtYW5uZXg8LS4wMSl7CiAgICAgICQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iVW5wbGF1c2liZWw6IFfDpHJtZXB1bXBlICsgQWx0ZW50ZWlsIHNpbmQgZ3LDtsOfZXIgYWxzIGRlciBHZXNhbXR2ZXJicmF1Y2guIjtyZXR1cm47CiAgICB9CiAgICBjb25zdCBoZWF0Q2hhbmdlZD1oZWF0UHVtcCE9PWV4aXN0aW5nLmhlYXRQdW1wOwogICAgY29uc3QgbWV0ZXJDaGFuZ2VkPXRvdGFsIT09ZXhpc3RpbmcudG90YWx8fGFubmV4IT09ZXhpc3RpbmcuYW5uZXg7CiAgICBjb25zdCByZWNvcmQ9ey4uLmV4aXN0aW5nLAogICAgICB0b3RhbCxoZWF0UHVtcCxhbm5leCwKICAgICAgcHJpY2VDdDpudWxsYWJsZU51bWJlcigkKCJyZWNvcmRQcmljZUN0IikudmFsdWUpLAogICAgICBiYXNlRmVlOm51bGxhYmxlTnVtYmVyKCQoInJlY29yZEJhc2VGZWUiKS52YWx1ZSksCiAgICAgIGhlYXRHZW5lcmF0ZWQ6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkSGVhdEdlbmVyYXRlZCIpLnZhbHVlKSwKICAgICAgaGVhdGluZ0VsZWN0cmljaXR5Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRpbmdFbGVjdHJpY2l0eSIpLnZhbHVlKSwKICAgICAgZGh3RWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIoJCgicmVjb3JkRGh3RWxlY3RyaWNpdHkiKS52YWx1ZSksCiAgICAgIGhlYXRpbmdIZWF0Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZEhlYXRpbmdIZWF0IikudmFsdWUpLAogICAgICBkaHdIZWF0Om51bGxhYmxlTnVtYmVyKCQoInJlY29yZERod0hlYXQiKS52YWx1ZSksCiAgICAgIG5vdGU6JCgicmVjb3JkTm90ZSIpLnZhbHVlLnRyaW0oKSwKICAgICAgaGVhdFB1bXBTb3VyY2U6aGVhdENoYW5nZWQ/Im1hbnVhbC1jb3JyZWN0aW9uIjpleGlzdGluZy5oZWF0UHVtcFNvdXJjZSwKICAgICAgaGVhdFB1bXBVcGRhdGVkQXQ6aGVhdENoYW5nZWQ/bmV3IERhdGUoKS50b0lTT1N0cmluZygpOmV4aXN0aW5nLmhlYXRQdW1wVXBkYXRlZEF0LAogICAgICBtZXRlclNvdXJjZTptZXRlckNoYW5nZWQmJmV4aXN0aW5nLm1ldGVyU291cmNlP2Ake2V4aXN0aW5nLm1ldGVyU291cmNlfSttYW51YWwtbW9udGgtY29ycmVjdGlvbmA6ZXhpc3RpbmcubWV0ZXJTb3VyY2UsCiAgICAgIHVwZGF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkKICAgIH07CiAgICBjb25zdCBuZXh0PXJlY29yZHMuZmlsdGVyKHI9PnIubW9udGghPT1tb250aCk7bmV4dC5wdXNoKHJlY29yZCk7CiAgICB0cnl7c2F2ZVJlY29yZHMobmV4dCx7cmVhc29uOmBNb25hdCAke21vbnRofSBtYW51ZWxsIGtvcnJpZ2llcnRgfSk7fQogICAgY2F0Y2goZXJyb3IpeyQoInJlY29yZFZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1lcnJvci5tZXNzYWdlO3JldHVybjt9CiAgICBjbG9zZVJlY29yZE1vZGFsKCk7cmVuZGVyQWxsKCk7dG9hc3QoYCR7bW9udGhMYWJlbChtb250aCl9IGdlw6RuZGVydGApOwogIH0KCiAgZnVuY3Rpb24gb3Blbk1ldGVyTW9kYWwoKXsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXthbGVydCgiRXMgZmVobHQgZWluIEF1c2dhbmdzesOkaGxlcnN0YW5kLiIpO3JldHVybjt9CiAgICAkKCJtZXRlckRhdGUiKS52YWx1ZT1uZXh0TW9udGhGaXJzdChwcmV2aW91cy5kYXRlKTsKICAgICQoIm1ldGVyVG90YWwiKS52YWx1ZT0iIjsKICAgICQoIm1ldGVyQW5uZXgiKS52YWx1ZT0iIjsKICAgICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSIiOwogICAgdXBkYXRlTWV0ZXJQcmV2aWV3KCk7CiAgICAkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7CiAgICBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSJoaWRkZW4iOwogICAgc2V0VGltZW91dCgoKT0+JCgibWV0ZXJUb3RhbCIpLmZvY3VzKCksNTApOwogIH0KICBmdW5jdGlvbiBjbG9zZU1ldGVyTW9kYWwoKXsgJCgibWV0ZXJNb2RhbCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOyBkb2N1bWVudC5ib2R5LnN0eWxlLm92ZXJmbG93PSIiOyB9CiAgZnVuY3Rpb24gdXBkYXRlTWV0ZXJQcmV2aWV3KCl7CiAgICBjb25zdCBwcmV2aW91cz1sYXRlc3RNZXRlclJlYWRpbmcoKTsKICAgIGlmKCFwcmV2aW91cylyZXR1cm47CiAgICBjb25zdCBkYXRlPSQoIm1ldGVyRGF0ZSIpLnZhbHVlfHxuZXh0TW9udGhGaXJzdChwcmV2aW91cy5kYXRlKTsKICAgIGNvbnN0IHRhcmdldE1vbnRoPXByZXZpb3VzLmRhdGUuc2xpY2UoMCw3KTsKICAgICQoIm1ldGVyUHJldmlvdXMiKS5pbm5lckhUTUw9YFZvcmhlcmlnZXIgU3RhbmQ6IDxzdHJvbmc+JHtkYXRlTGFiZWwocHJldmlvdXMuZGF0ZSl9PC9zdHJvbmc+IMK3IEdlc2FtdCA8c3Ryb25nPiR7bnVtKHByZXZpb3VzLnRvdGFsLDApfSBrV2g8L3N0cm9uZz4gwrcgQWx0ZW50ZWlsIDxzdHJvbmc+JHtudW0ocHJldmlvdXMuYW5uZXgsMCl9IGtXaDwvc3Ryb25nPmA7CiAgICAkKCJtZXRlclRhcmdldE1vbnRoIikudGV4dENvbnRlbnQ9YEJlcmVjaG5ldCB3aXJkIGRlciBWZXJicmF1Y2ggZsO8ciAke21vbnRoTGFiZWwodGFyZ2V0TW9udGgpfS5gOwogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJUb3RhbCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJtZXRlckFubmV4IikudmFsdWUpOwogICAgaWYoTnVtYmVyLmlzRmluaXRlKHRvdGFsKSYmTnVtYmVyLmlzRmluaXRlKGFubmV4KSl7CiAgICAgIGNvbnN0IHRvdGFsVXNlPXRvdGFsLXByZXZpb3VzLnRvdGFsLGFubmV4VXNlPWFubmV4LXByZXZpb3VzLmFubmV4OwogICAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aCh0YXJnZXRNb250aCksaGVhdD1leGlzdGluZz8uaGVhdFB1bXA7CiAgICAgIGNvbnN0IHJlc3Q9TnVtYmVyLmlzRmluaXRlKGhlYXQpP3RvdGFsVXNlLWFubmV4VXNlLWhlYXQ6bnVsbDsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuaW5uZXJIVE1MPWBHZXNhbXQ6IDxzdHJvbmc+JHtudW0odG90YWxVc2UsMSl9IGtXaDwvc3Ryb25nPiDCtyBBbHRlbnRlaWw6IDxzdHJvbmc+JHtudW0oYW5uZXhVc2UsMSl9IGtXaDwvc3Ryb25nPiR7TnVtYmVyLmlzRmluaXRlKGhlYXQpP2AgwrcgV8Okcm1lcHVtcGU6IDxzdHJvbmc+JHtudW0oaGVhdCwxKX0ga1doPC9zdHJvbmc+IMK3IFNjaGxlZS9LbHVzOiA8c3Ryb25nPiR7bnVtKHJlc3QsMSl9IGtXaDwvc3Ryb25nPmA6YCDCtyBXw6RybWVwdW1wZTogPHN0cm9uZz5DU1YgZmVobHQ8L3N0cm9uZz5gfWA7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLmNsYXNzTGlzdC50b2dnbGUoImVycm9yIix0b3RhbFVzZTwwfHxhbm5leFVzZTwwfHwoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PDApKTsKICAgIH1lbHNlewogICAgICAkKCJtZXRlclByZXZpZXciKS50ZXh0Q29udGVudD0iTW9uYXRzdmVyYnLDpHVjaGUgd2VyZGVuIGF1cyBkZXIgRGlmZmVyZW56IHp1bSB2b3JoZXJpZ2VuIFrDpGhsZXJzdGFuZCBiZXJlY2huZXQuIjsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuY2xhc3NMaXN0LnJlbW92ZSgiZXJyb3IiKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gc2F2ZU1ldGVyUmVhZGluZ0Zyb21Gb3JtKGV2ZW50KXsKICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7CiAgICBjb25zdCBwcmV2aW91cz1sYXRlc3RNZXRlclJlYWRpbmcoKTsKICAgIGlmKCFwcmV2aW91cylyZXR1cm47CiAgICBjb25zdCBkYXRlPSQoIm1ldGVyRGF0ZSIpLnZhbHVlLHRvdGFsPW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyVG90YWwiKS52YWx1ZSksYW5uZXg9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJBbm5leCIpLnZhbHVlKTsKICAgIGlmKCEvXlxkezR9LVxkezJ9LVxkezJ9JC8udGVzdChkYXRlKSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJCaXR0ZSBlaW4gZ8O8bHRpZ2VzIEFibGVzZWRhdHVtIHfDpGhsZW4uIjsgcmV0dXJuOyB9CiAgICBpZihkYXRlPD1wcmV2aW91cy5kYXRlKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9YERhcyBEYXR1bSBtdXNzIG5hY2ggZGVtIGxldHp0ZW4gU3RhbmQgdm9tICR7ZGF0ZUxhYmVsKHByZXZpb3VzLmRhdGUpfSBsaWVnZW4uYDsgcmV0dXJuOyB9CiAgICBpZighTnVtYmVyLmlzRmluaXRlKHRvdGFsKXx8IU51bWJlci5pc0Zpbml0ZShhbm5leCkpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iQml0dGUgYmVpZGUgWsOkaGxlcnN0w6RuZGUgZWludHJhZ2VuLiI7IHJldHVybjsgfQogICAgaWYodG90YWw8cHJldmlvdXMudG90YWwpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD0iRGVyIEdlc2FtdHrDpGhsZXJzdGFuZCBpc3Qga2xlaW5lciBhbHMgZGVyIHZvcmhlcmlnZSBTdGFuZC4gRWluIG5ldWVyIFrDpGhsZXIgbcO8c3N0ZSBzZXBhcmF0IGJlcsO8Y2tzaWNodGlndCB3ZXJkZW4uIjsgcmV0dXJuOyB9CiAgICBpZihhbm5leDxwcmV2aW91cy5hbm5leCl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBpc3Qga2xlaW5lciBhbHMgZGVyIHZvcmhlcmlnZSBTdGFuZC4iOyByZXR1cm47IH0KICAgIGNvbnN0IHRhcmdldE1vbnRoPXByZXZpb3VzLmRhdGUuc2xpY2UoMCw3KSx0b3RhbFVzZT10b3RhbC1wcmV2aW91cy50b3RhbCxhbm5leFVzZT1hbm5leC1wcmV2aW91cy5hbm5leDsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKXx8c2FuaXRpemVSZWNvcmQoe21vbnRoOnRhcmdldE1vbnRofSk7CiAgICBjb25zdCByZXN0PU51bWJlci5pc0Zpbml0ZShleGlzdGluZy5oZWF0UHVtcCk/dG90YWxVc2UtYW5uZXhVc2UtZXhpc3RpbmcuaGVhdFB1bXA6bnVsbDsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwtLjAxKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9YFVucGxhdXNpYmVsOiBOYWNoIEFienVnIHZvbiBXw6RybWVwdW1wZSB1bmQgQWx0ZW50ZWlsIGVyZ2lidCBTY2hsZWUvS2x1cyAke251bShyZXN0LDEpfSBrV2guYDsgcmV0dXJuOyB9CiAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgICBjb25zdCBuZXh0UmVjb3JkPXsuLi5leGlzdGluZyx0b3RhbDp0b3RhbFVzZSxhbm5leDphbm5leFVzZSxtZXRlclJlYWRpbmdEYXRlOmRhdGUscHJldmlvdXNNZXRlclJlYWRpbmdEYXRlOnByZXZpb3VzLmRhdGUsdG90YWxNZXRlclJlYWRpbmc6dG90YWwsYW5uZXhNZXRlclJlYWRpbmc6YW5uZXgsbWV0ZXJTb3VyY2U6ImN1bXVsYXRpdmUtcmVhZGluZ3MiLHVwZGF0ZWRBdDpzdGFtcH07CiAgICBjb25zdCBuZXh0PXJlY29yZHMuZmlsdGVyKHI9PnIubW9udGghPT10YXJnZXRNb250aCk7bmV4dC5wdXNoKG5leHRSZWNvcmQpOwogICAgdHJ5ewogICAgICBzYXZlUmVjb3JkcyhuZXh0LHtyZWFzb246YFrDpGhsZXJzdMOkbmRlICR7ZGF0ZUxhYmVsKGRhdGUpfSBnZXNwZWljaGVydGB9KTsKICAgICAgc2F2ZU1ldGVyUmVhZGluZ3MoWy4uLm1ldGVyUmVhZGluZ3Mse2RhdGUsdG90YWwsYW5uZXgsbm90ZTpgVmVyYnJhdWNoICR7dGFyZ2V0TW9udGh9YCx1cGRhdGVkQXQ6c3RhbXB9XSk7CiAgICB9Y2F0Y2goZXJyb3IpeyQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWVycm9yLm1lc3NhZ2U7cmV0dXJuO30KICAgIGNsb3NlTWV0ZXJNb2RhbCgpO3JlbmRlckFsbCgpOwogICAgdG9hc3QoTnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmhlYXRQdW1wKT9gJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0gdm9sbHN0w6RuZGlnIGJlcmVjaG5ldGA6YFrDpGhsZXJzdMOkbmRlIGdlc3BlaWNoZXJ0IMK3IFfDpHJtZXB1bXBlbi1DU1YgZmVobHQgbm9jaGApOwogIH0KICBmdW5jdGlvbiB1bmRvTGF0ZXN0TWV0ZXJSZWFkaW5nKCl7CiAgICBpZihtZXRlclJlYWRpbmdzLmxlbmd0aDw9MSlyZXR1cm47CiAgICBjb25zdCBsYXRlc3Q9bWV0ZXJSZWFkaW5ncy5hdCgtMSkscHJldmlvdXM9bWV0ZXJSZWFkaW5ncy5hdCgtMiksdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpOwogICAgaWYoIWNvbmZpcm0oYFrDpGhsZXJzdGFuZCB2b20gJHtkYXRlTGFiZWwobGF0ZXN0LmRhdGUpfSB6dXLDvGNrbmVobWVuPyBEaWUgZGFyYXVzIGJlcmVjaG5ldGVuIFdlcnRlIGbDvHIgJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0gd2VyZGVuIGVudGZlcm50LmApKXJldHVybjsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKTsKICAgIGlmKGV4aXN0aW5nKXsKICAgICAgY29uc3QgY2xlYXJlZD17Li4uZXhpc3RpbmcsdG90YWw6bnVsbCxhbm5leDpudWxsLG1ldGVyUmVhZGluZ0RhdGU6bnVsbCxwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6bnVsbCx0b3RhbE1ldGVyUmVhZGluZzpudWxsLGFubmV4TWV0ZXJSZWFkaW5nOm51bGwsbWV0ZXJTb3VyY2U6IiIsdXBkYXRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKX07CiAgICAgIGNvbnN0IG5leHQ9cmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aCE9PXRhcmdldE1vbnRoKTtuZXh0LnB1c2goY2xlYXJlZCk7c2F2ZVJlY29yZHMobmV4dCx7cmVhc29uOmBMZXR6dGVuIFrDpGhsZXJzdGFuZCAke2xhdGVzdC5kYXRlfSB6dXLDvGNrZ2Vub21tZW5gfSk7CiAgICB9CiAgICBzYXZlTWV0ZXJSZWFkaW5ncyhtZXRlclJlYWRpbmdzLnNsaWNlKDAsLTEpKTtyZW5kZXJBbGwoKTt0b2FzdCgiTGV0enRlbiBaw6RobGVyc3RhbmQgenVyw7xja2dlbm9tbWVuIik7CiAgfQoKICBmdW5jdGlvbiBhbmFseXNpc1llYXJSb3dzKHllYXIpeyByZXR1cm4gcmVjb3Jkcy5maWx0ZXIocj0+ci5tb250aC5zdGFydHNXaXRoKGAke3llYXJ9LWApKS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOyB9CiAgZnVuY3Rpb24gYW5udWFsU3Vtcyhyb3dzKXsKICAgIHJldHVybiByb3dzLnJlZHVjZSgoYSxyKT0+eyBpZihOdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpYS50b3RhbCs9ci50b3RhbDsgaWYoTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApKWEuaGVhdCs9ci5oZWF0UHVtcDsgaWYoTnVtYmVyLmlzRmluaXRlKHIuYW5uZXgpKWEuYW5uZXgrPXIuYW5uZXg7IGNvbnN0IHJlc3Q9ZGVyaXZlZChyKTsgaWYoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0Pj0wKWEucmVzdCs9cmVzdDsgY29uc3QgY29zdD1yZWNvcmRDb3N0KHIpOyBpZihOdW1iZXIuaXNGaW5pdGUoY29zdCkpYS5jb3N0Kz1jb3N0OyBpZihOdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpYS5jb3VudCsrOyByZXR1cm4gYTsgfSx7dG90YWw6MCxoZWF0OjAsYW5uZXg6MCxyZXN0OjAsY29zdDowLGNvdW50OjB9KTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyQW5hbHlzaXMoKXsKICAgIGNvbnN0IHlzPXllYXJzKCk7CiAgICBjb25zdCB5ZWFyU2VsZWN0PSQoImFuYWx5c2lzWWVhciIpOwogICAgY29uc3QgcHJpb3I9TnVtYmVyKHllYXJTZWxlY3QudmFsdWUpOyBjb25zdCBzZWxlY3RlZD15cy5pbmNsdWRlcyhwcmlvcik/cHJpb3I6KHlzWzBdfHxuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCkpOwogICAgeWVhclNlbGVjdC5pbm5lckhUTUw9KHlzLmxlbmd0aD95czpbbmV3IERhdGUoKS5nZXRGdWxsWWVhcigpXSkubWFwKHk9PmA8b3B0aW9uIHZhbHVlPSIke3l9Ij4ke3l9PC9vcHRpb24+YCkuam9pbigiIik7IHllYXJTZWxlY3QudmFsdWU9U3RyaW5nKHNlbGVjdGVkKTsKICAgIGNvbnN0IHJvd3M9YW5hbHlzaXNZZWFyUm93cyhzZWxlY3RlZCksIHN1bXM9YW5udWFsU3Vtcyhyb3dzKTsKICAgIGNvbnN0IHByZXZpb3VzWWVhcj15cy5pbmNsdWRlcyhzZWxlY3RlZC0xKT9zZWxlY3RlZC0xOm51bGw7IGNvbnN0IGNvbXBSb3dzPXByZXZpb3VzWWVhcj9hbmFseXNpc1llYXJSb3dzKHByZXZpb3VzWWVhcik6W107IGNvbnN0IGNvbXA9YW5udWFsU3Vtcyhjb21wUm93cyk7CiAgICBjb25zdCB0b3RhbERlbHRhPWNvbXAuY291bnQmJmNvbXAudG90YWw/KChzdW1zLnRvdGFsLWNvbXAudG90YWwpL2NvbXAudG90YWwqMTAwKTpudWxsOwogICAgY29uc3QgY29wUm93cz1yb3dzLm1hcChyZWNvcmRDb3ApLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpOyBjb25zdCBhbm51YWxDb3A9cm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApJiZOdW1iZXIuaXNGaW5pdGUoci5oZWF0R2VuZXJhdGVkKSl7YS5lKz1yLmhlYXRQdW1wO2EuaCs9ci5oZWF0R2VuZXJhdGVkO30gcmV0dXJuIGE7fSx7ZTowLGg6MH0pOwogICAgY29uc3QgbWV0cmljcz1bCiAgICAgIFsiR2VzYW10IixgJHtudW0oc3Vtcy50b3RhbCwwKX0ga1doYCxOdW1iZXIuaXNGaW5pdGUodG90YWxEZWx0YSk/YCR7cGN0KHRvdGFsRGVsdGEpfSB6dSAke3ByZXZpb3VzWWVhcn1gOmAke3N1bXMuY291bnR9IE1vbmF0ZWBdLAogICAgICBbIlfDpHJtZXB1bXBlIixgJHtudW0oc3Vtcy5oZWF0LDApfSBrV2hgLHN1bXMudG90YWw/YCR7bnVtKHN1bXMuaGVhdC9zdW1zLnRvdGFsKjEwMCwxKX0gJWA6IuKAkyJdLAogICAgICBbIkFsdGVudGVpbCIsYCR7bnVtKHN1bXMuYW5uZXgsMCl9IGtXaGAsc3Vtcy50b3RhbD9gJHtudW0oc3Vtcy5hbm5leC9zdW1zLnRvdGFsKjEwMCwxKX0gJWA6IuKAkyJdLAogICAgICBbIlNjaGxlZS9LbHVzIixgJHtudW0oc3Vtcy5yZXN0LDApfSBrV2hgLHN1bXMudG90YWw/YCR7bnVtKHN1bXMucmVzdC9zdW1zLnRvdGFsKjEwMCwxKX0gJWA6IuKAkyJdLAogICAgICBbIktvc3RlbiIsZXVybyhzdW1zLmNvc3QpLGFubnVhbENvcC5lPjA/YFdQLUFyYmVpdHN6YWhsICR7bnVtKGFubnVhbENvcC5oL2FubnVhbENvcC5lLDIpfWA6Im9obmUgdm9sbHN0w6RuZGlnZSBXUC1Xw6RybWVkYXRlbiJdCiAgICBdOwogICAgJCgiYW5hbHlzaXNNZXRyaWNzIikuaW5uZXJIVE1MPW1ldHJpY3MubWFwKChbbCx2LHNdKT0+YDxhcnRpY2xlPjxzcGFuPiR7bH08L3NwYW4+PHN0cm9uZz4ke3Z9PC9zdHJvbmc+PHNtYWxsPiR7c308L3NtYWxsPjwvYXJ0aWNsZT5gKS5qb2luKCIiKTsKICAgICQoImFuYWx5c2lzVGFibGUiKS5pbm5lckhUTUw9cm93cy5sZW5ndGg/cm93cy5tYXAocj0+YDx0cj48dGQ+JHtlc2NhcGVIdG1sKG1vbnRoTGFiZWwoci5tb250aCxmYWxzZSkpfTwvdGQ+PHRkPiR7bnVtKHIudG90YWwsMSl9PC90ZD48dGQ+JHtudW0oci5oZWF0UHVtcCwxKX08L3RkPjx0ZD4ke251bShyLmFubmV4LDEpfTwvdGQ+PHRkPiR7bnVtKGRlcml2ZWQociksMSl9PC90ZD48dGQ+JHtldXJvKHJlY29yZENvc3QocikpfTwvdGQ+PC90cj5gKS5qb2luKCIiKTonPHRyPjx0ZCBjb2xzcGFuPSI2Ij5LZWluZSBNb25hdHNkYXRlbiBmw7xyIGRpZXNlcyBKYWhyLjwvdGQ+PC90cj4nOwogICAgJCgiY29wUGFuZWwiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFjb3BSb3dzLmxlbmd0aCk7CiAgICBkcmF3QWxsb2NhdGlvbkNoYXJ0KHJvd3MpOyBkcmF3QWxsWWVhcnNUb3RhbENoYXJ0KHlzKTsgZHJhd0Nvc3RDaGFydChyb3dzKTsgaWYoY29wUm93cy5sZW5ndGgpZHJhd0NvcENoYXJ0KHJvd3MpOwogIH0KCiAgZnVuY3Rpb24gY2FudmFzU2V0dXAoY2FudmFzKXsKICAgIGlmKCFjYW52YXMpcmV0dXJuIG51bGw7CiAgICBjb25zdCByZWN0PWNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsgY29uc3QgZHByPU1hdGgubWluKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvfHwxLDIpOyBjb25zdCB3aWR0aD1NYXRoLm1heCgyODAsTWF0aC5yb3VuZChyZWN0LndpZHRofHw2MDApKTsgY29uc3QgaGVpZ2h0PU1hdGgubWF4KDE4MCxNYXRoLnJvdW5kKHJlY3QuaGVpZ2h0fHwyNjApKTsKICAgIGNhbnZhcy53aWR0aD1NYXRoLnJvdW5kKHdpZHRoKmRwcik7IGNhbnZhcy5oZWlnaHQ9TWF0aC5yb3VuZChoZWlnaHQqZHByKTsgY29uc3QgY3R4PWNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOyBjdHguc2V0VHJhbnNmb3JtKGRwciwwLDAsZHByLDAsMCk7IGN0eC5jbGVhclJlY3QoMCwwLHdpZHRoLGhlaWdodCk7IHJldHVybiB7Y3R4LHdpZHRoLGhlaWdodH07CiAgfQogIGZ1bmN0aW9uIGRyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LHRleHQ9IktlaW5lIERhdGVuIil7CiAgICBjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0OyBjdHguZm9udD0iMTNweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjsgY3R4LnRleHRBbGlnbj0iY2VudGVyIjsgY3R4LmZpbGxUZXh0KHRleHQsd2lkdGgvMixoZWlnaHQvMik7IGN0eC50ZXh0QWxpZ249ImxlZnQiOwogIH0KICBmdW5jdGlvbiBjaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LGxhYmVscyx7bGVmdD00OCxib3R0b209MzQsdG9wPTE1LHJpZ2h0PTEyfT17fSl7CiAgICBjb25zdCBwbG90Vz13aWR0aC1sZWZ0LXJpZ2h0LCBwbG90SD1oZWlnaHQtdG9wLWJvdHRvbTsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuZ3JpZDsgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDsgY3R4LmZvbnQ9IjEwcHggLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsU2Vnb2UgVUksc2Fucy1zZXJpZiI7IGN0eC5saW5lV2lkdGg9MTsKICAgIGZvcihsZXQgaT0wO2k8PTQ7aSsrKXsgY29uc3QgeT10b3ArcGxvdEgqaS80OyBjdHguYmVnaW5QYXRoKCk7Y3R4Lm1vdmVUbyhsZWZ0LHkpO2N0eC5saW5lVG8od2lkdGgtcmlnaHQseSk7Y3R4LnN0cm9rZSgpOyBjb25zdCB2YWw9bWF4KigxLWkvNCk7Y3R4LmZpbGxUZXh0KG51bSh2YWwsMCksNCx5KzMpOyB9CiAgICBpZihsYWJlbHM/Lmxlbmd0aCl7IGxhYmVscy5mb3JFYWNoKChsYWJlbCxpKT0+eyBjb25zdCB4PWxlZnQrKGxhYmVscy5sZW5ndGg9PT0xP3Bsb3RXLzI6cGxvdFcqaS8obGFiZWxzLmxlbmd0aC0xKSk7IGN0eC5maWxsVGV4dChsYWJlbCx4LTEwLGhlaWdodC0xMCk7IH0pOyB9CiAgICByZXR1cm4ge2xlZnQscmlnaHQsdG9wLGJvdHRvbSxwbG90VyxwbG90SH07CiAgfQogIGZ1bmN0aW9uIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCByb3dzPXNvcnRlZCgpLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpLnNsaWNlKC0xMik7IGlmKCFyb3dzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4ucm93cy5tYXAocj0+ci50b3RhbCkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgscm93cy5tYXAocj0+TU9OVEhTW051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTFdKSx7fSk7CiAgICBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLnRvdGFsO2N0eC5saW5lV2lkdGg9Mi41O2N0eC5iZWdpblBhdGgoKTtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PWZyYW1lLmxlZnQrKHJvd3MubGVuZ3RoPT09MT9mcmFtZS5wbG90Vy8yOmZyYW1lLnBsb3RXKmkvKHJvd3MubGVuZ3RoLTEpKTtjb25zdCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1yLnRvdGFsL21heCk7aT9jdHgubGluZVRvKHgseSk6Y3R4Lm1vdmVUbyh4LHkpO30pO2N0eC5zdHJva2UoKTsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLnRvdGFsO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9ZnJhbWUubGVmdCsocm93cy5sZW5ndGg9PT0xP2ZyYW1lLnBsb3RXLzI6ZnJhbWUucGxvdFcqaS8ocm93cy5sZW5ndGgtMSkpO2NvbnN0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXIudG90YWwvbWF4KTtjdHguYmVnaW5QYXRoKCk7Y3R4LmFyYyh4LHksMywwLE1hdGguUEkqMik7Y3R4LmZpbGwoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0FsbG9jYXRpb25DaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiYWxsb2NhdGlvbkNoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxpZD1yb3dzLmZpbHRlcihyPT5bci5oZWF0UHVtcCxyLmFubmV4LHIudG90YWxdLnNvbWUoTnVtYmVyLmlzRmluaXRlKSk7IGlmKCF2YWxpZC5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbGlkLm1hcChyPT5NYXRoLm1heCgwLE51bWJlcihyLnRvdGFsKXx8KChOdW1iZXIoci5oZWF0UHVtcCl8fDApKyhOdW1iZXIoci5hbm5leCl8fDApKyhNYXRoLm1heCgwLGRlcml2ZWQocikpfHwwKSkpKSkqMS4xfHwxOyBjb25zdCBsYWJlbHM9dmFsaWQubWFwKHI9Pk1PTlRIU1tOdW1iZXIoci5tb250aC5zbGljZSg1LDcpKS0xXSk7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsbGFiZWxzLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy92YWxpZC5sZW5ndGgsIGJhclc9TWF0aC5taW4oMzgsc2xvdCouNjIpOwogICAgdmFsaWQuZm9yRWFjaCgocixpKT0+eyBjb25zdCB4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzI7IGxldCB5PWZyYW1lLnRvcCtmcmFtZS5wbG90SDsgY29uc3QgcGFydHM9W1tNYXRoLm1heCgwLE51bWJlcihyLmhlYXRQdW1wKXx8MCksQ09MT1JTLmhlYXRdLFtNYXRoLm1heCgwLE51bWJlcihyLmFubmV4KXx8MCksQ09MT1JTLmFubmV4XSxbTWF0aC5tYXgoMCxkZXJpdmVkKHIpfHwwKSxDT0xPUlMucmVzdF1dOyBmb3IoY29uc3QgW3YsY29sb3JdIG9mIHBhcnRzKXtjb25zdCBoPWZyYW1lLnBsb3RIKnYvbWF4O3ktPWg7Y3R4LmZpbGxTdHlsZT1jb2xvcjtjdHguZmlsbFJlY3QoeCx5LGJhclcsaCk7fSB9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0FsbFllYXJzVG90YWxDaGFydCh5ZWFyTGlzdCl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoInRvdGFsQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7CiAgICBjb25zdCBhbGxSb3dzPXllYXJMaXN0LmZsYXRNYXAoeWVhcj0+YW5hbHlzaXNZZWFyUm93cyh5ZWFyKSkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSk7CiAgICBpZighYWxsUm93cy5sZW5ndGgpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fQogICAgY29uc3QgbWF4PU1hdGgubWF4KC4uLmFsbFJvd3MubWFwKHI9PnIudG90YWwpKSoxLjEyfHwxOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7CiAgICBjb25zdCBjYWxlbmRhclllYXI9bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpOyBjb25zdCBjdXJyZW50WWVhcj15ZWFyTGlzdC5pbmNsdWRlcyhjYWxlbmRhclllYXIpP2NhbGVuZGFyWWVhcjooeWVhckxpc3RbMF18fGNhbGVuZGFyWWVhcik7CiAgICBjb25zdCBwYWxldHRlPVsiIzljN2RmZiIsIiM0ZDljZmYiLCIjZmY5ZjQzIiwiI2YyZDE1ZiIsIiM1ZmM3YzIiLCIjZmY2YjZiIiwiI2M5OGNmZiIsIiM3ZmM4YTkiXTsKICAgIGNvbnN0IHBhc3RZZWFycz15ZWFyTGlzdC5maWx0ZXIoeT0+eSE9PWN1cnJlbnRZZWFyKS5zb3J0KChhLGIpPT5iLWEpOwogICAgY29uc3Qgc2VyaWVzPVsuLi5wYXN0WWVhcnMubWFwKCh5ZWFyLGluZGV4KT0+KHt5ZWFyLGNvbG9yOnBhbGV0dGVbaW5kZXglcGFsZXR0ZS5sZW5ndGhdLGRhc2hlZDp0cnVlfSkpLHt5ZWFyOmN1cnJlbnRZZWFyLGNvbG9yOkNPTE9SUy50b3RhbCxkYXNoZWQ6ZmFsc2V9XTsKICAgIGZvcihjb25zdCBpdGVtIG9mIHNlcmllcyl7CiAgICAgIGNvbnN0IGRhdGE9YW5hbHlzaXNZZWFyUm93cyhpdGVtLnllYXIpOyBjb25zdCBtYXA9bmV3IE1hcChkYXRhLmZpbHRlcihyPT5OdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpLm1hcChyPT5bTnVtYmVyKHIubW9udGguc2xpY2UoNSw3KSktMSxyLnRvdGFsXSkpOwogICAgICBjdHguc3Ryb2tlU3R5bGU9aXRlbS5jb2xvcjtjdHgubGluZVdpZHRoPWl0ZW0uZGFzaGVkPzIuMTozO2N0eC5zZXRMaW5lRGFzaChpdGVtLmRhc2hlZD9bNyw1XTpbXSk7Y3R4LmJlZ2luUGF0aCgpO2xldCBzdGFydGVkPWZhbHNlOwogICAgICBmb3IobGV0IG1vbnRoPTA7bW9udGg8MTI7bW9udGgrKyl7aWYoIW1hcC5oYXMobW9udGgpKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90Vyptb250aC8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1tYXAuZ2V0KG1vbnRoKS9tYXgpO2lmKCFzdGFydGVkKXtjdHgubW92ZVRvKHgseSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8oeCx5KTt9CiAgICAgIGN0eC5zdHJva2UoKTtjdHguc2V0TGluZURhc2goW10pOwogICAgICBpZighaXRlbS5kYXNoZWQpe2N0eC5maWxsU3R5bGU9aXRlbS5jb2xvcjtmb3IobGV0IG1vbnRoPTA7bW9udGg8MTI7bW9udGgrKyl7aWYoIW1hcC5oYXMobW9udGgpKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90Vyptb250aC8xMSx5PWZyYW1lLnRvcCtmcmFtZS5wbG90SCooMS1tYXAuZ2V0KG1vbnRoKS9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSwyLjgsMCxNYXRoLlBJKjIpO2N0eC5maWxsKCk7fX0KICAgIH0KICAgICQoInllYXJDb21wYXJpc29uTGVnZW5kIikuaW5uZXJIVE1MPXNlcmllcy5zbGljZSgpLnJldmVyc2UoKS5tYXAoaXRlbT0+YDxzcGFuIGNsYXNzPSJ5ZWFyLWxlZ2VuZC1pdGVtIj48aSBzdHlsZT0iYm9yZGVyLWNvbG9yOiR7aXRlbS5jb2xvcn07Ym9yZGVyLXRvcC1zdHlsZToke2l0ZW0uZGFzaGVkPyJkYXNoZWQiOiJzb2xpZCJ9Ij48L2k+JHtpdGVtLnllYXJ9JHtpdGVtLnllYXI9PT1jdXJyZW50WWVhcj8iIMK3IGFrdHVlbGwiOiIifTwvc3Bhbj5gKS5qb2luKCIiKTsKICB9CiAgZnVuY3Rpb24gZHJhd0Nvc3RDaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiY29zdENoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxzPXJvd3MubWFwKHI9PnJlY29yZENvc3QocikpOyBpZighdmFscy5zb21lKE51bWJlci5pc0Zpbml0ZSkpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0LCJLZWluZSBLb3N0ZW5kYXRlbiIpO3JldHVybjt9IGNvbnN0IG1heD1NYXRoLm1heCguLi52YWxzLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKSoxLjEyfHwxOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7IGNvbnN0IHNsb3Q9ZnJhbWUucGxvdFcvMTIsYmFyVz1NYXRoLm1pbigzOCxzbG90Ki42Mik7IHZhbHMuZm9yRWFjaCgodixpKT0+e2lmKCFOdW1iZXIuaXNGaW5pdGUodikpcmV0dXJuO2NvbnN0IGg9ZnJhbWUucGxvdEgqdi9tYXgseD1mcmFtZS5sZWZ0K3Nsb3QqaSsoc2xvdC1iYXJXKS8yLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RILWg7Y3R4LmZpbGxTdHlsZT1DT0xPUlMuY29zdDtjdHguZmlsbFJlY3QoeCx5LGJhclcsaCk7fSk7CiAgfQogIGZ1bmN0aW9uIGRyYXdDb3BDaGFydChyb3dzKXsKICAgIGNvbnN0IGM9Y2FudmFzU2V0dXAoJCgiY29wQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbHM9cm93cy5tYXAocmVjb3JkQ29wKTsgaWYoIXZhbHMuc29tZShOdW1iZXIuaXNGaW5pdGUpKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCk7cmV0dXJuO30gY29uc3QgbWF4PU1hdGgubWF4KDUsLi4udmFscy5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKSkqMS4wNTsgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxNT05USFMse30pOyBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLmhlYXQ7Y3R4LmxpbmVXaWR0aD0yLjQ7Y3R4LmJlZ2luUGF0aCgpO2xldCBzdGFydGVkPWZhbHNlO3ZhbHMuZm9yRWFjaCgodixpKT0+e2lmKCFOdW1iZXIuaXNGaW5pdGUodikpcmV0dXJuO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyppLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXYvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fSk7Y3R4LnN0cm9rZSgpOwogIH0KCiAgZnVuY3Rpb24gcmVuZGVyTWV0ZXJQYW5lbCgpewogICAgY29uc3QgbGF0ZXN0PWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIWxhdGVzdClyZXR1cm47CiAgICAkKCJtZXRlckxhdGVzdCIpLmlubmVySFRNTD1gPGFydGljbGU+PHNwYW4+U3RhbmQgdm9tPC9zcGFuPjxzdHJvbmc+JHtkYXRlTGFiZWwobGF0ZXN0LmRhdGUpfTwvc3Ryb25nPjxzbWFsbD5sZXR6dGUgQWJsZXN1bmc8L3NtYWxsPjwvYXJ0aWNsZT48YXJ0aWNsZT48c3Bhbj5HZXNhbXQ8L3NwYW4+PHN0cm9uZz4ke251bShsYXRlc3QudG90YWwsMCl9IGtXaDwvc3Ryb25nPjxzbWFsbD5aw6RobGVyc3RhbmQ8L3NtYWxsPjwvYXJ0aWNsZT48YXJ0aWNsZT48c3Bhbj5BbHRlbnRlaWw8L3NwYW4+PHN0cm9uZz4ke251bShsYXRlc3QuYW5uZXgsMCl9IGtXaDwvc3Ryb25nPjxzbWFsbD5aw6RobGVyc3RhbmQ8L3NtYWxsPjwvYXJ0aWNsZT5gOwogICAgJCgibWV0ZXJIaXN0b3J5IikuaW5uZXJIVE1MPW1ldGVyUmVhZGluZ3Muc2xpY2UoKS5yZXZlcnNlKCkuc2xpY2UoMCw4KS5tYXAoKHIsaSk9PmA8ZGl2IGNsYXNzPSJtZXRlci1oaXN0b3J5LXJvdyI+PHNwYW4+JHtkYXRlTGFiZWwoci5kYXRlKX08L3NwYW4+PHN0cm9uZz5HZXNhbXQgJHtudW0oci50b3RhbCwwKX08L3N0cm9uZz48c3Ryb25nPkFsdGVudGVpbCAke251bShyLmFubmV4LDApfTwvc3Ryb25nPiR7aT09PW1ldGVyUmVhZGluZ3MubGVuZ3RoLTE/JzxzbWFsbD5TdGFydHdlcnQ8L3NtYWxsPic6Jyd9PC9kaXY+YCkuam9pbigiIik7CiAgICAkKCJ1bmRvTGF0ZXN0TWV0ZXJCdG4iKS5kaXNhYmxlZD1tZXRlclJlYWRpbmdzLmxlbmd0aDw9MTsKICB9CiAgZnVuY3Rpb24gcmVuZGVyRGF0YSgpewogICAgY29uc3QgaXNzdWVzPVtdOyBsZXQgY29tcGxldGVDb3VudD0wOwogICAgZm9yKGNvbnN0IHIgb2YgcmVjb3Jkcyl7CiAgICAgIGNvbnN0IG1pc3Npbmc9W107IGlmKCFOdW1iZXIuaXNGaW5pdGUoci50b3RhbCkpbWlzc2luZy5wdXNoKCJHZXNhbXQiKTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSltaXNzaW5nLnB1c2goIlfDpHJtZXB1bXBlIik7IGlmKCFOdW1iZXIuaXNGaW5pdGUoci5hbm5leCkpbWlzc2luZy5wdXNoKCJBbHRlbnRlaWwiKTsgY29uc3QgcmVzdD1kZXJpdmVkKHIpOwogICAgICBpZihOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8MClpc3N1ZXMucHVzaCh7bGV2ZWw6ImVycm9yIixtb250aDpyLm1vbnRoLHRpdGxlOiJBdWZ0ZWlsdW5nIHVucGxhdXNpYmVsIixkZXRhaWw6YFNjaGxlZS9LbHVzIGVyZ2lidCAke251bShyZXN0LDEpfSBrV2guYH0pOwogICAgICBlbHNlIGlmKG1pc3NpbmcubGVuZ3RoKWlzc3Vlcy5wdXNoKHtsZXZlbDoid2FybmluZyIsbW9udGg6ci5tb250aCx0aXRsZToiTW9uYXQgdW52b2xsc3TDpG5kaWciLGRldGFpbDpgRmVobHQ6ICR7bWlzc2luZy5qb2luKCIsICIpfWB9KTsKICAgICAgZWxzZSBjb21wbGV0ZUNvdW50Kys7CiAgICB9CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0UmVjb3JkKCk7CiAgICBjb25zdCBxPVsKICAgICAgWyJNb25hdGUiLFN0cmluZyhyZWNvcmRzLmxlbmd0aCksImdlc3BlaWNoZXJ0Il0sCiAgICAgIFsiVm9sbHN0w6RuZGlnIixTdHJpbmcoY29tcGxldGVDb3VudCkscmVjb3Jkcy5sZW5ndGg/YCR7bnVtKGNvbXBsZXRlQ291bnQvcmVjb3Jkcy5sZW5ndGgqMTAwLDApfSAlYDoi4oCTIl0sCiAgICAgIFsiSGlud2Vpc2UiLFN0cmluZyhpc3N1ZXMubGVuZ3RoKSxpc3N1ZXMuc29tZShpPT5pLmxldmVsPT09ImVycm9yIik/Im1pbmQuIDEgRmVobGVyIjoicHLDvGZlbiJdLAogICAgICBbIkxldHp0ZXIgTW9uYXQiLGxhdGVzdD9tb250aExhYmVsKGxhdGVzdC5tb250aCxmYWxzZSk6IuKAkyIsImF1dG9tYXRpc2NoIGJlcmVjaG5ldCJdCiAgICBdOwogICAgJCgicXVhbGl0eU1ldHJpY3MiKS5pbm5lckhUTUw9cS5tYXAoKFtsLHYsc10pPT5gPGFydGljbGU+PHNwYW4+JHtsfTwvc3Bhbj48c3Ryb25nPiR7dn08L3N0cm9uZz48c21hbGw+JHtzfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgJCgicXVhbGl0eUlzc3VlcyIpLmlubmVySFRNTD1pc3N1ZXMubGVuZ3RoP2lzc3Vlcy5zbGljZSgpLnJldmVyc2UoKS5zbGljZSgwLDE2KS5tYXAoaT0+YDxhcnRpY2xlIGNsYXNzPSJpc3N1ZSAke2kubGV2ZWx9Ij48ZGl2PjxzdHJvbmc+JHtlc2NhcGVIdG1sKG1vbnRoTGFiZWwoaS5tb250aCkpfTogJHtlc2NhcGVIdG1sKGkudGl0bGUpfTwvc3Ryb25nPjxzbWFsbD4ke2VzY2FwZUh0bWwoaS5kZXRhaWwpfTwvc21hbGw+PC9kaXY+PC9hcnRpY2xlPmApLmpvaW4oIiIpOic8YXJ0aWNsZSBjbGFzcz0iaXNzdWUiPjxkaXY+PHN0cm9uZz5LZWluZSBBdWZmw6RsbGlna2VpdGVuPC9zdHJvbmc+PHNtYWxsPkFsbGUgZ2VzcGVpY2hlcnRlbiBNb25hdGUgc2luZCBwbGF1c2liZWwgdW5kIHZvbGxzdMOkbmRpZy48L3NtYWxsPjwvZGl2PjwvYXJ0aWNsZT4nOwogICAgcmVuZGVyTWV0ZXJQYW5lbCgpOwogICAgJCgib3N0cm9tQXBwS2V5SW5wdXQiKS52YWx1ZT1zZXR0aW5ncy5vc3Ryb21BcHBLZXl8fCIiOwogICAgJCgib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIpLmNoZWNrZWQ9c2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2ghPT1mYWxzZTsKICAgICQoInByZWZlcnJlZFdpbmRvd0hvdXJzSW5wdXQiKS52YWx1ZT1TdHJpbmcoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnN8fDMpOwogICAgJCgiZmFsbGJhY2tQcmljZUlucHV0IikudmFsdWU9TnVtYmVyKHNldHRpbmdzLmZhbGxiYWNrUHJpY2V8fDAuMzIpLnRvRml4ZWQoMyk7CiAgICAkKCJkZWZhdWx0QmFzZUZlZUlucHV0IikudmFsdWU9TnVtYmVyKHNldHRpbmdzLmRlZmF1bHRCYXNlRmVlfHwwKS50b0ZpeGVkKDIpOwogICAgY29uc3QgbGFzdEJhY2t1cD1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShMQVNUX0JBQ0tVUF9LRVkpOyAkKCJiYWNrdXBTdGF0dXMiKS50ZXh0Q29udGVudD1sYXN0QmFja3VwP2BMZXR6dGVzIEJhY2t1cDogJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtkYXRlU3R5bGU6Im1lZGl1bSIsdGltZVN0eWxlOiJzaG9ydCJ9KS5mb3JtYXQobmV3IERhdGUobGFzdEJhY2t1cCkpfWA6Ik5vY2gga2VpbiBCYWNrdXAgbWl0IEVsZGVob2YgNi4yIGVyc3RlbGx0LiI7CiAgICBjb25zdCBoaXN0b3J5TGFzdD1vc3Ryb21IaXN0b3J5TGFzdFN5bmMoKTsgaWYoaGlzdG9yeUxhc3QmJiFvc3Ryb21IaXN0b3J5QnVzeSlzZXRTdGF0dXMoIm9zdHJvbUhpc3RvcnlTdGF0dXMiLGBIaXN0b3Jpc2NoZSBPc3Ryb20tRGF0ZW4genVsZXR6dCAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2RhdGVTdHlsZToibWVkaXVtIix0aW1lU3R5bGU6InNob3J0In0pLmZvcm1hdChuZXcgRGF0ZShoaXN0b3J5TGFzdCkpfSBha3R1YWxpc2llcnQuYCwib2siKTsKICB9CgogIGZ1bmN0aW9uIGRvd25sb2FkQmxvYihjb250ZW50LGZpbGVuYW1lLHR5cGUpeyBjb25zdCBibG9iPW5ldyBCbG9iKFtjb250ZW50XSx7dHlwZX0pOyBjb25zdCB1cmw9VVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsgY29uc3QgYT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJhIik7IGEuaHJlZj11cmw7YS5kb3dubG9hZD1maWxlbmFtZTtkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGEpO2EuY2xpY2soKTthLnJlbW92ZSgpO3NldFRpbWVvdXQoKCk9PlVSTC5yZXZva2VPYmplY3RVUkwodXJsKSwxMDAwKTsgfQogIGZ1bmN0aW9uIGV4cG9ydEJhY2t1cCgpewogICAgY29uc3Qgbm93PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIGNvbnN0IHJlbGV2YW50U2V0dGluZ3M9e2ZhbGxiYWNrUHJpY2U6c2V0dGluZ3MuZmFsbGJhY2tQcmljZSxkZWZhdWx0QmFzZUZlZTpzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZSxvc3Ryb21BcHBLZXk6c2V0dGluZ3Mub3N0cm9tQXBwS2V5LG9zdHJvbUF1dG9SZWZyZXNoOnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoLHByZWZlcnJlZFdpbmRvd0hvdXJzOnNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzfTsKICAgIGNvbnN0IHBheWxvYWQ9e3ZlcnNpb246IjYuMi4wIixhcHA6IkVsZGVob2YiLHB1cnBvc2U6IlByaXZhdGVzIGxva2FsZXMgQmFja3VwIOKAkyBuaWNodCDDtmZmZW50bGljaCBob2NobGFkZW4iLGV4cG9ydGVkQXQ6bm93LHNldHRpbmdzOnJlbGV2YW50U2V0dGluZ3MscmVjb3Jkcyx2YWlsbGFudE1vbnRocyxtZXRlclJlYWRpbmdzfTsKICAgIGRvd25sb2FkQmxvYihKU09OLnN0cmluZ2lmeShwYXlsb2FkLG51bGwsMiksYEVsZGVob2ZfUFJJVkFURV9CYWNrdXBfJHtkYXRlU3RhbXAoKX0uanNvbmAsImFwcGxpY2F0aW9uL2pzb24iKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTEFTVF9CQUNLVVBfS0VZLG5vdyk7IHJlbmRlckRhdGEoKTsgdG9hc3QoIlByaXZhdGVzIEJhY2t1cCBlcnN0ZWxsdCIpOwogIH0KICBmdW5jdGlvbiBleHBvcnRDc3YoKXsKICAgIGNvbnN0IHJvd3M9W1siTW9uYXQiLCJXw6RybWVwdW1wZSBrV2giLCJFcnpldWd0ZSBXw6RybWUga1doIiwiQXJiZWl0c3phaGwiLCJBbHRlbnRlaWwga1doIiwiU2NobGVlL0tsdXMga1doIiwiR2VzYW10IGtXaCIsIkdlc2FtdC1aw6RobGVyc3RhbmQga1doIiwiQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2giLCJBYmxlc2VkYXR1bSIsIlByZWlzIGN0L2tXaCIsIkZpeGtvc3RlbiBFVVIiLCJLb3N0ZW4gRVVSIiwiTm90aXoiXV07CiAgICBmb3IoY29uc3QgciBvZiBzb3J0ZWQoKSlyb3dzLnB1c2goW3IubW9udGgsci5oZWF0UHVtcD8/IiIsci5oZWF0R2VuZXJhdGVkPz8iIixyZWNvcmRDb3Aocik/PyIiLHIuYW5uZXg/PyIiLGRlcml2ZWQocik/PyIiLHIudG90YWw/PyIiLHIudG90YWxNZXRlclJlYWRpbmc/PyIiLHIuYW5uZXhNZXRlclJlYWRpbmc/PyIiLHIubWV0ZXJSZWFkaW5nRGF0ZT8/IiIsci5wcmljZUN0Pz8iIixyLmJhc2VGZWU/PyIiLHJlY29yZENvc3Qocik/PyIiLHIubm90ZXx8IiJdKTsKICAgIGRvd25sb2FkQmxvYigiXHVGRUZGIityb3dzLm1hcChyb3c9PnJvdy5tYXAoY3N2Q2VsbCkuam9pbigiOyIpKS5qb2luKCJcbiIpLGBFbGRlaG9mX1ZlcmJyYXVjaF8ke2RhdGVTdGFtcCgpfS5jc3ZgLCJ0ZXh0L2NzdjtjaGFyc2V0PXV0Zi04Iik7IHRvYXN0KCJDU1YgZXJzdGVsbHQiKTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gaW1wb3J0QmFja3VwKGZpbGUpewogICAgdHJ5ewogICAgICBjb25zdCBwYXlsb2FkPUpTT04ucGFyc2UoYXdhaXQgZmlsZS50ZXh0KCkpOyBjb25zdCBpbmNvbWluZz1BcnJheS5pc0FycmF5KHBheWxvYWQpP3BheWxvYWQ6KEFycmF5LmlzQXJyYXkocGF5bG9hZC5yZWNvcmRzKT9wYXlsb2FkLnJlY29yZHM6cGF5bG9hZC5kYXRhKTsgaWYoIUFycmF5LmlzQXJyYXkoaW5jb21pbmcpKXRocm93IG5ldyBFcnJvcigiS2VpbmUgTW9uYXRzZGF0ZW4gZ2VmdW5kZW4uIik7CiAgICAgIGNvbnN0IGNsZWFuZWQ9c2FuaXRpemVSZWNvcmRzKGluY29taW5nKTsgaWYoIWNsZWFuZWQubGVuZ3RoJiYhY29uZmlybSgiRGFzIEJhY2t1cCBlbnRow6RsdCBrZWluZSBNb25hdHN3ZXJ0ZS4gTGVlcmVuIEJlc3RhbmQgd2lya2xpY2ggaW1wb3J0aWVyZW4/IikpcmV0dXJuOwogICAgICBpZighY29uZmlybShgJHtjbGVhbmVkLmxlbmd0aH0gTW9uYXRzd2VydGUgYXVzIGRlbSBCYWNrdXAgw7xiZXJuZWhtZW4/IERlciBha3R1ZWxsZSBTdGFuZCB3aXJkIHZvcmhlciBsb2thbCBnZXNpY2hlcnQuYCkpcmV0dXJuOwogICAgICBzYXZlUmVjb3JkcyhjbGVhbmVkLHtyZWFzb246IkJhY2t1cCBpbXBvcnRpZXJ0IixhbGxvd0VtcHR5OnRydWV9KTsKICAgICAgaWYocGF5bG9hZC5zZXR0aW5ncyYmdHlwZW9mIHBheWxvYWQuc2V0dGluZ3M9PT0ib2JqZWN0Iil7CiAgICAgICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLnBheWxvYWQuc2V0dGluZ3N9OwogICAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5wcmljZSkpJiYhTnVtYmVyLmlzRmluaXRlKE51bWJlcihwYXlsb2FkLnNldHRpbmdzLmZhbGxiYWNrUHJpY2UpKSlzZXR0aW5ncy5mYWxsYmFja1ByaWNlPU51bWJlcihwYXlsb2FkLnNldHRpbmdzLnByaWNlKTsKICAgICAgICBzYXZlU2V0dGluZ3MoKTsKICAgICAgfQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQudmFpbGxhbnRNb250aHMpKXsgdmFpbGxhbnRNb250aHM9cGF5bG9hZC52YWlsbGFudE1vbnRoczsgc2F2ZVZhaWxsYW50TW9udGhzKCk7IH0KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLm1ldGVyUmVhZGluZ3MpKXtzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3MpO31lbHNle21ldGVyUmVhZGluZ3M9bG9hZE1ldGVyUmVhZGluZ3MoKTtlbnN1cmVNZXRlckJhc2VsaW5lKCk7fQogICAgICByZW5kZXJBbGwoKTsgdG9hc3QoIkJhY2t1cCBpbXBvcnRpZXJ0Iik7CiAgICB9Y2F0Y2goZXJyb3IpeyBhbGVydChgQmFja3VwIGtvbm50ZSBuaWNodCBpbXBvcnRpZXJ0IHdlcmRlbjogJHtlcnJvci5tZXNzYWdlfWApOyB9CiAgICBmaW5hbGx5eyAkKCJpbXBvcnRCYWNrdXBJbnB1dCIpLnZhbHVlPSIiOyB9CiAgfQoKCiAgLyogRWxkZWhvZiA2LjAuMSDigJMgc2NobGFua2VyIGxva2FsZXIgbXlWQUlMTEFOVC1DU1YtSW1wb3J0ICovCiAgZnVuY3Rpb24gdmFpbGxhbnRDc3ZOdW1iZXIodmFsdWUpewogICAgY29uc3QgdGV4dD1TdHJpbmcodmFsdWU/PyIiKS50cmltKCk7CiAgICBpZighdGV4dClyZXR1cm4gbnVsbDsKICAgIGNvbnN0IG5vcm1hbGl6ZWQ9dGV4dC5pbmNsdWRlcygiLCIpJiZ0ZXh0LmluY2x1ZGVzKCIuIikKICAgICAgP3RleHQubGFzdEluZGV4T2YoIiwiKT50ZXh0Lmxhc3RJbmRleE9mKCIuIikKICAgICAgICA/dGV4dC5yZXBsYWNlKC9cLi9nLCIiKS5yZXBsYWNlKCIsIiwiLiIpCiAgICAgICAgOnRleHQucmVwbGFjZSgvLC9nLCIiKQogICAgICA6dGV4dC5yZXBsYWNlKCIsIiwiLiIpOwogICAgY29uc3QgbnVtYmVyPU51bWJlcihub3JtYWxpemVkKTsKICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobnVtYmVyKT9udW1iZXI6bnVsbDsKICB9CiAgZnVuY3Rpb24gdmFpbGxhbnRDc3ZEYXRlUGFydHModmFsdWUpewogICAgY29uc3QgbWF0Y2g9L14oXGR7NH0pLShcZHsyfSktKFxkezJ9KSg/OlsgVF0oXGR7Mn0pOihcZHsyfSk6KFxkezJ9KSk/JC8uZXhlYyhTdHJpbmcodmFsdWV8fCIiKS50cmltKCkpOwogICAgaWYoIW1hdGNoKXJldHVybiBudWxsOwogICAgY29uc3QgeWVhcj1OdW1iZXIobWF0Y2hbMV0pLG1vbnRoPU51bWJlcihtYXRjaFsyXSksZGF5PU51bWJlcihtYXRjaFszXSk7CiAgICBjb25zdCBkYXRlPW5ldyBEYXRlKERhdGUuVVRDKHllYXIsbW9udGgtMSxkYXkpKTsKICAgIGlmKGRhdGUuZ2V0VVRDRnVsbFllYXIoKSE9PXllYXJ8fGRhdGUuZ2V0VVRDTW9udGgoKSE9PW1vbnRoLTF8fGRhdGUuZ2V0VVRDRGF0ZSgpIT09ZGF5KXJldHVybiBudWxsOwogICAgcmV0dXJuIHt5ZWFyLG1vbnRoLGRheSxkYXRlS2V5OmAke21hdGNoWzFdfS0ke21hdGNoWzJdfS0ke21hdGNoWzNdfWAsbW9udGhLZXk6YCR7bWF0Y2hbMV19LSR7bWF0Y2hbMl19YCxkYXRlVGltZTpTdHJpbmcodmFsdWV8fCIiKS50cmltKCl9OwogIH0KICBmdW5jdGlvbiBkZXRlY3RWYWlsbGFudENzdlR5cGUoaGVhZGVycyl7CiAgICBjb25zdCBmaWVsZHM9bmV3IFNldChoZWFkZXJzKSxoYXM9bmFtZT0+ZmllbGRzLmhhcyhuYW1lKTsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikmJmhhcygiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikmJmhhcygiSGVhdEdlbmVyYXRlZDpEb21lc3RpY0hvdFdhdGVyIikpcmV0dXJuICJhcm90aGVybS1lbmVyZ3kiOwogICAgaWYoaGFzKCJEYXRlVGltZSIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikmJmhhcygiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikmJiFoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikpcmV0dXJuICJ1bml0b3dlci1lbmVyZ3kiOwogICAgcmV0dXJuICJ1bmtub3duIjsKICB9CiAgZnVuY3Rpb24gcGFyc2VWYWlsbGFudENzdlRleHQodGV4dCxpbmRleD0wKXsKICAgIGNvbnN0IG5vcm1hbGl6ZWQ9U3RyaW5nKHRleHR8fCIiKS5yZXBsYWNlKC9eXHVGRUZGLywiIikucmVwbGFjZSgvXHJcbj8vZywiXG4iKTsKICAgIGNvbnN0IGRhdGFMaW5lcz1ub3JtYWxpemVkLnNwbGl0KCJcbiIpLmZpbHRlcihsaW5lPT57Y29uc3QgdD1saW5lLnRyaW0oKTtyZXR1cm4gdCYmIXQuc3RhcnRzV2l0aCgiIyIpO30pOwogICAgaWYoIWRhdGFMaW5lcy5sZW5ndGgpcmV0dXJuIHtpbmRleCx0eXBlOiJ1bmtub3duIixyb3dzOltdLGludmFsaWRSb3dzOjB9OwogICAgY29uc3QgZGVsaW1pdGVyPWRhdGFMaW5lc1swXS5pbmNsdWRlcygiOyIpPyI7IjoiLCI7CiAgICBjb25zdCBoZWFkZXJzPWRhdGFMaW5lc1swXS5zcGxpdChkZWxpbWl0ZXIpLm1hcCh2PT52LnRyaW0oKSk7CiAgICBjb25zdCB0eXBlPWRldGVjdFZhaWxsYW50Q3N2VHlwZShoZWFkZXJzKSxyb3dzPVtdO2xldCBpbnZhbGlkUm93cz0wOwogICAgZm9yKGNvbnN0IGxpbmUgb2YgZGF0YUxpbmVzLnNsaWNlKDEpKXsKICAgICAgaWYoIWxpbmUudHJpbSgpKWNvbnRpbnVlOwogICAgICBjb25zdCB2YWx1ZXM9bGluZS5zcGxpdChkZWxpbWl0ZXIpOwogICAgICBjb25zdCByYXc9T2JqZWN0LmZyb21FbnRyaWVzKGhlYWRlcnMubWFwKChoZWFkZXIsY29sdW1uKT0+W2hlYWRlcix2YWx1ZXNbY29sdW1uXT8/IiJdKSk7CiAgICAgIGNvbnN0IGRhdGU9dmFpbGxhbnRDc3ZEYXRlUGFydHMocmF3LkRhdGVUaW1lKTtpZighZGF0ZSl7aW52YWxpZFJvd3MrKztjb250aW51ZTt9CiAgICAgIGNvbnN0IHBhcnNlZD17Li4uZGF0ZSx2YWx1ZXM6e319OwogICAgICBmb3IoY29uc3QgaGVhZGVyIG9mIGhlYWRlcnMpe2lmKGhlYWRlciE9PSJEYXRlVGltZSIpcGFyc2VkLnZhbHVlc1toZWFkZXJdPXZhaWxsYW50Q3N2TnVtYmVyKHJhd1toZWFkZXJdKTt9CiAgICAgIHJvd3MucHVzaChwYXJzZWQpOwogICAgfQogICAgcmV0dXJuIHtpbmRleCx0eXBlLGhlYWRlcnMscm93cyxpbnZhbGlkUm93c307CiAgfQogIGZ1bmN0aW9uIHNhbWVWYWlsbGFudFZhbHVlKGEsYix0b2xlcmFuY2U9LjA1KXsKICAgIGlmKGE9PW51bGx8fGI9PW51bGwpcmV0dXJuIGE9PW51bGwmJmI9PW51bGw7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcihhKSkmJk51bWJlci5pc0Zpbml0ZShOdW1iZXIoYikpP01hdGguYWJzKE51bWJlcihhKS1OdW1iZXIoYikpPD10b2xlcmFuY2U6U3RyaW5nKGEpPT09U3RyaW5nKGIpOwogIH0KICBmdW5jdGlvbiBidWlsZFZhaWxsYW50SW1wb3J0UHJldmlldyhwYXJzZWRGaWxlcyl7CiAgICBjb25zdCBlbmVyZ3lUeXBlcz1bImFyb3RoZXJtLWVuZXJneSIsInVuaXRvd2VyLWVuZXJneSJdOwogICAgY29uc3QgZGFpbHk9eyJhcm90aGVybS1lbmVyZ3kiOm5ldyBNYXAoKSwidW5pdG93ZXItZW5lcmd5IjpuZXcgTWFwKCl9OwogICAgY29uc3QgY29uZmxpY3RNb250aHM9bmV3IFNldCgpO2xldCBkdXBsaWNhdGVSb3dzPTA7CiAgICBmb3IoY29uc3QgZmlsZSBvZiBwYXJzZWRGaWxlcy5maWx0ZXIoZj0+ZW5lcmd5VHlwZXMuaW5jbHVkZXMoZi50eXBlKSkpewogICAgICBjb25zdCB0YXJnZXQ9ZGFpbHlbZmlsZS50eXBlXTsKICAgICAgZm9yKGNvbnN0IHJvdyBvZiBmaWxlLnJvd3MpewogICAgICAgIGNvbnN0IGV4aXN0aW5nPXRhcmdldC5nZXQocm93LmRhdGVLZXkpOwogICAgICAgIGlmKCFleGlzdGluZyl7dGFyZ2V0LnNldChyb3cuZGF0ZUtleSxyb3cpO2NvbnRpbnVlO30KICAgICAgICBjb25zdCBtZXRyaWNzPW5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKGV4aXN0aW5nLnZhbHVlc3x8e30pLC4uLk9iamVjdC5rZXlzKHJvdy52YWx1ZXN8fHt9KV0pOwogICAgICAgIGNvbnN0IGRpZmZlcnM9Wy4uLm1ldHJpY3NdLnNvbWUobWV0cmljPT4hc2FtZVZhaWxsYW50VmFsdWUoZXhpc3RpbmcudmFsdWVzPy5bbWV0cmljXSxyb3cudmFsdWVzPy5bbWV0cmljXSkpOwogICAgICAgIGlmKGRpZmZlcnMpY29uZmxpY3RNb250aHMuYWRkKHJvdy5tb250aEtleSk7ZWxzZSBkdXBsaWNhdGVSb3dzKys7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGFsbERhdGVzPVsuLi5uZXcgU2V0KFsuLi5kYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0ua2V5cygpLC4uLmRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXS5rZXlzKCldKV07CiAgICBjb25zdCBtb250aEtleXM9Wy4uLm5ldyBTZXQoYWxsRGF0ZXMubWFwKGQ9PmQuc2xpY2UoMCw3KSkpXS5zb3J0KCk7CiAgICBjb25zdCBzdW09KG1hcCxkYXRlcyxtZXRyaWMpPT5kYXRlcy5yZWR1Y2UoKHMsa2V5KT0+e2NvbnN0IHY9bWFwLmdldChrZXkpPy52YWx1ZXM/LlttZXRyaWNdO3JldHVybiBzKyhOdW1iZXIuaXNGaW5pdGUodik/djowKTt9LDApOwogICAgY29uc3QgZnVsbD0oZGF0ZXMseSxtKT0+e2NvbnN0IGV4cGVjdGVkPW5ldyBEYXRlKHksbSwwKS5nZXREYXRlKCksdT1bLi4ubmV3IFNldChkYXRlcyldLnNvcnQoKTtyZXR1cm4gdS5sZW5ndGg9PT1leHBlY3RlZCYmdVswXT09PWAke3l9LSR7U3RyaW5nKG0pLnBhZFN0YXJ0KDIsIjAiKX0tMDFgJiZ1LmF0KC0xKT09PWAke3l9LSR7U3RyaW5nKG0pLnBhZFN0YXJ0KDIsIjAiKX0tJHtTdHJpbmcoZXhwZWN0ZWQpLnBhZFN0YXJ0KDIsIjAiKX1gO307CiAgICBjb25zdCBjdXJyZW50PWN1cnJlbnRNb250aEtleSgpOwogICAgY29uc3QgbW9udGhzPW1vbnRoS2V5cy5tYXAobW9udGg9PnsKICAgICAgY29uc3QgeT1OdW1iZXIobW9udGguc2xpY2UoMCw0KSksbT1OdW1iZXIobW9udGguc2xpY2UoNSw3KSk7CiAgICAgIGNvbnN0IGFybz1bLi4uZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLmtleXMoKV0uZmlsdGVyKGs9Pmsuc3RhcnRzV2l0aChgJHttb250aH0tYCkpLnNvcnQoKTsKICAgICAgY29uc3QgdW5pPVsuLi5kYWlseVsidW5pdG93ZXItZW5lcmd5Il0ua2V5cygpXS5maWx0ZXIoaz0+ay5zdGFydHNXaXRoKGAke21vbnRofS1gKSkuc29ydCgpOwogICAgICBjb25zdCB1bmlvbj1bLi4ubmV3IFNldChbLi4uYXJvLC4uLnVuaV0pXS5zb3J0KCk7CiAgICAgIGNvbnN0IGNvbXBsZXRlPWZ1bGwoYXJvLHksbSkmJmZ1bGwodW5pLHksbSk7CiAgICAgIGNvbnN0IGhlYXRpbmdFbGVjdHJpY2l0eT0oc3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikrc3VtKGRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXSx1bmksIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikpLzEwMDA7CiAgICAgIGNvbnN0IGRod0VsZWN0cmljaXR5PXN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpLzEwMDA7CiAgICAgIGNvbnN0IGhlYXRpbmdIZWF0PShzdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikrc3VtKGRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXSx1bmksIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpKS8xMDAwOwogICAgICBjb25zdCBkaHdIZWF0PXN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJIZWF0R2VuZXJhdGVkOkRvbWVzdGljSG90V2F0ZXIiKS8xMDAwOwogICAgICBjb25zdCBlbGVjdHJpY2l0eUtXaD1oZWF0aW5nRWxlY3RyaWNpdHkrZGh3RWxlY3RyaWNpdHksaGVhdEdlbmVyYXRlZEtXaD1oZWF0aW5nSGVhdCtkaHdIZWF0OwogICAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aChtb250aCk7CiAgICAgIGNvbnN0IG5lZ2F0aXZlUmVzdD1Cb29sZWFuKGV4aXN0aW5nJiZOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcuYW5uZXgpJiZleGlzdGluZy50b3RhbC1lbGVjdHJpY2l0eUtXaC1leGlzdGluZy5hbm5leDwtLjAxKTsKICAgICAgY29uc3QgaGFzQ29uZmxpY3Q9Y29uZmxpY3RNb250aHMuaGFzKG1vbnRoKSxoYXNCb3RoPWFyby5sZW5ndGg+MCYmdW5pLmxlbmd0aD4wLGlzQ3VycmVudD1tb250aD09PWN1cnJlbnQsaXNGdXR1cmU9bW9udGg+Y3VycmVudDsKICAgICAgY29uc3QgYmxvY2tlZD0haGFzQm90aHx8aGFzQ29uZmxpY3R8fG5lZ2F0aXZlUmVzdHx8aXNGdXR1cmV8fCghY29tcGxldGUmJiFpc0N1cnJlbnQpOwogICAgICByZXR1cm4ge21vbnRoLGVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2gsaGVhdGluZ0VsZWN0cmljaXR5S1doOmhlYXRpbmdFbGVjdHJpY2l0eSxkaHdFbGVjdHJpY2l0eUtXaDpkaHdFbGVjdHJpY2l0eSxoZWF0aW5nSGVhdEtXaDpoZWF0aW5nSGVhdCxkaHdIZWF0S1doOmRod0hlYXQsY29tcGxldGUsY292ZXJhZ2VTdGFydDp1bmlvblswXXx8bnVsbCxjb3ZlcmFnZUVuZDp1bmlvbi5hdCgtMSl8fG51bGwsYmxvY2tlZCxoYXNCb3RoLGhhc0NvbmZsaWN0LG5lZ2F0aXZlUmVzdCxpc0N1cnJlbnR9OwogICAgfSk7CiAgICByZXR1cm4ge21vbnRocyxkdXBsaWNhdGVSb3dzLHJlY29nbml6ZWQ6cGFyc2VkRmlsZXMuZmlsdGVyKGY9PmYudHlwZSE9PSJ1bmtub3duIikubGVuZ3RoLHVua25vd246cGFyc2VkRmlsZXMuZmlsdGVyKGY9PmYudHlwZT09PSJ1bmtub3duIikubGVuZ3RoLGludmFsaWRSb3dzOnBhcnNlZEZpbGVzLnJlZHVjZSgocyxmKT0+cytmLmludmFsaWRSb3dzLDApfTsKICB9CiAgZnVuY3Rpb24gbWVyZ2VWYWlsbGFudEltcG9ydChtb250aHMpewogICAgY29uc3QgcmVjb3JkTWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgY29uc3QgdmFpbGxhbnRNYXA9bmV3IE1hcCgodmFpbGxhbnRNb250aHN8fFtdKS5tYXAodj0+W3YubW9udGgsey4uLnZ9XSkpOwogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO2xldCBpbXBvcnRlZD0wLGNyZWF0ZWQ9MCxwYXJ0aWFsPTA7CiAgICBmb3IoY29uc3QgbW9udGggb2YgbW9udGhzLmZpbHRlcihtPT4hbS5ibG9ja2VkKSl7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZE1hcC5nZXQobW9udGgubW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6bW9udGgubW9udGh9KTsKICAgICAgY29uc3Qgd2FzTmV3PSFyZWNvcmRNYXAuaGFzKG1vbnRoLm1vbnRoKTsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXA9bW9udGguZWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRHZW5lcmF0ZWQ9bW9udGguaGVhdEdlbmVyYXRlZEtXaDsKICAgICAgZXhpc3RpbmcuaGVhdGluZ0VsZWN0cmljaXR5PW1vbnRoLmhlYXRpbmdFbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuZGh3RWxlY3RyaWNpdHk9bW9udGguZGh3RWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRpbmdIZWF0PW1vbnRoLmhlYXRpbmdIZWF0S1doOwogICAgICBleGlzdGluZy5kaHdIZWF0PW1vbnRoLmRod0hlYXRLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wU291cmNlPW1vbnRoLmNvbXBsZXRlPyJteXZhaWxsYW50LWNzdi1pbXBvcnQiOiJteXZhaWxsYW50LWNzdi1pbXBvcnQtcGFydGlhbCI7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wVXBkYXRlZEF0PXN0YW1wOwogICAgICBleGlzdGluZy51cGRhdGVkQXQ9c3RhbXA7CiAgICAgIGlmKCFtb250aC5jb21wbGV0ZSl7CiAgICAgICAgcGFydGlhbCsrOwogICAgICAgIGNvbnN0IG5vdGU9YG15VkFJTExBTlQgQ1NWLVRlaWxtb25hdCAke21vbnRoLmNvdmVyYWdlU3RhcnR9IGJpcyAke21vbnRoLmNvdmVyYWdlRW5kfWA7CiAgICAgICAgaWYoIVN0cmluZyhleGlzdGluZy5ub3RlfHwiIikuaW5jbHVkZXMobm90ZSkpZXhpc3Rpbmcubm90ZT1leGlzdGluZy5ub3RlP2Ake2V4aXN0aW5nLm5vdGV9IOKAoiAke25vdGV9YDpub3RlOwogICAgICAgIGV4aXN0aW5nLmNsb3NlZD1mYWxzZTtleGlzdGluZy5jbG9zZWRBdD1udWxsOwogICAgICB9CiAgICAgIHJlY29yZE1hcC5zZXQobW9udGgubW9udGgsZXhpc3RpbmcpOwogICAgICB2YWlsbGFudE1hcC5zZXQobW9udGgubW9udGgse21vbnRoOm1vbnRoLm1vbnRoLGVsZWN0cmljaXR5S1doOm1vbnRoLmVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2g6bW9udGguaGVhdEdlbmVyYXRlZEtXaCxoZWF0aW5nRWxlY3RyaWNpdHlLV2g6bW9udGguaGVhdGluZ0VsZWN0cmljaXR5S1doLGRod0VsZWN0cmljaXR5S1doOm1vbnRoLmRod0VsZWN0cmljaXR5S1doLGhlYXRpbmdIZWF0S1doOm1vbnRoLmhlYXRpbmdIZWF0S1doLGRod0hlYXRLV2g6bW9udGguZGh3SGVhdEtXaCxzb3VyY2U6ZXhpc3RpbmcuaGVhdFB1bXBTb3VyY2UsZXN0aW1hdGVkOiFtb250aC5jb21wbGV0ZSx1cGRhdGVkQXQ6c3RhbXB9KTsKICAgICAgaW1wb3J0ZWQrKztpZih3YXNOZXcpY3JlYXRlZCsrOwogICAgfQogICAgc2F2ZVJlY29yZHMoWy4uLnJlY29yZE1hcC52YWx1ZXMoKV0se3JlYXNvbjoibXlWQUlMTEFOVCBDU1YgaW1wb3J0aWVydCJ9KTsKICAgIHZhaWxsYW50TW9udGhzPVsuLi52YWlsbGFudE1hcC52YWx1ZXMoKV0uc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTtzYXZlVmFpbGxhbnRNb250aHMoKTsKICAgIHJldHVybiB7aW1wb3J0ZWQsY3JlYXRlZCxwYXJ0aWFsfTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gaW1wb3J0VmFpbGxhbnRDc3ZGaWxlcyhmaWxlTGlzdCl7CiAgICBjb25zdCBmaWxlcz1bLi4uKGZpbGVMaXN0fHxbXSldOwogICAgaWYoIWZpbGVzLmxlbmd0aClyZXR1cm47CiAgICBzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIiwiRGF0ZWllbiB3ZXJkZW4gbG9rYWwgZ2VwcsO8ZnQg4oCmIik7CiAgICB0cnl7CiAgICAgIGNvbnN0IHBhcnNlZD1bXTsKICAgICAgZm9yKGxldCBpPTA7aTxmaWxlcy5sZW5ndGg7aSsrKXBhcnNlZC5wdXNoKHBhcnNlVmFpbGxhbnRDc3ZUZXh0KGF3YWl0IGZpbGVzW2ldLnRleHQoKSxpKSk7CiAgICAgIGNvbnN0IHByZXZpZXc9YnVpbGRWYWlsbGFudEltcG9ydFByZXZpZXcocGFyc2VkKTsKICAgICAgY29uc3QgaW1wb3J0YWJsZT1wcmV2aWV3Lm1vbnRocy5maWx0ZXIobT0+IW0uYmxvY2tlZCk7CiAgICAgIGNvbnN0IG1pc3NpbmdBcm89IXBhcnNlZC5zb21lKGY9PmYudHlwZT09PSJhcm90aGVybS1lbmVyZ3kiKSxtaXNzaW5nVW5pPSFwYXJzZWQuc29tZShmPT5mLnR5cGU9PT0idW5pdG93ZXItZW5lcmd5Iik7CiAgICAgIGlmKG1pc3NpbmdBcm98fG1pc3NpbmdVbmkpdGhyb3cgbmV3IEVycm9yKGBFcyBmZWhsZW4gJHtbbWlzc2luZ0Fybz8iYXJvVEhFUk0tRW5lcmdpZSI6bnVsbCxtaXNzaW5nVW5pPyJ1bmlUT1dFUi1FbmVyZ2llIjpudWxsXS5maWx0ZXIoQm9vbGVhbikuam9pbigiIHVuZCAiKX0uIEJpdHRlIGJlaWRlIEV4cG9ydGRhdGVpZW4gYXVzd8OkaGxlbi5gKTsKICAgICAgaWYoIXByZXZpZXcubW9udGhzLmxlbmd0aCl0aHJvdyBuZXcgRXJyb3IoIktlaW5lIFfDpHJtZXB1bXBlbi1Nb25hdHNkYXRlbiBlcmthbm50LiIpOwogICAgICBpZighaW1wb3J0YWJsZS5sZW5ndGgpewogICAgICAgIGNvbnN0IGJsb2NrZWQ9cHJldmlldy5tb250aHMubWFwKG09PmAke21vbnRoTGFiZWwobS5tb250aCxmYWxzZSl9OiAke20uaGFzQ29uZmxpY3Q/IktvbmZsaWt0IjptLm5lZ2F0aXZlUmVzdD8idW5wbGF1c2libGVyIFJlc3R2ZXJicmF1Y2giOiFtLmhhc0JvdGg/IkRhdGVpIGZlaGx0IjohbS5jb21wbGV0ZSYmIW0uaXNDdXJyZW50PyJoaXN0b3Jpc2NoZXIgVGVpbG1vbmF0IjoibmljaHQgaW1wb3J0aWVyYmFyIn1gKS5qb2luKCIg4oCiICIpOwogICAgICAgIHRocm93IG5ldyBFcnJvcihgS2VpbmUgaW1wb3J0aWVyYmFyZW4gTW9uYXRlLiAke2Jsb2NrZWR9YCk7CiAgICAgIH0KICAgICAgY29uc3QgYmxvY2tlZENvdW50PXByZXZpZXcubW9udGhzLmxlbmd0aC1pbXBvcnRhYmxlLmxlbmd0aDsKICAgICAgY29uc3QgbWVzc2FnZT1gJHtpbXBvcnRhYmxlLmxlbmd0aH0gTW9uYXQoZSkgaW1wb3J0aWVyZW4/JHtibG9ja2VkQ291bnQ/YCAke2Jsb2NrZWRDb3VudH0gdW52b2xsc3TDpG5kaWdlL2F1ZmbDpGxsaWdlIE1vbmF0ZSB3ZXJkZW4gw7xiZXJzcHJ1bmdlbi5gOiIifSBHZXNhbXR2ZXJicmF1Y2gsIEFsdGVudGVpbCwgUHJlaXNlIHVuZCBOb3RpemVuIGJsZWliZW4gZXJoYWx0ZW4uYDsKICAgICAgaWYoIWNvbmZpcm0obWVzc2FnZSkpe3NldFN0YXR1cygidmFpbGxhbnRJbXBvcnRTdGF0dXMiLCJJbXBvcnQgYWJnZWJyb2NoZW4uIik7cmV0dXJuO30KICAgICAgY29uc3QgcmVzdWx0PW1lcmdlVmFpbGxhbnRJbXBvcnQoaW1wb3J0YWJsZSk7CiAgICAgIHJlbmRlckFsbCgpOwogICAgICBzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIixgJHtyZXN1bHQuaW1wb3J0ZWR9IE1vbmF0KGUpIGltcG9ydGllcnQke3Jlc3VsdC5wYXJ0aWFsP2AgwrcgJHtyZXN1bHQucGFydGlhbH0gYWt0dWVsbGVyIFRlaWxtb25hdGA6IiJ9JHtibG9ja2VkQ291bnQ/YCDCtyAke2Jsb2NrZWRDb3VudH0gw7xiZXJzcHJ1bmdlbmA6IiJ9LmAsIm9rIik7CiAgICAgIHRvYXN0KGAke3Jlc3VsdC5pbXBvcnRlZH0gV8Okcm1lcHVtcGVuLU1vbmF0ZSBpbXBvcnRpZXJ0YCk7CiAgICB9Y2F0Y2goZXJyb3Ipe3NldFN0YXR1cygidmFpbGxhbnRJbXBvcnRTdGF0dXMiLGVycm9yLm1lc3NhZ2UsImVycm9yIik7fQogICAgZmluYWxseXskKCJ2YWlsbGFudENzdkZpbGVzSW5wdXQiKS52YWx1ZT0iIjt9CiAgfQoKICBhc3luYyBmdW5jdGlvbiBvc3Ryb21GZXRjaChwYXRoKXsKICAgIGlmKCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpdGhyb3cgbmV3IEVycm9yKCJBcHAtU2NobMO8c3NlbCBmZWhsdC4iKTsKICAgIGNvbnN0IHJlc3BvbnNlPWF3YWl0IGZldGNoKHBhdGgse2hlYWRlcnM6eyJ4LWVsZGVob2Yta2V5IjpzZXR0aW5ncy5vc3Ryb21BcHBLZXksImFjY2VwdCI6ImFwcGxpY2F0aW9uL2pzb24ifSxjYWNoZToibm8tc3RvcmUifSk7IGNvbnN0IHRleHQ9YXdhaXQgcmVzcG9uc2UudGV4dCgpOyBsZXQgcGF5bG9hZD17fTsgdHJ5e3BheWxvYWQ9dGV4dD9KU09OLnBhcnNlKHRleHQpOnt9O31jYXRjaHt9CiAgICBpZighcmVzcG9uc2Uub2spdGhyb3cgbmV3IEVycm9yKHBheWxvYWQuZXJyb3J8fHBheWxvYWQubWVzc2FnZXx8dGV4dHx8YEZlaGxlciAke3Jlc3BvbnNlLnN0YXR1c31gKTsgcmV0dXJuIHBheWxvYWQ7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hPc3Ryb20oc2hvd1RvYXN0PWZhbHNlKXsKICAgIGlmKG9zdHJvbUJ1c3l8fCFzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe3JlbmRlck9zdHJvbURhc2hib2FyZCgpO3JldHVybiBmYWxzZTt9CiAgICBvc3Ryb21CdXN5PXRydWU7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7CiAgICB0cnl7IGNvbnN0IHBheWxvYWQ9YXdhaXQgb3N0cm9tRmV0Y2goYC9hcGkvbGl2ZSR7c2hvd1RvYXN0PyI/cmVmcmVzaD0xIjoiIn1gKTsgc2F2ZU9zdHJvbUNhY2hlKHBheWxvYWQpOyBpZihzaG93VG9hc3QpdG9hc3QoIk9zdHJvbSBha3R1YWxpc2llcnQiKTsgcmV0dXJuIHRydWU7IH0KICAgIGNhdGNoKGVycm9yKXsgc2V0T3N0cm9tU3RhdHVzKGBGZWhsZXI6ICR7ZXJyb3IubWVzc2FnZX1gLCJlcnJvciIpOyBpZihzaG93VG9hc3QpdG9hc3QoYE9zdHJvbTogJHtlcnJvci5tZXNzYWdlfWApOyByZXR1cm4gZmFsc2U7IH0KICAgIGZpbmFsbHl7b3N0cm9tQnVzeT1mYWxzZTtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTt9CiAgfQogIGZ1bmN0aW9uIHNjaGVkdWxlT3N0cm9tKCl7IGNsZWFySW50ZXJ2YWwob3N0cm9tVGltZXIpO29zdHJvbVRpbWVyPW51bGw7IGlmKHNldHRpbmdzLm9zdHJvbUFwcEtleSYmc2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2ghPT1mYWxzZSlvc3Ryb21UaW1lcj1zZXRJbnRlcnZhbCgoKT0+cmVmcmVzaE9zdHJvbShmYWxzZSksMTAqNjAqMTAwMCk7IH0KICBmdW5jdGlvbiBzZXRPc3Ryb21TdGF0dXModGV4dCxraW5kPSIiKXsgY29uc3QgZWw9JCgib3N0cm9tU3RhdHVzIik7ZWwudGV4dENvbnRlbnQ9dGV4dDtlbC5zdHlsZS5jb2xvcj1raW5kPT09ImVycm9yIj8iI2ZmYWFhOSI6IiI7IH0KICBmdW5jdGlvbiBmb3JtYXREYXRlVGltZSh2YWx1ZSl7IGNvbnN0IGQ9bmV3IERhdGUodmFsdWUpOyBpZihOdW1iZXIuaXNOYU4oZC52YWx1ZU9mKCkpKXJldHVybiAi4oCTIjsgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse3dlZWtkYXk6InNob3J0IixkYXk6IjItZGlnaXQiLG1vbnRoOiIyLWRpZ2l0Iixob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KGQpOyB9CiAgZnVuY3Rpb24gaW50ZXJ2YWxSb3dzKCl7IHJldHVybiAoQXJyYXkuaXNBcnJheShvc3Ryb21MaXZlPy5wcmljZUZvcmVjYXN0KT9vc3Ryb21MaXZlLnByaWNlRm9yZWNhc3Q6W10pLm1hcChwPT4oe3RpbWU6bmV3IERhdGUocC5kYXRlfHxwLnN0YXJ0fHxwLnRpbWVzdGFtcCkuZ2V0VGltZSgpLHByaWNlOk51bWJlcihwLnRvdGFsQ3RQZXJLV2g/P3AucHJpY2VDdFBlcktXaD8/cC5wcmljZSl9KSkuZmlsdGVyKHA9Pk51bWJlci5pc0Zpbml0ZShwLnRpbWUpJiZOdW1iZXIuaXNGaW5pdGUocC5wcmljZSkpLnNvcnQoKGEsYik9PmEudGltZS1iLnRpbWUpOyB9CiAgZnVuY3Rpb24gaW5mZXJTdGVwKHJvd3MpeyBjb25zdCBkaWZmcz1bXTtmb3IobGV0IGk9MTtpPHJvd3MubGVuZ3RoO2krKyl7Y29uc3QgZD1yb3dzW2ldLnRpbWUtcm93c1tpLTFdLnRpbWU7aWYoZD49NSo2MGUzJiZkPD0yKjM2MDBlMylkaWZmcy5wdXNoKGQpO30gaWYoIWRpZmZzLmxlbmd0aClyZXR1cm4gMzYwMGUzO2RpZmZzLnNvcnQoKGEsYik9PmEtYik7cmV0dXJuIGRpZmZzW01hdGguZmxvb3IoZGlmZnMubGVuZ3RoLzIpXTsgfQogIGZ1bmN0aW9uIGNvbXB1dGVQcmljZVdpbmRvdyhyb3dzLGhvdXJzLG1vZGUpewogICAgaWYoIXJvd3MubGVuZ3RoKXJldHVybiBudWxsOyBjb25zdCBzdGVwPWluZmVyU3RlcChyb3dzKTsgY29uc3QgY291bnQ9TWF0aC5tYXgoMSxNYXRoLnJvdW5kKGhvdXJzKjM2MDBlMy9zdGVwKSk7IGNvbnN0IG5vdz1EYXRlLm5vdygpOyBjb25zdCBwb29sPXJvd3MuZmlsdGVyKHI9PnIudGltZT49bm93LXN0ZXApLnNsaWNlKDAsTWF0aC5tYXgoY291bnQsTWF0aC5yb3VuZCg0OCozNjAwZTMvc3RlcCkpKTsKICAgIGxldCBiZXN0PW51bGw7CiAgICBmb3IobGV0IGk9MDtpK2NvdW50PD1wb29sLmxlbmd0aDtpKyspe2NvbnN0IHNsaWNlPXBvb2wuc2xpY2UoaSxpK2NvdW50KTtsZXQgY29udGlndW91cz10cnVlO2ZvcihsZXQgaj0xO2o8c2xpY2UubGVuZ3RoO2orKylpZihzbGljZVtqXS50aW1lLXNsaWNlW2otMV0udGltZT5zdGVwKjEuNil7Y29udGlndW91cz1mYWxzZTticmVhazt9aWYoIWNvbnRpZ3VvdXMpY29udGludWU7Y29uc3QgYXZnPXNsaWNlLnJlZHVjZSgocyxyKT0+cytyLnByaWNlLDApL3NsaWNlLmxlbmd0aDtjb25zdCBjYW5kaWRhdGU9e3N0YXJ0OnNsaWNlWzBdLnRpbWUsZW5kOnNsaWNlLmF0KC0xKS50aW1lK3N0ZXAsYXZnfTtpZighYmVzdHx8KG1vZGU9PT0ibWluIj9hdmc8YmVzdC5hdmc6YXZnPmJlc3QuYXZnKSliZXN0PWNhbmRpZGF0ZTt9CiAgICByZXR1cm4gYmVzdDsKICB9CiAgZnVuY3Rpb24gcmVuZGVyT3N0cm9tRGFzaGJvYXJkKCl7CiAgICBjb25zdCBjb25uZWN0ZWQ9Qm9vbGVhbihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpOyAkKCJvc3Ryb21TZXR1cEhpbnQiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLGNvbm5lY3RlZCk7ICQoIm9zdHJvbURhc2hib2FyZCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIWNvbm5lY3RlZCk7ICQoIm9zdHJvbU1pbmlDaGFydCIpLnBhcmVudEVsZW1lbnQuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhY29ubmVjdGVkKTsgJCgicmVmcmVzaE9zdHJvbUJ0biIpLmRpc2FibGVkPSFjb25uZWN0ZWR8fG9zdHJvbUJ1c3k7CiAgICBpZighY29ubmVjdGVkKXsgc2V0T3N0cm9tU3RhdHVzKCJOaWNodCB2ZXJidW5kZW4iKTsgcmV0dXJuOyB9CiAgICBpZihvc3Ryb21CdXN5KXNldE9zdHJvbVN0YXR1cygiQWt0dWFsaXNpZXJ1bmcgbMOkdWZ0IOKApiIpOyBlbHNlIGlmKG9zdHJvbUxpdmU/LmdlbmVyYXRlZEF0KXNldE9zdHJvbVN0YXR1cyhgQWt0dWFsaXNpZXJ0ICR7Zm9ybWF0RGF0ZVRpbWUob3N0cm9tTGl2ZS5nZW5lcmF0ZWRBdCl9YCk7IGVsc2Ugc2V0T3N0cm9tU3RhdHVzKCJOb2NoIGtlaW5lIExpdmUtRGF0ZW4iKTsKICAgIGNvbnN0IHJvd3M9aW50ZXJ2YWxSb3dzKCk7IGlmKCFyb3dzLmxlbmd0aCl7IFsib3N0cm9tQ3VycmVudFByaWNlIiwib3N0cm9tQmVzdFByaWNlIiwib3N0cm9tV29yc3RQcmljZSJdLmZvckVhY2goaWQ9PiQoaWQpLnRleHRDb250ZW50PSLigJMiKTsgWyJvc3Ryb21DdXJyZW50TWV0YSIsIm9zdHJvbUJlc3RNZXRhIiwib3N0cm9tV29yc3RNZXRhIl0uZm9yRWFjaChpZD0+JChpZCkudGV4dENvbnRlbnQ9Ik5vY2gga2VpbmUgUHJlaXN2b3JzY2hhdSIpOyBkcmF3T3N0cm9tTWluaShbXSk7IHJldHVybjsgfQogICAgY29uc3Qgbm93PURhdGUubm93KCksc3RlcD1pbmZlclN0ZXAocm93cyk7IGNvbnN0IGN1cnJlbnQ9cm93cy5maW5kKChyLGkpPT5yLnRpbWU8PW5vdyYmKHJvd3NbaSsxXT8udGltZT8/ci50aW1lK3N0ZXApPm5vdyl8fHJvd3MuZmluZChyPT5yLnRpbWU+bm93KXx8cm93cy5hdCgtMSk7IGNvbnN0IGhvdXJzPU51bWJlcihzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vycyl8fDM7IGNvbnN0IGJlc3Q9Y29tcHV0ZVByaWNlV2luZG93KHJvd3MsaG91cnMsIm1pbiIpLCB3b3JzdD1jb21wdXRlUHJpY2VXaW5kb3cocm93cyxob3VycywibWF4Iik7CiAgICAkKCJvc3Ryb21CZXN0TGFiZWwiKS50ZXh0Q29udGVudD1gQmVzdGVzICR7aG91cnN9aC1GZW5zdGVyYDsgJCgib3N0cm9tV29yc3RMYWJlbCIpLnRleHRDb250ZW50PWBTY2hsZWNodGVzdGVzICR7aG91cnN9aC1GZW5zdGVyYDsKICAgICQoIm9zdHJvbUN1cnJlbnRQcmljZSIpLnRleHRDb250ZW50PWAke251bShjdXJyZW50Py5wcmljZSwyKX0gY3Qva1doYDsgJCgib3N0cm9tQ3VycmVudE1ldGEiKS50ZXh0Q29udGVudD1jdXJyZW50P2Zvcm1hdERhdGVUaW1lKGN1cnJlbnQudGltZSk6IuKAkyI7CiAgICAkKCJvc3Ryb21CZXN0UHJpY2UiKS50ZXh0Q29udGVudD1iZXN0P2Ake251bShiZXN0LmF2ZywyKX0gY3Qva1doYDoi4oCTIjsgJCgib3N0cm9tQmVzdE1ldGEiKS50ZXh0Q29udGVudD1iZXN0P2Ake2Zvcm1hdERhdGVUaW1lKGJlc3Quc3RhcnQpfSDigJMgJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKGJlc3QuZW5kKSl9YDoi4oCTIjsKICAgICQoIm9zdHJvbVdvcnN0UHJpY2UiKS50ZXh0Q29udGVudD13b3JzdD9gJHtudW0od29yc3QuYXZnLDIpfSBjdC9rV2hgOiLigJMiOyAkKCJvc3Ryb21Xb3JzdE1ldGEiKS50ZXh0Q29udGVudD13b3JzdD9gJHtmb3JtYXREYXRlVGltZSh3b3JzdC5zdGFydCl9IOKAkyAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQiLG1pbnV0ZToiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUod29yc3QuZW5kKSl9YDoi4oCTIjsKICAgIGRyYXdPc3Ryb21NaW5pKHJvd3MuZmlsdGVyKHI9PnIudGltZT49bm93LXN0ZXApLnNsaWNlKDAsNDgpKTsKICB9CiAgZnVuY3Rpb24gZHJhd09zdHJvbU1pbmkocm93cyl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoIm9zdHJvbU1pbmlDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgaWYoIXJvd3MubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCwiS2VpbmUgT3N0cm9tLVByZWlzZGF0ZW4iKTtyZXR1cm47fSBjb25zdCBtaW49TWF0aC5taW4oLi4ucm93cy5tYXAocj0+ci5wcmljZSkpLG1heD1NYXRoLm1heCguLi5yb3dzLm1hcChyPT5yLnByaWNlKSksc3Bhbj1NYXRoLm1heCgxLG1heC1taW4pOyBjb25zdCBwYWQ9e2w6NDMscjo4LHQ6MTIsYjozMH0sdz13aWR0aC1wYWQubC1wYWQucixoPWhlaWdodC1wYWQudC1wYWQuYjsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuZ3JpZDtjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0O2N0eC5mb250PSIxMHB4IHNhbnMtc2VyaWYiO2ZvcihsZXQgaT0wO2k8PTM7aSsrKXtjb25zdCB5PXBhZC50K2gqaS8zO2N0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKHBhZC5sLHkpO2N0eC5saW5lVG8od2lkdGgtcGFkLnIseSk7Y3R4LnN0cm9rZSgpO2N0eC5maWxsVGV4dChudW0obWF4LXNwYW4qaS8zLDApLDQseSszKTt9IGN0eC5zdHJva2VTdHlsZT1DT0xPUlMudG90YWw7Y3R4LmxpbmVXaWR0aD0yO2N0eC5iZWdpblBhdGgoKTtyb3dzLmZvckVhY2goKHIsaSk9Pntjb25zdCB4PXBhZC5sKyhyb3dzLmxlbmd0aD09PTE/dy8yOncqaS8ocm93cy5sZW5ndGgtMSkpLHk9cGFkLnQraCooMS0oci5wcmljZS1taW4pL3NwYW4pO2k/Y3R4LmxpbmVUbyh4LHkpOmN0eC5tb3ZlVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgICBjb25zdCBzdGVwPU1hdGgubWF4KDEsTWF0aC5mbG9vcihyb3dzLmxlbmd0aC81KSk7IHJvd3MuZm9yRWFjaCgocixpKT0+e2lmKGklc3RlcCYmaSE9PXJvd3MubGVuZ3RoLTEpcmV0dXJuO2NvbnN0IHg9cGFkLmwrKHJvd3MubGVuZ3RoPT09MT93LzI6dyppLyhyb3dzLmxlbmd0aC0xKSk7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZmlsbFRleHQobmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCJ9KS5mb3JtYXQobmV3IERhdGUoci50aW1lKSkseC04LGhlaWdodC05KTt9KTsKICB9CiAgZnVuY3Rpb24gb3N0cm9tSGlzdG9yeUxhc3RTeW5jKCl7IGNvbnN0IHZhbHVlPWxvY2FsU3RvcmFnZS5nZXRJdGVtKE9TVFJPTV9ISVNUT1JZX1NZTkNfS0VZKTsgcmV0dXJuIHZhbHVlJiZOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZSh2YWx1ZSkpP3ZhbHVlOiIiOyB9CiAgYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE9zdHJvbUhpc3Rvcnkoe2ZvcmNlPWZhbHNlLHNob3dUb2FzdD10cnVlfT17fSl7CiAgICBpZihvc3Ryb21IaXN0b3J5QnVzeXx8IXNldHRpbmdzLm9zdHJvbUFwcEtleSlyZXR1cm4gZmFsc2U7CiAgICBjb25zdCBjdXJyZW50PWN1cnJlbnRNb250aEtleSgpOwogICAgY29uc3QgY2FuZGlkYXRlcz1zb3J0ZWQoKS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpJiZyLm1vbnRoPD1jdXJyZW50JiYoZm9yY2V8fHIucHJpY2VTb3VyY2UhPT0ib3N0cm9tLWhvdXJseS1leGFjdCJ8fCFyLm9zdHJvbUNvbXBsZXRlKSk7CiAgICBpZighY2FuZGlkYXRlcy5sZW5ndGgpe3NldFN0YXR1cygib3N0cm9tSGlzdG9yeVN0YXR1cyIsIkFsbGUgdmVyZsO8Z2JhcmVuIE1vbmF0ZSBiZXNpdHplbiBiZXJlaXRzIE9zdHJvbS1QcmVpc2RhdGVuLiIsIm9rIik7cmV0dXJuIHRydWU7fQogICAgb3N0cm9tSGlzdG9yeUJ1c3k9dHJ1ZTsgJCgic3luY09zdHJvbUhpc3RvcnlCdG4iKS5kaXNhYmxlZD10cnVlOwogICAgbGV0IHVwZGF0ZWQ9MCxmYWlsZWQ9MCx1bmF2YWlsYWJsZT0wOyBjb25zdCBtYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICB0cnl7CiAgICAgIGZvcihsZXQgaW5kZXg9MDtpbmRleDxjYW5kaWRhdGVzLmxlbmd0aDtpbmRleCsrKXsKICAgICAgICBjb25zdCByZWNvcmQ9Y2FuZGlkYXRlc1tpbmRleF07IHNldFN0YXR1cygib3N0cm9tSGlzdG9yeVN0YXR1cyIsYE9zdHJvbS1IaXN0b3JpZSAke2luZGV4KzF9LyR7Y2FuZGlkYXRlcy5sZW5ndGh9OiAke21vbnRoTGFiZWwocmVjb3JkLm1vbnRoLGZhbHNlKX0g4oCmYCk7CiAgICAgICAgdHJ5ewogICAgICAgICAgY29uc3QgcGF5bG9hZD1hd2FpdCBvc3Ryb21GZXRjaChgL2FwaS9tb250aD9tb250aD0ke2VuY29kZVVSSUNvbXBvbmVudChyZWNvcmQubW9udGgpfSR7Zm9yY2U/IiZyZWZyZXNoPTEiOiIifWApOwogICAgICAgICAgaWYoIU51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCkpfHxOdW1iZXIocGF5bG9hZC5tYXRjaGVkSW50ZXJ2YWxzfHwwKTw9MCl7dW5hdmFpbGFibGUrKztjb250aW51ZTt9CiAgICAgICAgICBjb25zdCBzdGFtcD1uZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7IGNvbnN0IG5leHQ9bWFwLmdldChyZWNvcmQubW9udGgpfHx7Li4ucmVjb3JkfTsKICAgICAgICAgIG5leHQucHJpY2VDdD1OdW1iZXIocGF5bG9hZC53ZWlnaHRlZEF2ZXJhZ2VDdFBlcktXaCk7IG5leHQuYmFzZUZlZT1OdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHBheWxvYWQuZml4ZWRDb3N0RXVyKSk/TnVtYmVyKHBheWxvYWQuZml4ZWRDb3N0RXVyKTpuZXh0LmJhc2VGZWU7CiAgICAgICAgICBuZXh0Lm9zdHJvbVRvdGFsS1doPW51bGxhYmxlTnVtYmVyKHBheWxvYWQudG90YWxLV2gpOyBuZXh0Lm9zdHJvbVZhcmlhYmxlQ29zdEV1cj1udWxsYWJsZU51bWJlcihwYXlsb2FkLnZhcmlhYmxlQ29zdEV1cik7IG5leHQub3N0cm9tVG90YWxDb3N0RXVyPW51bGxhYmxlTnVtYmVyKHBheWxvYWQudG90YWxDb3N0RXVyKTsKICAgICAgICAgIG5leHQub3N0cm9tQ29uc3VtcHRpb25JbnRlcnZhbHM9bnVsbGFibGVOdW1iZXIocGF5bG9hZC5jb25zdW1wdGlvbkludGVydmFscyk7IG5leHQub3N0cm9tTWF0Y2hlZEludGVydmFscz1udWxsYWJsZU51bWJlcihwYXlsb2FkLm1hdGNoZWRJbnRlcnZhbHMpOyBuZXh0Lm9zdHJvbUNvbXBsZXRlPXBheWxvYWQuY29tcGxldGU9PT10cnVlOwogICAgICAgICAgbmV4dC5wcmljZVNvdXJjZT1uZXh0Lm9zdHJvbUNvbXBsZXRlPyJvc3Ryb20taG91cmx5LWV4YWN0Ijoib3N0cm9tLWhvdXJseS1wYXJ0aWFsIjsgbmV4dC5wcmljZVVwZGF0ZWRBdD1zdGFtcDsgbmV4dC51cGRhdGVkQXQ9c3RhbXA7IG1hcC5zZXQocmVjb3JkLm1vbnRoLG5leHQpOyB1cGRhdGVkKys7CiAgICAgICAgfWNhdGNoKGVycm9yKXtmYWlsZWQrKzsgY29uc29sZS53YXJuKCJPc3Ryb20gaGlzdG9yeSIscmVjb3JkLm1vbnRoLGVycm9yKTt9CiAgICAgIH0KICAgICAgaWYodXBkYXRlZClzYXZlUmVjb3JkcyhbLi4ubWFwLnZhbHVlcygpXSx7cmVhc29uOiJIaXN0b3Jpc2NoZSBPc3Ryb20tUHJlaXNlIGFrdHVhbGlzaWVydCJ9KTsKICAgICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO2xvY2FsU3RvcmFnZS5zZXRJdGVtKE9TVFJPTV9ISVNUT1JZX1NZTkNfS0VZLHN0YW1wKTsKICAgICAgY29uc3QgZGV0YWlsPWAke3VwZGF0ZWR9IE1vbmF0KGUpIGFrdHVhbGlzaWVydCR7dW5hdmFpbGFibGU/YCDCtyAke3VuYXZhaWxhYmxlfSBvaG5lIHZlcmbDvGdiYXJlIEludGVydmFsbHdlcnRlYDoiIn0ke2ZhaWxlZD9gIMK3ICR7ZmFpbGVkfSBGZWhsZXJgOiIifS5gOwogICAgICBzZXRTdGF0dXMoIm9zdHJvbUhpc3RvcnlTdGF0dXMiLGRldGFpbCxmYWlsZWQmJnVwZGF0ZWQ9PT0wPyJlcnJvciI6Im9rIik7IGlmKHNob3dUb2FzdCl0b2FzdChgT3N0cm9tLUhpc3RvcmllOiAke3VwZGF0ZWR9IE1vbmF0ZWApOyByZW5kZXJBbGwoKTsgcmV0dXJuIHVwZGF0ZWQ+MHx8ZmFpbGVkPT09MDsKICAgIH1maW5hbGx5e29zdHJvbUhpc3RvcnlCdXN5PWZhbHNlOyAkKCJzeW5jT3N0cm9tSGlzdG9yeUJ0biIpLmRpc2FibGVkPWZhbHNlO30KICB9CiAgZnVuY3Rpb24gc2NoZWR1bGVPc3Ryb21IaXN0b3J5KCl7CiAgICBpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXJldHVybjsgY29uc3QgbGFzdD1vc3Ryb21IaXN0b3J5TGFzdFN5bmMoKTsgY29uc3QgYWdlPWxhc3Q/RGF0ZS5ub3coKS1EYXRlLnBhcnNlKGxhc3QpOkluZmluaXR5OwogICAgaWYoIU51bWJlci5pc0Zpbml0ZShhZ2UpfHxhZ2U+MjQqNjAqNjAqMTAwMClzZXRUaW1lb3V0KCgpPT5yZWZyZXNoT3N0cm9tSGlzdG9yeSh7Zm9yY2U6ZmFsc2Usc2hvd1RvYXN0OmZhbHNlfSksMjUwMCk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBzYXZlQW5kQ2hlY2tPc3Ryb20oKXsKICAgIGNvbnN0IGtleT0kKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlLnRyaW0oKTsgc2V0dGluZ3Mub3N0cm9tQXBwS2V5PWtleTsgc2V0dGluZ3Mub3N0cm9tQXV0b1JlZnJlc2g9JCgib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIpLmNoZWNrZWQ7IHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzPU51bWJlcigkKCJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0IikudmFsdWUpfHwzOyBzYXZlU2V0dGluZ3MoKTsKICAgIGlmKCFrZXkpe3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIkJpdHRlIEFwcC1TY2hsw7xzc2VsIGVpbnRyYWdlbi4iLCJlcnJvciIpO3JlbmRlck9zdHJvbURhc2hib2FyZCgpO3JldHVybjt9CiAgICBzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJWZXJiaW5kdW5nIHdpcmQgZ2VwcsO8ZnQg4oCmIik7CiAgICB0cnl7IGNvbnN0IGhlYWx0aD1hd2FpdCBvc3Ryb21GZXRjaCgiL2FwaS9oZWFsdGg/ZGVlcD10b2tlbiIpOyBpZighaGVhbHRoLmNvbmZpZ3VyZWQpdGhyb3cgbmV3IEVycm9yKCJDbG91ZGZsYXJlLVNlY3JldHMgc2luZCBuaWNodCB2b2xsc3TDpG5kaWcgZWluZ2VyaWNodGV0LiIpOyBzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJPc3Ryb20tVmVyYmluZHVuZyBlcmZvbGdyZWljaC4iLCJvayIpOyBhd2FpdCByZWZyZXNoT3N0cm9tKHRydWUpOyBzY2hlZHVsZU9zdHJvbSgpOyByZW5kZXJBbGwoKTsgc2NoZWR1bGVPc3Ryb21IaXN0b3J5KCk7IH0KICAgIGNhdGNoKGVycm9yKXtzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLGVycm9yLm1lc3NhZ2UsImVycm9yIik7fQogIH0KICBmdW5jdGlvbiBkaXNjb25uZWN0T3N0cm9tKCl7IGlmKHNldHRpbmdzLm9zdHJvbUFwcEtleSYmIWNvbmZpcm0oIk9zdHJvbS1WZXJiaW5kdW5nIHdpcmtsaWNoIGVudGZlcm5lbj8iKSlyZXR1cm47IHNldHRpbmdzLm9zdHJvbUFwcEtleT0iIjtzYXZlU2V0dGluZ3MoKTtzYXZlT3N0cm9tQ2FjaGUobnVsbCk7bG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oT1NUUk9NX0NPTlRST0xfS0VZKTtzY2hlZHVsZU9zdHJvbSgpO3JlbmRlckFsbCgpO3NldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIlZlcmJpbmR1bmcgZW50ZmVybnQuIik7dG9hc3QoIk9zdHJvbSBnZXRyZW5udCIpOyB9CgogIGZ1bmN0aW9uIHNhdmVDb3N0U2V0dGluZ3MoKXsgc2V0dGluZ3MuZmFsbGJhY2tQcmljZT1NYXRoLm1heCgwLE51bWJlcigkKCJmYWxsYmFja1ByaWNlSW5wdXQiKS52YWx1ZSl8fDApO3NldHRpbmdzLmRlZmF1bHRCYXNlRmVlPU1hdGgubWF4KDAsTnVtYmVyKCQoImRlZmF1bHRCYXNlRmVlSW5wdXQiKS52YWx1ZSl8fDApO3NhdmVTZXR0aW5ncygpO3JlbmRlckFsbCgpO3RvYXN0KCJLb3N0ZW4tRWluc3RlbGx1bmdlbiBnZXNwZWljaGVydCIpOyB9CgogIGZ1bmN0aW9uIHN5bmNCeXRlc1RvQmFzZTY0VXJsKGJ5dGVzKXtsZXQgYmluYXJ5PSIiO2ZvcihsZXQgaT0wO2k8Ynl0ZXMubGVuZ3RoO2krPTgxOTIpYmluYXJ5Kz1TdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksaSs4MTkyKSk7cmV0dXJuIGJ0b2EoYmluYXJ5KS5yZXBsYWNlQWxsKCIrIiwiLSIpLnJlcGxhY2VBbGwoIi8iLCJfIikucmVwbGFjZSgvPSskL2csIiIpO30KICBmdW5jdGlvbiBzeW5jQmFzZTY0VXJsVG9CeXRlcyh2YWx1ZSl7Y29uc3QgcmF3PVN0cmluZyh2YWx1ZXx8IiIpLnJlcGxhY2VBbGwoIi0iLCIrIikucmVwbGFjZUFsbCgiXyIsIi8iKTtjb25zdCBwYWRkZWQ9cmF3KyI9Ii5yZXBlYXQoKDQtcmF3Lmxlbmd0aCU0KSU0KTtjb25zdCBiaW5hcnk9YXRvYihwYWRkZWQpLGJ5dGVzPW5ldyBVaW50OEFycmF5KGJpbmFyeS5sZW5ndGgpO2ZvcihsZXQgaT0wO2k8YmluYXJ5Lmxlbmd0aDtpKyspYnl0ZXNbaV09YmluYXJ5LmNoYXJDb2RlQXQoaSk7cmV0dXJuIGJ5dGVzO30KICBmdW5jdGlvbiBzeW5jUmFuZG9tQnl0ZXMobGVuZ3RoPTMyKXtjb25zdCBieXRlcz1uZXcgVWludDhBcnJheShsZW5ndGgpO2NyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnl0ZXMpO3JldHVybiBieXRlczt9CiAgZnVuY3Rpb24gc3luY0dlbmVyYXRlSWQocHJlZml4LGJ5dGVzPTE2KXtyZXR1cm4gYCR7cHJlZml4fS0ke3N5bmNCeXRlc1RvQmFzZTY0VXJsKHN5bmNSYW5kb21CeXRlcyhieXRlcykpfWA7fQogIGZ1bmN0aW9uIHN5bmNHZW5lcmF0ZVJlY292ZXJ5S2V5KCl7cmV0dXJuIFsuLi5zeW5jUmFuZG9tQnl0ZXMoMzIpXS5tYXAoYj0+Yi50b1N0cmluZygxNikucGFkU3RhcnQoMiwiMCIpKS5qb2luKCIiKTt9CiAgZnVuY3Rpb24gZGVmYXVsdERldmljZU5hbWUoKXtjb25zdCB1YT1uYXZpZ2F0b3IudXNlckFnZW50fHwiIjtpZigvaVBhZC9pLnRlc3QodWEpfHwoL01hY2ludG9zaC9pLnRlc3QodWEpJiZuYXZpZ2F0b3IubWF4VG91Y2hQb2ludHM+MSkpcmV0dXJuICJpUGFkIjtpZigvaVBob25lL2kudGVzdCh1YSkpcmV0dXJuICJpUGhvbmUiO2lmKC9BbmRyb2lkL2kudGVzdCh1YSkpcmV0dXJuICJBbmRyb2lkIjtpZigvTWFjL2kudGVzdCh1YSkpcmV0dXJuICJNYWMiO2lmKC9XaW5kb3dzL2kudGVzdCh1YSkpcmV0dXJuICJXaW5kb3dzLVBDIjtyZXR1cm4gIkVsZGVob2YtR2Vyw6R0Ijt9CiAgZnVuY3Rpb24gbG9hZFN5bmNTdGF0ZSgpe2NvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNZTkNfU1RBVEVfS0VZKSx7fSk7cmV0dXJuIHtjb25maWd1cmVkOkJvb2xlYW4ocmF3Py5jb25maWd1cmVkKSx2YXVsdElkOlN0cmluZyhyYXc/LnZhdWx0SWR8fCIiKSxkZXZpY2VJZDpTdHJpbmcocmF3Py5kZXZpY2VJZHx8IiIpLGRldmljZVRva2VuOlN0cmluZyhyYXc/LmRldmljZVRva2VufHwiIiksZGV2aWNlTmFtZTpTdHJpbmcocmF3Py5kZXZpY2VOYW1lfHxkZWZhdWx0RGV2aWNlTmFtZSgpKSxyb2xlOnJhdz8ucm9sZT09PSJtZW1iZXIiPyJtZW1iZXIiOiJhZG1pbiIscmV2aXNpb246TWF0aC5tYXgoMCxOdW1iZXIocmF3Py5yZXZpc2lvbil8fDApLGRpcnR5OkJvb2xlYW4ocmF3Py5kaXJ0eSksbGFzdFN5bmNBdDpTdHJpbmcocmF3Py5sYXN0U3luY0F0fHwiIiksbGFzdEVycm9yOlN0cmluZyhyYXc/Lmxhc3RFcnJvcnx8IiIpfTt9CiAgZnVuY3Rpb24gc2F2ZVN5bmNTdGF0ZSgpe2xvY2FsU3RvcmFnZS5zZXRJdGVtKFNZTkNfU1RBVEVfS0VZLEpTT04uc3RyaW5naWZ5KHN5bmNTdGF0ZSkpO30KICBmdW5jdGlvbiBzeW5jU2VjcmV0KCl7cmV0dXJuIFN0cmluZyhsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTWU5DX1NFQ1JFVF9LRVkpfHwiIikucmVwbGFjZSgvW14wLTlhLWZdL2dpLCIiKS50b0xvd2VyQ2FzZSgpO30KICBmdW5jdGlvbiBzeW5jQXV0aChleHRyYT17fSl7cmV0dXJuIHt2YXVsdElkOnN5bmNTdGF0ZS52YXVsdElkLGRldmljZUlkOnN5bmNTdGF0ZS5kZXZpY2VJZCxkZXZpY2VUb2tlbjpzeW5jU3RhdGUuZGV2aWNlVG9rZW4sLi4uZXh0cmF9O30KICBhc3luYyBmdW5jdGlvbiBzeW5jQXBpKHBhdGgsYm9keSl7Y29uc3QgcmVzcG9uc2U9YXdhaXQgZmV0Y2goYC9hcGkvc3luYy8ke3BhdGh9YCx7bWV0aG9kOiJQT1NUIixoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiIsImFjY2VwdCI6ImFwcGxpY2F0aW9uL2pzb24ifSxib2R5OkpTT04uc3RyaW5naWZ5KGJvZHkpLGNhY2hlOiJuby1zdG9yZSJ9KTtsZXQgcGF5bG9hZD17fTt0cnl7cGF5bG9hZD1hd2FpdCByZXNwb25zZS5qc29uKCk7fWNhdGNoe31pZighcmVzcG9uc2Uub2spe2NvbnN0IGVycm9yPW5ldyBFcnJvcihwYXlsb2FkLmVycm9yfHxgU3luYy1GZWhsZXIgJHtyZXNwb25zZS5zdGF0dXN9YCk7ZXJyb3Iuc3RhdHVzPXJlc3BvbnNlLnN0YXR1cztlcnJvci5wYXlsb2FkPXBheWxvYWQ7dGhyb3cgZXJyb3I7fXJldHVybiBwYXlsb2FkO30KICBhc3luYyBmdW5jdGlvbiBzeW5jRGVyaXZlS2V5KHJlY292ZXJ5S2V5LHZhdWx0SWQpe2NvbnN0IHJhdz1TdHJpbmcocmVjb3ZlcnlLZXl8fCIiKS5yZXBsYWNlKC9bXjAtOWEtZl0vZ2ksIiIpO2lmKHJhdy5sZW5ndGghPT02NCl0aHJvdyBuZXcgRXJyb3IoIlN5bmMtU2NobMO8c3NlbCBpc3QgdW52b2xsc3TDpG5kaWcuIik7Y29uc3QgYnl0ZXM9bmV3IFVpbnQ4QXJyYXkocmF3Lm1hdGNoKC8uezJ9L2cpLm1hcCh4PT5wYXJzZUludCh4LDE2KSkpO2NvbnN0IGJhc2VLZXk9YXdhaXQgY3J5cHRvLnN1YnRsZS5pbXBvcnRLZXkoInJhdyIsYnl0ZXMsIkhLREYiLGZhbHNlLFsiZGVyaXZlS2V5Il0pO3JldHVybiBjcnlwdG8uc3VidGxlLmRlcml2ZUtleSh7bmFtZToiSEtERiIsaGFzaDoiU0hBLTI1NiIsc2FsdDpuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodmF1bHRJZCksaW5mbzpuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoImVsZGVob2YtcHJpdmF0ZS1zeW5jLXYxIil9LGJhc2VLZXkse25hbWU6IkFFUy1HQ00iLGxlbmd0aDoyNTZ9LGZhbHNlLFsiZW5jcnlwdCIsImRlY3J5cHQiXSk7fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNFbmNyeXB0KHBheWxvYWQscmVjb3ZlcnlLZXksdmF1bHRJZCl7Y29uc3Qga2V5PWF3YWl0IHN5bmNEZXJpdmVLZXkocmVjb3ZlcnlLZXksdmF1bHRJZCksaXY9c3luY1JhbmRvbUJ5dGVzKDEyKSxhYWQ9bmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGAke1NZTkNfRU5WRUxPUEVfU0NIRU1BfToke3ZhdWx0SWR9YCkscGxhaW49bmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKSxjaXBoZXI9YXdhaXQgY3J5cHRvLnN1YnRsZS5lbmNyeXB0KHtuYW1lOiJBRVMtR0NNIixpdixhZGRpdGlvbmFsRGF0YTphYWQsdGFnTGVuZ3RoOjEyOH0sa2V5LHBsYWluKTtyZXR1cm4ge3NjaGVtYTpTWU5DX0VOVkVMT1BFX1NDSEVNQSxhbGdvcml0aG06IkFFUy1HQ00tMjU2L0hLREYtU0hBLTI1NiIsaXY6c3luY0J5dGVzVG9CYXNlNjRVcmwoaXYpLGNpcGhlcnRleHQ6c3luY0J5dGVzVG9CYXNlNjRVcmwobmV3IFVpbnQ4QXJyYXkoY2lwaGVyKSksc2NvcGU6ImZ1bGwiLGNyZWF0ZWRBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkscGF5bG9hZEJ1aWxkOkFQUF9CVUlMRH07fQogIGFzeW5jIGZ1bmN0aW9uIHN5bmNEZWNyeXB0KGVudmVsb3BlLHJlY292ZXJ5S2V5LHZhdWx0SWQpe2lmKGVudmVsb3BlPy5zY2hlbWEhPT1TWU5DX0VOVkVMT1BFX1NDSEVNQSl0aHJvdyBuZXcgRXJyb3IoIlVuYmVrYW5udGVzIFN5bmMtRm9ybWF0LiIpO2NvbnN0IGtleT1hd2FpdCBzeW5jRGVyaXZlS2V5KHJlY292ZXJ5S2V5LHZhdWx0SWQpLGFhZD1uZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoYCR7U1lOQ19FTlZFTE9QRV9TQ0hFTUF9OiR7dmF1bHRJZH1gKTtsZXQgcGxhaW47dHJ5e3BsYWluPWF3YWl0IGNyeXB0by5zdWJ0bGUuZGVjcnlwdCh7bmFtZToiQUVTLUdDTSIsaXY6c3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuaXYpLGFkZGl0aW9uYWxEYXRhOmFhZCx0YWdMZW5ndGg6MTI4fSxrZXksc3luY0Jhc2U2NFVybFRvQnl0ZXMoZW52ZWxvcGUuY2lwaGVydGV4dCkpO31jYXRjaHt0aHJvdyBuZXcgRXJyb3IoIlN5bmMtUGFrZXQga29ubnRlIG5pY2h0IGVudHNjaGzDvHNzZWx0IHdlcmRlbi4iKTt9Y29uc3QgcGF5bG9hZD1KU09OLnBhcnNlKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShwbGFpbikpO2lmKHBheWxvYWQ/LnNjaGVtYSE9PVNZTkNfUEFZTE9BRF9TQ0hFTUEpdGhyb3cgbmV3IEVycm9yKCJTeW5jLVBha2V0IGlzdCBuaWNodCBtaXQgRWxkZWhvZiA2LjIga29tcGF0aWJlbC4iKTtyZXR1cm4gcGF5bG9hZDt9CiAgZnVuY3Rpb24gc3luY1JlbGV2YW50U2V0dGluZ3MoKXtyZXR1cm4ge2ZhbGxiYWNrUHJpY2U6c2V0dGluZ3MuZmFsbGJhY2tQcmljZSxkZWZhdWx0QmFzZUZlZTpzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZSxvc3Ryb21BcHBLZXk6c2V0dGluZ3Mub3N0cm9tQXBwS2V5LG9zdHJvbUF1dG9SZWZyZXNoOnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoLHByZWZlcnJlZFdpbmRvd0hvdXJzOnNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzfTt9CiAgZnVuY3Rpb24gc3luY1BheWxvYWQoKXtyZXR1cm4ge3NjaGVtYTpTWU5DX1BBWUxPQURfU0NIRU1BLGFwcDoiRWxkZWhvZiIsYnVpbGQ6QVBQX0JVSUxELHNjb3BlOiJmdWxsIixleHBvcnRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxzZXR0aW5nc1VwZGF0ZWRBdDpsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTRVRUSU5HU19VUERBVEVEX0tFWSl8fCIiLHNldHRpbmdzOnN5bmNSZWxldmFudFNldHRpbmdzKCkscmVjb3JkcyxtZXRlclJlYWRpbmdzLHZhaWxsYW50TW9udGhzfTt9CiAgZnVuY3Rpb24gbmV3ZXJTdGFtcChpdGVtKXtjb25zdCB2YWx1ZXM9W2l0ZW0/LnVwZGF0ZWRBdCxpdGVtPy5wcmljZVVwZGF0ZWRBdCxpdGVtPy5oZWF0UHVtcFVwZGF0ZWRBdCxpdGVtPy5jbG9zZWRBdF0ubWFwKHY9PkRhdGUucGFyc2Uodnx8IiIpKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTtyZXR1cm4gdmFsdWVzLmxlbmd0aD9NYXRoLm1heCguLi52YWx1ZXMpOjA7fQogIGZ1bmN0aW9uIG1lcmdlQnlLZXkobG9jYWxJdGVtcyxyZW1vdGVJdGVtcyxrZXlGbil7Y29uc3QgbWFwPW5ldyBNYXAoKTtmb3IoY29uc3QgaXRlbSBvZiBBcnJheS5pc0FycmF5KHJlbW90ZUl0ZW1zKT9yZW1vdGVJdGVtczpbXSltYXAuc2V0KGtleUZuKGl0ZW0pLGl0ZW0pO2Zvcihjb25zdCBsb2NhbCBvZiBBcnJheS5pc0FycmF5KGxvY2FsSXRlbXMpP2xvY2FsSXRlbXM6W10pe2NvbnN0IGtleT1rZXlGbihsb2NhbCkscmVtb3RlPW1hcC5nZXQoa2V5KTtpZighcmVtb3RlfHxuZXdlclN0YW1wKGxvY2FsKT5uZXdlclN0YW1wKHJlbW90ZSkpbWFwLnNldChrZXksbG9jYWwpO31yZXR1cm4gWy4uLm1hcC52YWx1ZXMoKV07fQogIGZ1bmN0aW9uIG1lcmdlU3luY1BheWxvYWQobG9jYWwscmVtb3RlKXtjb25zdCBsb2NhbFNldHRpbmdzVGltZT1EYXRlLnBhcnNlKGxvY2FsPy5zZXR0aW5nc1VwZGF0ZWRBdHx8IiIpfHwwLHJlbW90ZVNldHRpbmdzVGltZT1EYXRlLnBhcnNlKHJlbW90ZT8uc2V0dGluZ3NVcGRhdGVkQXR8fCIiKXx8MDtyZXR1cm4ge3NjaGVtYTpTWU5DX1BBWUxPQURfU0NIRU1BLGFwcDoiRWxkZWhvZiIsYnVpbGQ6QVBQX0JVSUxELHNjb3BlOiJmdWxsIixleHBvcnRlZEF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxzZXR0aW5nc1VwZGF0ZWRBdDpsb2NhbFNldHRpbmdzVGltZT5yZW1vdGVTZXR0aW5nc1RpbWU/bG9jYWwuc2V0dGluZ3NVcGRhdGVkQXQ6cmVtb3RlLnNldHRpbmdzVXBkYXRlZEF0LHNldHRpbmdzOmxvY2FsU2V0dGluZ3NUaW1lPnJlbW90ZVNldHRpbmdzVGltZT9sb2NhbC5zZXR0aW5nczpyZW1vdGUuc2V0dGluZ3MscmVjb3JkczptZXJnZUJ5S2V5KGxvY2FsPy5yZWNvcmRzLHJlbW90ZT8ucmVjb3Jkcyx4PT54Lm1vbnRoKSxtZXRlclJlYWRpbmdzOm1lcmdlQnlLZXkobG9jYWw/Lm1ldGVyUmVhZGluZ3MscmVtb3RlPy5tZXRlclJlYWRpbmdzLHg9PnguZGF0ZSkuc29ydCgoYSxiKT0+YS5kYXRlLmxvY2FsZUNvbXBhcmUoYi5kYXRlKSksdmFpbGxhbnRNb250aHM6bWVyZ2VCeUtleShsb2NhbD8udmFpbGxhbnRNb250aHMscmVtb3RlPy52YWlsbGFudE1vbnRocyx4PT54Lm1vbnRoKS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpfTt9CiAgZnVuY3Rpb24gYXBwbHlTeW5jUGF5bG9hZChwYXlsb2FkKXtpZighcGF5bG9hZHx8cGF5bG9hZC5zY2hlbWEhPT1TWU5DX1BBWUxPQURfU0NIRU1BKXRocm93IG5ldyBFcnJvcigiVW5nw7xsdGlnZXIgR2Vyw6R0ZXN0YW5kLiIpO3NhdmVSZWNvcmRzKEFycmF5LmlzQXJyYXkocGF5bG9hZC5yZWNvcmRzKT9wYXlsb2FkLnJlY29yZHM6W10se3JlYXNvbjoiR2Vyw6R0ZS1TeW5jIixhbGxvd0VtcHR5OnRydWUsc2tpcFN5bmM6dHJ1ZX0pO2lmKEFycmF5LmlzQXJyYXkocGF5bG9hZC5tZXRlclJlYWRpbmdzKSlzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3Mse3NraXBTeW5jOnRydWV9KTtpZihBcnJheS5pc0FycmF5KHBheWxvYWQudmFpbGxhbnRNb250aHMpKXt2YWlsbGFudE1vbnRocz1wYXlsb2FkLnZhaWxsYW50TW9udGhzO3NhdmVWYWlsbGFudE1vbnRocyh7c2tpcFN5bmM6dHJ1ZX0pO31pZihwYXlsb2FkLnNldHRpbmdzJiZ0eXBlb2YgcGF5bG9hZC5zZXR0aW5ncz09PSJvYmplY3QiKXtzZXR0aW5ncz17Li4uc2V0dGluZ3MsLi4ucGF5bG9hZC5zZXR0aW5nc307c2F2ZVNldHRpbmdzKHtza2lwU3luYzp0cnVlfSk7aWYocGF5bG9hZC5zZXR0aW5nc1VwZGF0ZWRBdClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTRVRUSU5HU19VUERBVEVEX0tFWSxwYXlsb2FkLnNldHRpbmdzVXBkYXRlZEF0KTt9cmVuZGVyQWxsKCk7c2NoZWR1bGVPc3Ryb20oKTt9CiAgZnVuY3Rpb24gc2NoZWR1bGVDbG91ZFB1c2goKXtpZighc3luY1N0YXRlPy5jb25maWd1cmVkKXJldHVybjtzeW5jU3RhdGUuZGlydHk9dHJ1ZTtzYXZlU3luY1N0YXRlKCk7Y2xlYXJUaW1lb3V0KHN5bmNUaW1lcik7c3luY1RpbWVyPXNldFRpbWVvdXQoKCk9PnN5bmNOb3codHJ1ZSksMTIwMCk7cmVuZGVyU3luY1BhbmVsKCk7fQogIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZUNsb3VkU3luYygpe2lmKHN5bmNCdXN5fHxzeW5jU3RhdGUuY29uZmlndXJlZClyZXR1cm47aWYoIWNvbmZpcm0oIkdlcsOkdGUtU3luYyBlaW5yaWNodGVuPyBWZXJicmF1Y2hzLSwgVmFpbGxhbnQtIHVuZCBPc3Ryb20tRGF0ZW4gd2VyZGVuIHZlcnNjaGzDvHNzZWx0IGluIGRlaW5lbSBiZXN0ZWhlbmRlbiBFbGRlaG9mLVRyZXNvciBnZXNwZWljaGVydC4iKSlyZXR1cm47c3luY0J1c3k9dHJ1ZTtyZW5kZXJTeW5jUGFuZWwoKTt0cnl7Y29uc3QgcmVjb3Zlcnk9c3luY0dlbmVyYXRlUmVjb3ZlcnlLZXkoKSx2YXVsdElkPXN5bmNHZW5lcmF0ZUlkKCJ2YXVsdCIsMTgpLGRldmljZUlkPXN5bmNHZW5lcmF0ZUlkKCJkZXZpY2UiLDE2KSxkZXZpY2VUb2tlbj1zeW5jR2VuZXJhdGVJZCgidG9rZW4iLDMyKSxkZXZpY2VOYW1lPWRlZmF1bHREZXZpY2VOYW1lKCkscGF5bG9hZD1zeW5jUGF5bG9hZCgpLGVudmVsb3BlPWF3YWl0IHN5bmNFbmNyeXB0KHBheWxvYWQscmVjb3ZlcnksdmF1bHRJZCkscmVzdWx0PWF3YWl0IHN5bmNBcGkoInZhdWx0L2NyZWF0ZSIse3ZhdWx0SWQsZGV2aWNlSWQsZGV2aWNlTmFtZSxkZXZpY2VUb2tlbixzY29wZToiZnVsbCIsZW52ZWxvcGV9KTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTWU5DX1NFQ1JFVF9LRVkscmVjb3ZlcnkpO3N5bmNTdGF0ZT17Y29uZmlndXJlZDp0cnVlLHZhdWx0SWQsZGV2aWNlSWQsZGV2aWNlVG9rZW4sZGV2aWNlTmFtZSxyb2xlOiJhZG1pbiIscmV2aXNpb246TnVtYmVyKHJlc3VsdC5yZXZpc2lvbil8fDEsZGlydHk6ZmFsc2UsbGFzdFN5bmNBdDpuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksbGFzdEVycm9yOiIifTtzYXZlU3luY1N0YXRlKCk7dG9hc3QoIkdlcsOkdGUtU3luYyBlaW5nZXJpY2h0ZXQiKTt9Y2F0Y2goZXJyb3Ipe3N5bmNTdGF0ZS5sYXN0RXJyb3I9ZXJyb3IubWVzc2FnZTtzYXZlU3luY1N0YXRlKCk7YWxlcnQoYEdlcsOkdGUtU3luYyBrb25udGUgbmljaHQgZWluZ2VyaWNodGV0IHdlcmRlbjogJHtlcnJvci5tZXNzYWdlfWApO31maW5hbGx5e3N5bmNCdXN5PWZhbHNlO3JlbmRlclN5bmNQYW5lbCgpO319CiAgZnVuY3Rpb24gcGFpcmluZ0J1bmRsZUVuY29kZSh2YWx1ZSl7cmV0dXJuIHN5bmNCeXRlc1RvQmFzZTY0VXJsKG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShKU09OLnN0cmluZ2lmeSh2YWx1ZSkpKTt9CiAgZnVuY3Rpb24gcGFpcmluZ0J1bmRsZURlY29kZSh2YWx1ZSl7Y29uc3QgdGV4dD1uZXcgVGV4dERlY29kZXIoKS5kZWNvZGUoc3luY0Jhc2U2NFVybFRvQnl0ZXMoU3RyaW5nKHZhbHVlfHwiIikudHJpbSgpKSk7cmV0dXJuIEpTT04ucGFyc2UodGV4dCk7fQogIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZURldmljZVBhaXJpbmcoKXtpZihzeW5jQnVzeXx8IXN5bmNTdGF0ZS5jb25maWd1cmVkKXJldHVybjtzeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtjb25zdCByZXN1bHQ9YXdhaXQgc3luY0FwaSgicGFpci9jcmVhdGUiLHN5bmNBdXRoKHtzY29wZToiZnVsbCJ9KSk7Y29uc3QgYnVuZGxlPXBhaXJpbmdCdW5kbGVFbmNvZGUoe3Y6MSx2YXVsdElkOnN5bmNTdGF0ZS52YXVsdElkLGNvZGU6cmVzdWx0LmNvZGUscmVjb3Zlcnk6c3luY1NlY3JldCgpfSk7JCgic3luY1BhaXJCdW5kbGUiKS52YWx1ZT1idW5kbGU7JCgic3luY1BhaXJSZXN1bHQiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTtzZXRTdGF0dXMoInN5bmNTdGF0dXMiLGBLb3BwbHVuZ3Njb2RlIGfDvGx0aWcgYmlzICR7bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCIsbWludXRlOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZShyZXN1bHQuZXhwaXJlc0F0KSl9LmAsIm9rIik7fWNhdGNoKGVycm9yKXtzZXRTdGF0dXMoInN5bmNTdGF0dXMiLGVycm9yLm1lc3NhZ2UsImVycm9yIik7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBhc3luYyBmdW5jdGlvbiBjb3B5UGFpckJ1bmRsZSgpe2NvbnN0IHZhbHVlPSQoInN5bmNQYWlyQnVuZGxlIikudmFsdWU7aWYoIXZhbHVlKXJldHVybjt0cnl7YXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQodmFsdWUpO3RvYXN0KCJLb3BwbHVuZ3NzY2hsw7xzc2VsIGtvcGllcnQiKTt9Y2F0Y2h7JCgic3luY1BhaXJCdW5kbGUiKS5zZWxlY3QoKTtkb2N1bWVudC5leGVjQ29tbWFuZCgiY29weSIpO3RvYXN0KCJLb3BwbHVuZ3NzY2hsw7xzc2VsIGtvcGllcnQiKTt9fQogIGFzeW5jIGZ1bmN0aW9uIGpvaW5DbG91ZFN5bmMoKXtpZihzeW5jQnVzeXx8c3luY1N0YXRlLmNvbmZpZ3VyZWQpcmV0dXJuO2xldCBidW5kbGU7dHJ5e2J1bmRsZT1wYWlyaW5nQnVuZGxlRGVjb2RlKCQoInN5bmNKb2luQnVuZGxlIikudmFsdWUpO31jYXRjaHtzZXRTdGF0dXMoInN5bmNTdGF0dXMiLCJLb3BwbHVuZ3NzY2hsw7xzc2VsIGlzdCB1bmfDvGx0aWcuIiwiZXJyb3IiKTtyZXR1cm47fWlmKCFidW5kbGU/LnZhdWx0SWR8fCFidW5kbGU/LmNvZGV8fFN0cmluZyhidW5kbGU/LnJlY292ZXJ5fHwiIikubGVuZ3RoIT09NjQpe3NldFN0YXR1cygic3luY1N0YXR1cyIsIktvcHBsdW5nc3NjaGzDvHNzZWwgaXN0IHVudm9sbHN0w6RuZGlnLiIsImVycm9yIik7cmV0dXJuO31zeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtjb25zdCBkZXZpY2VJZD1zeW5jR2VuZXJhdGVJZCgiZGV2aWNlIiwxNiksZGV2aWNlVG9rZW49c3luY0dlbmVyYXRlSWQoInRva2VuIiwzMiksZGV2aWNlTmFtZT1kZWZhdWx0RGV2aWNlTmFtZSgpLGNsYWltPWF3YWl0IHN5bmNBcGkoInBhaXIvY2xhaW0iLHt2YXVsdElkOmJ1bmRsZS52YXVsdElkLGNvZGU6YnVuZGxlLmNvZGUsZGV2aWNlSWQsZGV2aWNlTmFtZSxkZXZpY2VUb2tlbn0pO2xvY2FsU3RvcmFnZS5zZXRJdGVtKFNZTkNfU0VDUkVUX0tFWSxidW5kbGUucmVjb3ZlcnkpO3N5bmNTdGF0ZT17Y29uZmlndXJlZDp0cnVlLHZhdWx0SWQ6YnVuZGxlLnZhdWx0SWQsZGV2aWNlSWQsZGV2aWNlVG9rZW4sZGV2aWNlTmFtZSxyb2xlOmNsYWltLnJvbGV8fCJtZW1iZXIiLHJldmlzaW9uOjAsZGlydHk6ZmFsc2UsbGFzdFN5bmNBdDoiIixsYXN0RXJyb3I6IiJ9O3NhdmVTeW5jU3RhdGUoKTthd2FpdCBzeW5jTm93KGZhbHNlKTskKCJzeW5jSm9pbkJ1bmRsZSIpLnZhbHVlPSIiO3RvYXN0KCJHZXLDpHQgZ2Vrb3BwZWx0Iik7fWNhdGNoKGVycm9yKXtsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShTWU5DX1NFQ1JFVF9LRVkpO3N5bmNTdGF0ZT1sb2FkU3luY1N0YXRlKCk7c3luY1N0YXRlLmNvbmZpZ3VyZWQ9ZmFsc2U7c3luY1N0YXRlLmxhc3RFcnJvcj1lcnJvci5tZXNzYWdlO3NhdmVTeW5jU3RhdGUoKTtzZXRTdGF0dXMoInN5bmNTdGF0dXMiLGVycm9yLm1lc3NhZ2UsImVycm9yIik7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBhc3luYyBmdW5jdGlvbiBzeW5jTm93KHF1aWV0PWZhbHNlKXtpZihzeW5jQnVzeXx8IXN5bmNTdGF0ZS5jb25maWd1cmVkfHwhc3luY1NlY3JldCgpKXJldHVybiBmYWxzZTtzeW5jQnVzeT10cnVlO3JlbmRlclN5bmNQYW5lbCgpO3RyeXtjb25zdCBsb2NhbEJlZm9yZT1zeW5jUGF5bG9hZCgpLHdhc0RpcnR5PXN5bmNTdGF0ZS5kaXJ0eSxyZW1vdGU9YXdhaXQgc3luY0FwaSgic25hcHNob3QvcHVsbCIsc3luY0F1dGgoKSkscmVtb3RlUGF5bG9hZD1hd2FpdCBzeW5jRGVjcnlwdChyZW1vdGUuc25hcHNob3QuZW52ZWxvcGUsc3luY1NlY3JldCgpLHN5bmNTdGF0ZS52YXVsdElkKTtsZXQgY2FuZGlkYXRlPWxvY2FsQmVmb3JlO2lmKE51bWJlcihyZW1vdGUucmV2aXNpb24pPk51bWJlcihzeW5jU3RhdGUucmV2aXNpb24pKXtjYW5kaWRhdGU9d2FzRGlydHk/bWVyZ2VTeW5jUGF5bG9hZChsb2NhbEJlZm9yZSxyZW1vdGVQYXlsb2FkKTpyZW1vdGVQYXlsb2FkO2FwcGx5U3luY1BheWxvYWQoY2FuZGlkYXRlKTtzeW5jU3RhdGUucmV2aXNpb249TnVtYmVyKHJlbW90ZS5yZXZpc2lvbil8fHN5bmNTdGF0ZS5yZXZpc2lvbjt9aWYod2FzRGlydHkpe2NvbnN0IGVudmVsb3BlPWF3YWl0IHN5bmNFbmNyeXB0KGNhbmRpZGF0ZSxzeW5jU2VjcmV0KCksc3luY1N0YXRlLnZhdWx0SWQpO2xldCBwdXNoZWQ7dHJ5e3B1c2hlZD1hd2FpdCBzeW5jQXBpKCJzbmFwc2hvdC9wdXNoIixzeW5jQXV0aCh7YmFzZVJldmlzaW9uOnN5bmNTdGF0ZS5yZXZpc2lvbixlbnZlbG9wZX0pKTt9Y2F0Y2goZXJyb3Ipe2lmKGVycm9yLnN0YXR1cz09PTQwOSl7Y29uc3QgbGF0ZXN0PWF3YWl0IHN5bmNBcGkoInNuYXBzaG90L3B1bGwiLHN5bmNBdXRoKCkpLGxhdGVzdFBheWxvYWQ9YXdhaXQgc3luY0RlY3J5cHQobGF0ZXN0LnNuYXBzaG90LmVudmVsb3BlLHN5bmNTZWNyZXQoKSxzeW5jU3RhdGUudmF1bHRJZCksbWVyZ2VkPW1lcmdlU3luY1BheWxvYWQoY2FuZGlkYXRlLGxhdGVzdFBheWxvYWQpO2FwcGx5U3luY1BheWxvYWQobWVyZ2VkKTtjb25zdCByZXRyeUVudmVsb3BlPWF3YWl0IHN5bmNFbmNyeXB0KG1lcmdlZCxzeW5jU2VjcmV0KCksc3luY1N0YXRlLnZhdWx0SWQpO3B1c2hlZD1hd2FpdCBzeW5jQXBpKCJzbmFwc2hvdC9wdXNoIixzeW5jQXV0aCh7YmFzZVJldmlzaW9uOmxhdGVzdC5yZXZpc2lvbixlbnZlbG9wZTpyZXRyeUVudmVsb3BlfSkpO31lbHNlIHRocm93IGVycm9yO31zeW5jU3RhdGUucmV2aXNpb249TnVtYmVyKHB1c2hlZC5yZXZpc2lvbil8fHN5bmNTdGF0ZS5yZXZpc2lvbjtzeW5jU3RhdGUuZGlydHk9ZmFsc2U7fXN5bmNTdGF0ZS5sYXN0U3luY0F0PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtzeW5jU3RhdGUubGFzdEVycm9yPSIiO3NhdmVTeW5jU3RhdGUoKTtyZW5kZXJBbGwoKTtpZighcXVpZXQpdG9hc3QoIkFsbGUgR2Vyw6R0ZSBzeW5jaHJvbmlzaWVydCIpO3JldHVybiB0cnVlO31jYXRjaChlcnJvcil7c3luY1N0YXRlLmxhc3RFcnJvcj1lcnJvci5tZXNzYWdlO3NhdmVTeW5jU3RhdGUoKTtyZW5kZXJTeW5jUGFuZWwoKTtpZighcXVpZXQpdG9hc3QoYFN5bmM6ICR7ZXJyb3IubWVzc2FnZX1gKTtyZXR1cm4gZmFsc2U7fWZpbmFsbHl7c3luY0J1c3k9ZmFsc2U7cmVuZGVyU3luY1BhbmVsKCk7fX0KICBmdW5jdGlvbiByZW5kZXJTeW5jUGFuZWwoKXtpZighJCgiZGV2aWNlU3luY1BhbmVsIikpcmV0dXJuO2NvbnN0IGNvbmZpZ3VyZWQ9Qm9vbGVhbihzeW5jU3RhdGUuY29uZmlndXJlZCk7JCgic3luY1NldHVwQXJlYSIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsY29uZmlndXJlZCk7JCgic3luY0FjdGl2ZUFyZWEiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFjb25maWd1cmVkKTtpZihjb25maWd1cmVkKXskKCJzeW5jRGV2aWNlTmFtZSIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5kZXZpY2VOYW1lfHwiR2Vyw6R0IjskKCJzeW5jUm9sZSIpLnRleHRDb250ZW50PXN5bmNTdGF0ZS5yb2xlPT09ImFkbWluIj8iSGF1cHRnZXLDpHQiOiJnZWtvcHBlbHQiOyQoImNyZWF0ZVBhaXJCdG4iKS5kaXNhYmxlZD1zeW5jQnVzeXx8c3luY1N0YXRlLnJvbGUhPT0iYWRtaW4iOyQoInN5bmNOb3dCdG4iKS5kaXNhYmxlZD1zeW5jQnVzeTtjb25zdCBsYXN0PXN5bmNTdGF0ZS5sYXN0U3luY0F0P25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2RhdGVTdHlsZToic2hvcnQiLHRpbWVTdHlsZToic2hvcnQifSkuZm9ybWF0KG5ldyBEYXRlKHN5bmNTdGF0ZS5sYXN0U3luY0F0KSk6Im5vY2ggbmllIjtzZXRTdGF0dXMoInN5bmNTdGF0dXMiLHN5bmNTdGF0ZS5sYXN0RXJyb3I/YEZlaGxlcjogJHtzeW5jU3RhdGUubGFzdEVycm9yfWA6YEF1dG9tYXRpc2NoIGFrdGl2IMK3IHp1bGV0enQgJHtsYXN0fSR7c3luY1N0YXRlLmRpcnR5PyIgwrcgw4RuZGVydW5nIHdhcnRldCI6IiJ9YCxzeW5jU3RhdGUubGFzdEVycm9yPyJlcnJvciI6Im9rIik7fWVsc2Ugc2V0U3RhdHVzKCJzeW5jU3RhdHVzIiwiTm9jaCBuaWNodCBlaW5nZXJpY2h0ZXQuIEF1ZiBlaW5lbSBHZXLDpHQgZWlubWFsIGVpbnJpY2h0ZW4sIHdlaXRlcmUgR2Vyw6R0ZSBkYW5hY2gga29wcGVsbi4iKTt9CiAgZnVuY3Rpb24gc3RhcnRTeW5jUG9sbGluZygpe2NsZWFySW50ZXJ2YWwoc3luY1BvbGxUaW1lcik7c3luY1BvbGxUaW1lcj1udWxsO2lmKHN5bmNTdGF0ZS5jb25maWd1cmVkKXN5bmNQb2xsVGltZXI9c2V0SW50ZXJ2YWwoKCk9PntpZighZG9jdW1lbnQuaGlkZGVuKXN5bmNOb3codHJ1ZSk7fSw2MCoxMDAwKTt9CgogIGZ1bmN0aW9uIHJlbmRlckFsbCgpeyB1cGRhdGVSZWNvdmVyeUJhbm5lcigpO3JlbmRlckRhc2hib2FyZCgpO3JlbmRlclJlY29yZHMoKTtyZW5kZXJBbmFseXNpcygpO3JlbmRlckRhdGEoKTtyZW5kZXJTeW5jUGFuZWwoKTsgfQogIGZ1bmN0aW9uIHJlc2l6ZUNoYXJ0cygpeyBjbGVhclRpbWVvdXQocmVzaXplVGltZXIpO3Jlc2l6ZVRpbWVyPXNldFRpbWVvdXQoKCk9PnsgaWYoY3VycmVudFZpZXc9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7IGlmKGN1cnJlbnRWaWV3PT09ImFuYWx5c2lzVmlldyIpcmVuZGVyQW5hbHlzaXMoKTsgfSwxMDApOyB9CgogIGZ1bmN0aW9uIGJpbmQoKXsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixldmVudD0+ewogICAgICBjb25zdCBuYXY9ZXZlbnQudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLW5hdl0iKTsgaWYobmF2KXtzd2l0Y2hWaWV3KG5hdi5kYXRhc2V0Lm5hdik7cmV0dXJuO30KICAgICAgY29uc3QgZWRpdD1ldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtZWRpdC1tb250aF0iKTsgaWYoZWRpdCl7b3BlblJlY29yZE1vZGFsKGVkaXQuZGF0YXNldC5lZGl0TW9udGgpO3JldHVybjt9CiAgICAgIGlmKGV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1jbG9zZS1yZWNvcmQtbW9kYWxdIikpe2Nsb3NlUmVjb3JkTW9kYWwoKTtyZXR1cm47fQogICAgICBpZihldmVudC50YXJnZXQuY2xvc2VzdCgiW2RhdGEtY2xvc2UtbWV0ZXItbW9kYWxdIikpe2Nsb3NlTWV0ZXJNb2RhbCgpO3JldHVybjt9CiAgICB9KTsKICAgICQoImRhc2hib2FyZEFkZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZFJlY29yZEJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixvcGVuTWV0ZXJNb2RhbCk7ICQoImFkZE1ldGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLG9wZW5NZXRlck1vZGFsKTsKICAgICQoImVkaXRMYXRlc3RCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pm9wZW5SZWNvcmRNb2RhbCgkKCJlZGl0TGF0ZXN0QnRuIikuZGF0YXNldC5tb250aCkpOwogICAgJCgicmVjb3JkRm9ybSIpLmFkZEV2ZW50TGlzdGVuZXIoInN1Ym1pdCIsc2F2ZUVkaXRlZFJlY29yZCk7IFsicmVjb3JkVG90YWwiLCJyZWNvcmRIZWF0UHVtcCIsInJlY29yZEFubmV4Il0uZm9yRWFjaChpZD0+JChpZCkuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLHVwZGF0ZURlcml2ZWRQcmV2aWV3KSk7CiAgICAkKCJtZXRlckZvcm0iKS5hZGRFdmVudExpc3RlbmVyKCJzdWJtaXQiLHNhdmVNZXRlclJlYWRpbmdGcm9tRm9ybSk7IFsibWV0ZXJEYXRlIiwibWV0ZXJUb3RhbCIsIm1ldGVyQW5uZXgiXS5mb3JFYWNoKGlkPT4kKGlkKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsdXBkYXRlTWV0ZXJQcmV2aWV3KSk7CiAgICAkKCJ1bmRvTGF0ZXN0TWV0ZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsdW5kb0xhdGVzdE1ldGVyUmVhZGluZyk7CiAgICAkKCJyZWNvcmRZZWFyRmlsdGVyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJSZWNvcmRzKTsgJCgiYW5hbHlzaXNZZWFyIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIixyZW5kZXJBbmFseXNpcyk7CiAgICAkKCJyZXN0b3JlU2hhZG93QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHJlc3RvcmVTaGFkb3cpOyAkKCJleHBvcnRCYWNrdXBCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXhwb3J0QmFja3VwKTsgJCgiZXhwb3J0Q3N2QnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV4cG9ydENzdik7ICQoImltcG9ydEJhY2t1cElucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+e2NvbnN0IGY9JCgiaW1wb3J0QmFja3VwSW5wdXQiKS5maWxlcz8uWzBdO2lmKGYpaW1wb3J0QmFja3VwKGYpO30pOwogICAgJCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwoKT0+aW1wb3J0VmFpbGxhbnRDc3ZGaWxlcygkKCJ2YWlsbGFudENzdkZpbGVzSW5wdXQiKS5maWxlcykpOwogICAgJCgic2F2ZU9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQW5kQ2hlY2tPc3Ryb20pOyAkKCJkaXNjb25uZWN0T3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGRpc2Nvbm5lY3RPc3Ryb20pOyAkKCJyZWZyZXNoT3N0cm9tQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT5yZWZyZXNoT3N0cm9tKHRydWUpKTsgJCgic3luY09zdHJvbUhpc3RvcnlCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PnJlZnJlc2hPc3Ryb21IaXN0b3J5KHtmb3JjZTp0cnVlLHNob3dUb2FzdDp0cnVlfSkpOyAkKCJnb09zdHJvbVNldHRpbmdzQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCgpPT57c3dpdGNoVmlldygiZGF0YVZpZXciKTtzZXRUaW1lb3V0KCgpPT4kKCJvc3Ryb21TZXR0aW5nc1BhbmVsIikuc2Nyb2xsSW50b1ZpZXcoe2JlaGF2aW9yOiJzbW9vdGgiLGJsb2NrOiJzdGFydCJ9KSwxMDApO30pOwogICAgJCgic2F2ZUNvc3RTZXR0aW5nc0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixzYXZlQ29zdFNldHRpbmdzKTsKICAgICQoImNyZWF0ZVN5bmNCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsY3JlYXRlQ2xvdWRTeW5jKTsgJCgiam9pblN5bmNCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsam9pbkNsb3VkU3luYyk7ICQoInN5bmNOb3dCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9PnN5bmNOb3coZmFsc2UpKTsgJCgiY3JlYXRlUGFpckJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixjcmVhdGVEZXZpY2VQYWlyaW5nKTsgJCgiY29weVBhaXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsY29weVBhaXJCdW5kbGUpOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInJlc2l6ZSIscmVzaXplQ2hhcnRzKTsgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigidmlzaWJpbGl0eWNoYW5nZSIsKCk9PntpZighZG9jdW1lbnQuaGlkZGVuKXtpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe2NvbnN0IGFnZT1EYXRlLm5vdygpLURhdGUucGFyc2Uob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKTtpZighTnVtYmVyLmlzRmluaXRlKGFnZSl8fGFnZT4xMCo2MGUzKXJlZnJlc2hPc3Ryb20oZmFsc2UpO31pZihzeW5jU3RhdGUuY29uZmlndXJlZClzeW5jTm93KHRydWUpO319KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24iLGV2ZW50PT57aWYoZXZlbnQua2V5IT09IkVzY2FwZSIpcmV0dXJuO2lmKCEkKCJyZWNvcmRNb2RhbCIpLmNsYXNzTGlzdC5jb250YWlucygiaGlkZGVuIikpY2xvc2VSZWNvcmRNb2RhbCgpO2Vsc2UgaWYoISQoIm1ldGVyTW9kYWwiKS5jbGFzc0xpc3QuY29udGFpbnMoImhpZGRlbiIpKWNsb3NlTWV0ZXJNb2RhbCgpO30pOwogIH0KCiAgZnVuY3Rpb24gaW5pdCgpewogICAgYXBwbHlIaXN0b3JpY2FsU2VlZCgpO2Vuc3VyZU1ldGVyQmFzZWxpbmUoKTsKICAgIGJpbmQoKTtyZW5kZXJBbGwoKTtzY2hlZHVsZU9zdHJvbSgpO3N0YXJ0U3luY1BvbGxpbmcoKTsKICAgIHNldFRpbWVvdXQoYXN5bmMoKT0+e2lmKHN5bmNTdGF0ZS5jb25maWd1cmVkKWF3YWl0IHN5bmNOb3codHJ1ZSk7aWYoc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXsgY29uc3QgYWdlPURhdGUubm93KCktRGF0ZS5wYXJzZShvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdHx8IiIpOyBpZighb3N0cm9tTGl2ZXx8IU51bWJlci5pc0Zpbml0ZShhZ2UpfHxhZ2U+MTAqNjBlMylyZWZyZXNoT3N0cm9tKGZhbHNlKTsgc2NoZWR1bGVPc3Ryb21IaXN0b3J5KCk7IH19LDM1MCk7CiAgICBpZigic2VydmljZVdvcmtlciIgaW4gbmF2aWdhdG9yKXdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJsb2FkIiwoKT0+bmF2aWdhdG9yLnNlcnZpY2VXb3JrZXIucmVnaXN0ZXIoInN3LmpzP3Y9Ni4yLjAiKS5jYXRjaCgoKT0+e30pKTsKICAgIGNvbnNvbGUuaW5mbyhgRWxkZWhvZiAke0FQUF9CVUlMRH1gKTsKICB9CiAgaW5pdCgpOwp9KSgpOwo=","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/sw.js":{"body":"Y29uc3QgQ0FDSEU9ImVsZGVob2YtdjYtMi0wLXN5bmMtY29tcGFyZS1vc3Ryb20tMjAyNjEwMDUiOwpjb25zdCBDT1JFPVsiLi8iLCIuLz92PTYuMi4wIiwiLi9pbmRleC5odG1sIiwiLi9zdHlsZXMuY3NzP3Y9Ni4yLjAiLCIuL2FwcC5qcz92PTYuMi4wIiwiLi9tYW5pZmVzdC53ZWJtYW5pZmVzdCIsIi4vaWNvbi0xOTIucG5nIiwiLi9pY29uLTUxMi5wbmciXTsKc2VsZi5hZGRFdmVudExpc3RlbmVyKCJpbnN0YWxsIixldmVudD0+e2V2ZW50LndhaXRVbnRpbChjYWNoZXMub3BlbihDQUNIRSkudGhlbihjPT5jLmFkZEFsbChDT1JFKSkudGhlbigoKT0+c2VsZi5za2lwV2FpdGluZygpKSl9KTsKc2VsZi5hZGRFdmVudExpc3RlbmVyKCJhY3RpdmF0ZSIsZXZlbnQ9PntldmVudC53YWl0VW50aWwoY2FjaGVzLmtleXMoKS50aGVuKGtleXM9PlByb21pc2UuYWxsKGtleXMuZmlsdGVyKGs9PmshPT1DQUNIRSkubWFwKGs9PmNhY2hlcy5kZWxldGUoaykpKSkudGhlbigoKT0+c2VsZi5jbGllbnRzLmNsYWltKCkpKX0pOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImZldGNoIixldmVudD0+ewogIGNvbnN0IHVybD1uZXcgVVJMKGV2ZW50LnJlcXVlc3QudXJsKTsKICBpZihldmVudC5yZXF1ZXN0Lm1ldGhvZCE9PSJHRVQifHx1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgiL2FwaS8iKSlyZXR1cm47CiAgZXZlbnQucmVzcG9uZFdpdGgoZmV0Y2goZXZlbnQucmVxdWVzdCkudGhlbihyZXNwb25zZT0+e2NvbnN0IGNvcHk9cmVzcG9uc2UuY2xvbmUoKTtjYWNoZXMub3BlbihDQUNIRSkudGhlbihjPT5jLnB1dChldmVudC5yZXF1ZXN0LGNvcHkpKTtyZXR1cm4gcmVzcG9uc2U7fSkuY2F0Y2goKCk9PmNhY2hlcy5tYXRjaChldmVudC5yZXF1ZXN0KS50aGVuKGNhY2hlZD0+Y2FjaGVkfHxjYWNoZXMubWF0Y2goIi4vaW5kZXguaHRtbCIpKSkpOwp9KTsK","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/manifest.webmanifest":{"body":"ewogICJuYW1lIjogIkVsZGVob2YgNi4yLjAg4oCTIFZlcmJyYXVjaHNidWNoIiwKICAic2hvcnRfbmFtZSI6ICJFbGRlaG9mIiwKICAiZGVzY3JpcHRpb24iOiAiU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4g4oCTIG1pdCBrb21wYWt0ZXIgT3N0cm9tLVByZWlzw7xiZXJzaWNodC4iLAogICJzdGFydF91cmwiOiAiLi8/dj02LjIuMCIsCiAgInNjb3BlIjogIi4vIiwKICAiZGlzcGxheSI6ICJzdGFuZGFsb25lIiwKICAib3JpZW50YXRpb24iOiAicG9ydHJhaXQtcHJpbWFyeSIsCiAgImJhY2tncm91bmRfY29sb3IiOiAiIzA2MTAxYyIsCiAgInRoZW1lX2NvbG9yIjogIiMwNzExMWYiLAogICJpY29ucyI6IFsKICAgIHsic3JjIjoiaWNvbi0xOTIucG5nIiwic2l6ZXMiOiIxOTJ4MTkyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifSwKICAgIHsic3JjIjoiaWNvbi01MTIucG5nIiwic2l6ZXMiOiI1MTJ4NTEyIiwidHlwZSI6ImltYWdlL3BuZyIsInB1cnBvc2UiOiJhbnkgbWFza2FibGUifQogIF0KfQo=","type":"application/manifest+json; charset=utf-8","cache":"no-cache"},"/icon-192.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFk0lEQVR42u3du24TQRiG4fVoBShpkKJ0hi6iTEqKKAURJbdASZcqN5AbSJWOkkuAEoUiSkFLSW/RWC6RKFxQWFrlZO96ZnbmP7xfGeWwh8ffzOx6ncnOwVFDbGU5XxT7W4HDbS/t/h6AiI4AiBICEKGBiNISAhCGAEQYwojSEgIQARCpV0IAIgAi9UoIQARApF4JAYgAiNQrIQARABEAEaWjGIAIgEi9EgIQSeOobotPLqe2T8nN+UzR1k7kPxdmXkwVTLmeHZMLaJ2b27OZYTHHV9MykiwDekzHNpqtPOWSZBPQXTpu0QyRlIVRFkNSAEEnQlIiIyOAoFOLkQVAnR7opDCKM6QbEHQkVFG6oTqA0COkitIBBfQYSHcky190Ld1Aqz2EzqhVNLyHlDUQespU0fAeSr8zH9Dj3JAOQOixaiigB0OiAaHHtqFQQA+pm81nIXEeHYq9FEitEtLaQAxeHgaygB4MKVjGE6sZBRD146eEaCAiDBD146qEaCCSdCkoMyDqx1sJ0UBEDCCT9fPp+g0lRAMl6TFmiEl0he7B0NoJeN7xy/Cwtfri59PfNvbx5HKa5fnozA1kYAK0uWwMVFHec8QQtrUPhjMApcrAEIBSTWAoJyDtV4DiNNz9qT9fD9VNg7Kse1rnL6DEIjG2NGMIK6pHaf0ASJYe5kDoScrF3xeeRQb00GoAqnaOu/pxa6iFzkh/yMnSLKAnY/04rKKAHhZ6KZ9TFtAzRv346aGAHnoIQKXP3MD68WCohQ5LMxqoqJ5t68d2FQX0sIUAKnduUurHpKGAHudbm/hh9QE9hevHWA+10GFp5reBSurJWz9mXgMBPeyLR0CFj/h49VPXUPq/e2rRUx3Zxe6/br/UzYcCeurWT6dH6VjWQqdmad3Xo3FpFtBTffaj+tUS0COqftTtdUBPlfrp1aPFUECPwO5RdAQCegrXz1Z65BtqoaNoFihwaRbQI7x+hL+uAnpkTn20HB9xQ9iQlpb8rudEPdzKIGN1D5Noy+d7Q2kZ1kMDiZ5xA4gYrx9rQ9jV2+/Dv/ns5/ux62fv9FuZbaCBSuuJ+P5t06unwDYASOvsZ4ge5kCEAIj6AZCouNIDoMz1400PgLKSsn7JB0Cjz34ARKif7cLN1HsZcmVvcf0BPTRQpJ4nJ84GLigDqJCeB/XTLbvcGgIQAVBUIu6Er6ufktsAIBEg0s/ck3oKbwOrsPqlElc/G7rHBguGsBHj8H4FgLLVD3oARABE/QCIqQ+AHNUPegBE9wCo3uyHAIj6AVDx+kEPgOgeABEAEQARAiACIAIgAiBCsgM6vppyQFVkdaZ+fPwlBdDN+azk/qv+R+vG9oshjLgEZK+ElO5R4Iivkvg4TuKP6309THYOjnL9rpPLadM0t2ezwvuQ8X+vxD3inqKnPJ2MM+jGxoOFGc/B893XjKfbDWHL+YKZIEmaAy3niyyMVot5rgZJTt7x694kmioiqaswDJHUZXzicMYo5mr8atZdB6KKSBKglCqihPzUT9N7JZoqIkmA4qqIEnJSP83we2FxVYQhOXqqNVBcFRV+hxDpzRj100TcjR/OiIHM9uAVCSiijTBkVU+T+H6gXkYMZFanPnkADWHEQGZy6pMTUC8jDJkcvFaZPHv5aozf2+7vPfhKrfcrokdHA/UWEj1kT8+IDbSukOihArPmYnrKAboraWUIRgb0NOUf61nOF90eMpxp11Ohgbq8+3JID6mmUxkQjAzoqQ/oriEYRdCpq0cEIBgppSMLEIyGuxFCRyKgx4ycY3q8UJVDRy6gdYw8YFp3aUOaGwWAeiV5iFg3mgC58iRfjHpARFT4jEQCIAIgAiACIEIARABEAEQARAiACIAIgAiACAEQARABEAEQIQAiACIAIgAibvMfGKe/xgpKwHYAAAAASUVORK5CYII=","type":"image/png","cache":"public, max-age=31536000, immutable"},"/icon-512.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAPpUlEQVR42u3dvW5UVxcG4OORFUWkiYToSIkooaRAFEEucwsp6VxxA9wAlTvKXEJSIlIgCtqU9CiN5TJSChcpiCw09gwz4/Oz93qfp8ynLzFnznnftc62zdGdB48HgIouzy9chC1WLgGAAgAo5fjeXRdBAQCgAABLAAoA0AEKAAAFAGAJUAAAOkABAKAAACwBCgAABQBgCVAAACgAAEuAAgDQAQoAAAUAYAlQAAAoAABLgAIAQAEAWAIUAAAKAMASoAAAUAAAlgAFAKADFAAACgAgfglQAAA2AABLgAIAQAEAoAAAqot6C6QAAGwAACQtAQoAwAYAQNISoAAAbAAAJC0BCgDABgBA0hKgAABsAAAoAACG6m+BFACADQCApCVAAQDYAABIWgIUAIANAAAFAMDXSr4FUgAANgAAFAAAa+q9BVIAADYAAJKWAAUAYAMAQAEAcKNKb4EUAEBqmbkEIZ69vu8isKP3Lz+7CAmO7jx47CrIelAMe7k8v1AAiHv0gQJQAAh9lIECUADIfZSBDlAACH00gQJQACyd+x9OneCxk6dnI99+JZtAAdBi9At6mm2FYk3QewcogAq5L/HprhJqNIECYJnoF/oUKIPea0ABMF/0C31KNkHXNdB1BygAuQ9NlEGnNaAAmCT65T5qQAEogLj0F/2EN0FfNdBvByiAhqJf7qMJeqwBBYDoh9AaUACIfpiqBhrvAAXA3ukv+qFMDXTaAQpA9IMaUABMn/6iH25fAw12gAIQ/aIfcmugxw5QAJOnv+iHhA5QANJf+sOsNdBOBygA0S/6IbQGeiyAlRtL+kP7tj9TLfzNqcf37toA0tNf9MNSq8Die0B3S4ACMPiDDlAASH/ovwMWrAEFkJj+oh+sAj12gENg6Q+92vL0tXAsrACkP6ADGuUV0IHpL/qhHe28C+rrFZACkP5QvAbm7ABnANIfWMCmZ3POd0F9/TiYApD+oANCKQDpDzpAASD9QQcoAOkv/UEHKADpL/1BB+yho3NgBSD9QQfYAKS/9IeYDkABuG8g9Fm2BCiAjfeB9AcdoACkP5CVALfXyznwymcPxC4B4TngFZDxHzzdCsD47/6AyA6IXQJCC0D6gw7QAYkF4NU/IBkGZwDGf/C8T6GLbwSKKwAvf4DBi6DAApD+gA7I3QAAiCsA4z9gCUgsAOkP6IDcDQCAuAIw/gPzLwHtfyfoyucNYAMIGv8BZlgCFIDxH5AMCsD4D8gQBbDUJ2f8BywBERsAgCUgrgCM/4AlwAYAsMwS0PiPAgQVgPEfkBX1C8A3/wBSxQZg/AckRkwBGP8B2WIDMP4DciOmAIz/gISxARj/AemRXQAA1C8A738AOWMDSNngABmiAIz/gLSxARj/gWaSpOVfB+QQmGgv3j10EYhVpAC8/+Hg9NcBxGZO2Q3A+x92n/11AJl5cuyjJTn61/7hm+efXB9yOANA+u/6v4ICaM71l3He/3BwvusAbnQ9VQocA9gAkP46ABsASH8dQJLuD4F9AygTRbljYXbJn/cvO37hXHADcADAiIO8VYDC2eIVENJfBxBKASD9dQAKoEMOAJgtr3UA9VKo2k8COwAQ/VP/yx0LJ/tw+vnpmb8QBsLS3ypAPQoA6a8DUAAg/XUACgCkvw6gvKM7Dx53+qX7HXA0EsGOhdNcPwfe/vPAl+cXNgCoOYBbBeiUAkD6z/H1/P37I58aCgBqTtz2ABQA5Obspq/N+E+b/J3AiP7xv0jHwtgAICv9b/xqjf8ogJH5NXDS39eMRLIB/M8PAUj/Br9y439JZdLGKyCkP4RSAEj/qbz653sfIi3zXUCIfrABgPSfcvzXaigAyJ39dQAKAIrn45a3/zoABQC5yagDojT7u6AHh8AIxDnH/7U/st8YgQ0A6e/PDgoACRgw/usAFADSX/a5DigApF7k+K8DWJZDYER/Q5fFsTA2AKR/0PivHVEASH9cJRQAci1y/NcBKACkP64Yc3AIjCBra/xfu3SOhbEBIP1dQ/rT8i8CUgBIrkbHfx2AAkD643qiAJBWkeO/DmA6DoERUp1dXsfC2ACQ/kHjv5ZFASD9cbVRAMijyPFfB6AAkP648q1r/IcABofACKAex/+1j8CxMDYApL/PAhQAEidg/PeJoACQNfhcUABImcjx36fDYRwCI1wKfkyOhbEBIP2Dxn+fV1Pa/x5QBYA08alhAwA5UmX899mhAJAg+ATZxiEwgqPm+L/2UToWxgaA9PeZggJAUgSM/z7ZRXTxLUAKABnh88UGANKh9PjvU+Y6h8AIhdCP27EwNgCkf9D473NHASAF8OlPpZcTYAXg+ff8h47/7gEUgPQHd0Iuh8AeeHLH/7VbwrGwDQDpj3sDBYAn3PjvDmEfHZ0AKwDPNrhPbAB4qokf/90taRwCe5hh423jWNgGgPQ3/rt/UAB4enEXsUFfJ8CDV0CeW2Yb/1teL1798O/2e8m7IBsA0p+Kzbc1/d1RCgDpb/zPTX/3VVVeAYl+2O8G8zroRt0dANgApD/Gf3daLgUg/UmtvYPS3/2mAJD+xv/c9HfXKQCkP7np796rwSGw6Df+S//b3oSOhW0ASH/cjSgAPG/G/4Dx3z2pAJD+pKe/O1MBIP2N/7np7/7skUNg0Y/0H/9GdSxsA0D6G/+z0t8dqwDwLIH7VgHgKTL+543/7l4FgOeH6PR3D7fPIbDoN/5L/zluZsfCNgCkP1np765WAHhOjP/R6e/eVgB4QnCHu8MVAJ4N43/Y+O8+b5BDYI8E0n+ZG96xsA0A6W/8z0p/d74CwDNAdPq7/1vgFdDCJt2CPV0h4//U6e9djQ0AAAUAxv+Y8R8FAEh/FAAY/6U/JTgExoDcZRVJf2wAkLiISH8UAAAKAIz/oACgcp1IfxQABI7/0h8FAGZ/UACQMf5LfxQAAAoAjP9wO34SmG87e/J2hv/K6ccTl/q6u8//cIWxAVA5/ef8D3U0/o+Y/sWuMAqAaqEsoaZLf1cYBUDrYVEgoUYZ/6dIfx2AAqD1mJBQrjAKAIz/oAAghvRHAUDi+C/9UQBg9gcFABnjv/RHAQCgAMD4DwoACpP+KABIHP+lPwoAzP6gACBj/Jf+KAAAFADEjP/+ki8UAETWhvRHAUDg+C/9UQBg9gcFADHjPygAMP6DAoCM8V/6owDA7A8KADLGf+lPs45dAoo5e/J22gJ494v0xwYAcel/sU/6z/D1gAKA4ezJ29bS9suve9MBKADo3l7j/9e/7FMHoABgwvG/wdm/5a8QFADSf/zxf9Mv+tcBKACozF/zggKAUvb95h9QAGD8BwUA1cd/6Y8CALM/KAA4yOnHk77G/+7Sv6krjAJARsTN/q4wCgAd0Pf47wqjANABidl0+5c/rjAKgPQOOP140lo2fXP8H+vVf+wVZnH+PgCMjcvM/q4wNgBo0fbx3zd9ogDA7A8KAGLGf1AAYPwHBQAZ47/0RwGA2R8UAGSM/9IfBQBmf1AAEDP+gwIA4z8oAMgY/6U/CgDM/qAAIGP8l/4oADD7gwKAmPEfFAAY/0EBQMb4L/1RAGD2BwUAGeO/9EcBgNkfFADEjP+gAMD4DwoAMsZ/6Y8CALM/KADIGP+lPygAzP6gACBm/AcUAMZ/UACQMf5Lf1AAmP1BAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAK45v3Lz2v/5OnZfR8nMIPrafPnr38pAAAUAAAKAAAFAIACAEABAKAAbsV3gq558/yTi4C7SM4ULIDrPwoAML9Ofwhg8AoIIJYCsL+D+0cBAKAAMMSBO0cBNM2vhPMk456ZU5lfA2cDAKS/DQCPdM9OP574Ot0qKAA82LhJ2NXRnQePe/8zPHu9/lbuw6mfEdvmxbuH9f5QZ0/eGv+l/6SKHQDYAEx5dbScsNIfBUBbT3u9B77NnG0//UveDOyi5iugwVugPVV6KdTOu6DGo1/o7+XGbzHv/RVQhQIYHAMAsxdA7+k/DMPq8vzCRwsQaDUMgw4ACC2AAh3gd0IA0yn5/mf4+ruA7AEAiRtAyQ6wBACSZNcC+NIBndaAvyESmEeN9z/Dph8E8zoIoLyNPwlcowO8BQJkyN4FMHT4OshbIGBqZd7/DLv8LiCvgwDjf9wGUKMDvAUCjP+HF8DQz+sgb4EARi6ArlcBSwAgN25bAF10gCUAmEKx9z/DYX8hTI8/LGYJACTGCAXQ/ipgCQCM/xMWQHergCUAkBWjFUDLq4AlADD+T14AHa0ClgBASoxcAG2uApYAwPg/UwF0sQpYAgD5MEkBtLYKWAIA4/+sBdD4KmAJACTDhAXQTg3cuAToAOCbmVB7/J+8AK5qwO0FkFgAi68ClgDA+L9YASxeA06DAem/ZAFc1UDLHzxAiNUi/9VFVgEvggDj//IFsGANAEj/5Qtg/hqwBAA0VAAz14AOAIz/bRXAVQ00dTcA0l8BlFoFfEsoSH9aLIB5asCLICB8/G+3AGaoAR0Axv/k9G+9AObZBnQASH8FEFcDmw4DdACEpH+4VV9f7ug14EAYktM/efwfhuHoux9/6verP753d5R/z7PXN9wcH051A0h/G0D1hcCBMKSR/t0XwLg1oAMgZPyX/nUKYJQacCAMIenPlb7PALY47HjgxsOAwXkAFEp/43/BDWCUhcAeANLfBhC9ENgDQPrbAEIXAnsASH8bQPRCYA+AGtEv/RXAIU2gA0D6K4DcJtjUAWoApH/vVi7BF5sOCbb8siBHAiD9bQD1dwJ7AEh/BZDbBDoAeol+6a8Axvfzb4+2/K9qAAz+CiC3BnQASH8FoAOAWaNf+iuAJjpADYD0VwA6ABD9CkANANJfAaR1gBqAKaJf+isAHQAGfxSAGgCDPwqg5Q5QAyD6FYAaUAOwa/RLfwVQrQPUAIh+BaAG1ACiX/orADUAcl/0K4DMGtAEiH7RrwDUgBogK/dFvwJQA5oA0Y8CUAOagNKhL/oVgBp4dMD/SxnQe+6LfgXArWpAGdBd6Mt9BcAkTaAPaDDuRb8CYO4aUAwsm/VyXwHQYhPAPOS+AkAZIPdRAGgChD4KAGWA0EcBoBKQ+CgAtAKCHgUAwKRWLgGAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgAABQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAEv6D8v4I+AK37xrAAAAAElFTkSuQmCC","type":"image/png","cache":"public, max-age=31536000, immutable"}};

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
