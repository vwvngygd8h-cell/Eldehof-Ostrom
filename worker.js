const ELDEHOF_BUILD = "6.1.0-ZAEHLERSTAENDE-VAILLANT-OSTROM-20261005";
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
          legacyFeatureDataDeleted: false,
          legacyFeaturesVisible: false,
          syncBackendRetainedButHidden: true,
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

const EMBEDDED_ASSETS = {"/index.html":{"body":"PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImRlIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLHZpZXdwb3J0LWZpdD1jb3ZlciI+CiAgPG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwNzExMWYiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CiAgPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtc3RhdHVzLWJhci1zdHlsZSIgY29udGVudD0iYmxhY2stdHJhbnNsdWNlbnQiPgogIDxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXRpdGxlIiBjb250ZW50PSJFbGRlaG9mIj4KICA8bWV0YSBuYW1lPSJkZXNjcmlwdGlvbiIgY29udGVudD0iRWxkZWhvZiBWZXJicmF1Y2hzYnVjaCDigJMgU3Ryb212ZXJicsOkdWNoZSBkb2t1bWVudGllcmVuIHVuZCBhdXN3ZXJ0ZW4uIj4KICA8dGl0bGU+RWxkZWhvZiA2LjEuMCDigJMgVmVyYnJhdWNoc2J1Y2g8L3RpdGxlPgogIDxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Im1hbmlmZXN0LndlYm1hbmlmZXN0Ij4KICA8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Imljb24tMTkyLnBuZyI+CiAgPGxpbmsgcmVsPSJpY29uIiBocmVmPSJpY29uLTE5Mi5wbmciPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0ic3R5bGVzLmNzcz92PTYuMS4wIj4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0iYXBwLXNoZWxsIj4KICA8aGVhZGVyIGNsYXNzPSJ0b3BiYXIiPgogICAgPGRpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPjxzcGFuIGNsYXNzPSJicmFuZC1tYXJrIj7ijII8L3NwYW4+PHNwYW4+RWxkZWhvZjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3VidGl0bGUiPlZlcmJyYXVjaHNidWNoPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxzcGFuIGNsYXNzPSJidWlsZC1waWxsIj42LjEuMDwvc3Bhbj4KICA8L2hlYWRlcj4KCiAgPG1haW4+CiAgICA8ZGl2IGlkPSJyZWNvdmVyeUJhbm5lciIgY2xhc3M9ImJhbm5lciB3YXJuaW5nIGhpZGRlbiIgcm9sZT0ic3RhdHVzIj4KICAgICAgPGRpdj48c3Ryb25nPkxva2FsZSBTaWNoZXJoZWl0c2tvcGllIGdlZnVuZGVuPC9zdHJvbmc+PHNwYW4+RGVyIG5vcm1hbGUgTW9uYXRzZGF0ZW5zcGVpY2hlciBpc3QgbGVlciwgYWJlciBlaW5lIGZyw7xoZXJlIGxva2FsZSBLb3BpZSBpc3Qgdm9yaGFuZGVuLjwvc3Bhbj48L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0icmVzdG9yZVNoYWRvd0J0biIgY2xhc3M9InNlY29uZGFyeSBjb21wYWN0IiB0eXBlPSJidXR0b24iPldpZWRlcmhlcnN0ZWxsZW48L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IGFjdGl2ZSIgaWQ9ImRhc2hib2FyZFZpZXciIGFyaWEtbGFiZWxsZWRieT0iZGFzaGJvYXJkVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPsOcQkVSU0lDSFQ8L3NwYW4+PGgxIGlkPSJkYXNoYm9hcmRUaXRsZSI+VmVyYnJhdWNoIGF1ZiBlaW5lbiBCbGljazwvaDE+PHA+TnVyIGRhcyBXZXNlbnRsaWNoZTogWsOkaGxlcnN0w6RuZGUsIFfDpHJtZXB1bXBlIHVuZCBPc3Ryb20tUHJlaXNlLjwvcD48L2Rpdj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJwcmltYXJ5IiBpZD0iZGFzaGJvYXJkQWRkQnRuIiB0eXBlPSJidXR0b24iPisgWsOkaGxlcnN0w6RuZGU8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgbGF0ZXN0LXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5MRVRaVEVSIE1PTkFUPC9zcGFuPjxoMiBpZD0ibGF0ZXN0TW9udGhUaXRsZSI+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZTwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0cmljLWdyaWQiIGlkPSJsYXRlc3RNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8cCBjbGFzcz0iY29tcGFyaXNvbi1saW5lIiBpZD0ibGF0ZXN0Q29tcGFyaXNvbiI+PC9wPgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwgb3N0cm9tLXBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj4KICAgICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0PC9oMj48c21hbGwgaWQ9Im9zdHJvbVN0YXR1cyI+Tm9jaCBuaWNodCBnZWxhZGVuPC9zbWFsbD48L2Rpdj4KICAgICAgICAgIDxidXR0b24gaWQ9InJlZnJlc2hPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj5Ba3R1YWxpc2llcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0ib3N0cm9tU2V0dXBIaW50IiBjbGFzcz0iZW1wdHktc3RhdGUgaGlkZGVuIj48c3Ryb25nPk9zdHJvbSBpc3Qgbm9jaCBuaWNodCBlaW5nZXJpY2h0ZXQuPC9zdHJvbmc+PHNwYW4+RGVuIEVsZGVob2YtQXBwLVNjaGzDvHNzZWwgZmluZGVzdCBkdSB1bnRlciBEYXRlbiDihpIgT3N0cm9tLjwvc3Bhbj48YnV0dG9uIGlkPSJnb09zdHJvbVNldHRpbmdzQnRuIiBjbGFzcz0ic2Vjb25kYXJ5IGNvbXBhY3QiIHR5cGU9ImJ1dHRvbiI+RWlucmljaHRlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxkaXYgaWQ9Im9zdHJvbURhc2hib2FyZCIgY2xhc3M9Im9zdHJvbS1ncmlkIj4KICAgICAgICAgIDxhcnRpY2xlIGNsYXNzPSJwcmljZS1jYXJkIGN1cnJlbnQiPjxzcGFuPkFrdHVlbGxlciBQcmVpczwvc3Bhbj48c3Ryb25nIGlkPSJvc3Ryb21DdXJyZW50UHJpY2UiPuKAkzwvc3Ryb25nPjxzbWFsbCBpZD0ib3N0cm9tQ3VycmVudE1ldGEiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgICAgPGFydGljbGUgY2xhc3M9InByaWNlLWNhcmQgYmVzdCI+PHNwYW4gaWQ9Im9zdHJvbUJlc3RMYWJlbCI+QmVzdGVzIFplaXRmZW5zdGVyPC9zcGFuPjxzdHJvbmcgaWQ9Im9zdHJvbUJlc3RQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21CZXN0TWV0YSI+4oCTPC9zbWFsbD48L2FydGljbGU+CiAgICAgICAgICA8YXJ0aWNsZSBjbGFzcz0icHJpY2UtY2FyZCB3b3JzdCI+PHNwYW4gaWQ9Im9zdHJvbVdvcnN0TGFiZWwiPlNjaGxlY2h0ZXN0ZXMgWmVpdGZlbnN0ZXI8L3NwYW4+PHN0cm9uZyBpZD0ib3N0cm9tV29yc3RQcmljZSI+4oCTPC9zdHJvbmc+PHNtYWxsIGlkPSJvc3Ryb21Xb3JzdE1ldGEiPuKAkzwvc21hbGw+PC9hcnRpY2xlPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgcHJpY2UtY2hhcnQtd3JhcCI+PGNhbnZhcyBpZD0ib3N0cm9tTWluaUNoYXJ0IiBhcmlhLWxhYmVsPSJPc3Ryb20gUHJlaXN2ZXJsYXVmIj48L2NhbnZhcz48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGRhc2hib2FyZC1jaGFydC1wYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+VkVSTEFVRjwvc3Bhbj48aDI+R2VzYW10dmVyYnJhdWNoPC9oMj48L2Rpdj48YnV0dG9uIGNsYXNzPSJzZWNvbmRhcnkgY29tcGFjdCIgZGF0YS1uYXY9ImFuYWx5c2lzVmlldyIgdHlwZT0iYnV0dG9uIj5BdXN3ZXJ0dW5nIMO2ZmZuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC13cmFwIj48Y2FudmFzIGlkPSJkYXNoYm9hcmRDb25zdW1wdGlvbkNoYXJ0IiBhcmlhLWxhYmVsPSJHZXNhbXR2ZXJicmF1Y2ggZGVyIGxldHp0ZW4gTW9uYXRlIj48L2NhbnZhcz48L2Rpdj4KICAgICAgPC9zZWN0aW9uPgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJ2aWV3IiBpZD0iY29uc3VtcHRpb25WaWV3IiBhcmlhLWxhYmVsbGVkYnk9ImNvbnN1bXB0aW9uVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlZFUkJSQVVDSDwvc3Bhbj48aDEgaWQ9ImNvbnN1bXB0aW9uVGl0bGUiPk1vbmF0c3dlcnRlPC9oMT48cD5HZXNhbXQtIHVuZCBBbHRlbnRlaWwtVmVyYnJhdWNoIGVudHN0ZWhlbiBhdXMgZGVuIFrDpGhsZXJzdMOkbmRlbi4gV8Okcm1lcHVtcGUga29tbXQgYXVzIGRlciBteVZBSUxMQU5ULUNTVjsgU2NobGVlL0tsdXMgd2lyZCBhdXRvbWF0aXNjaCBiZXJlY2huZXQuPC9wPjwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJhZGRSZWNvcmRCdG4iIHR5cGU9ImJ1dHRvbiI+KyBaw6RobGVyc3TDpG5kZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWNvcmQtdG9vbGJhciI+PHN0cm9uZyBpZD0icmVjb3JkQ291bnQiPjAgTW9uYXRlPC9zdHJvbmc+PHNlbGVjdCBpZD0icmVjb3JkWWVhckZpbHRlciIgYXJpYS1sYWJlbD0iSmFociBmaWx0ZXJuIj48b3B0aW9uIHZhbHVlPSJhbGwiPkFsbGUgSmFocmU8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJyZWNvcmRMaXN0IiBjbGFzcz0icmVjb3JkLWxpc3QiPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJhbmFseXNpc1ZpZXciIGFyaWEtbGFiZWxsZWRieT0iYW5hbHlzaXNUaXRsZSI+CiAgICAgIDxkaXYgY2xhc3M9InBhZ2UtaGVhZCI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+QVVTV0VSVFVORzwvc3Bhbj48aDEgaWQ9ImFuYWx5c2lzVGl0bGUiPlZlcmJyYXVjaCB2ZXJzdGVoZW48L2gxPjxwPkphaHJlc3dlcnRlLCBBdWZ0ZWlsdW5nLCBLb3N0ZW4gdW5kIFfDpHJtZXB1bXBlbi1FZmZpemllbnouPC9wPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIGZpbHRlci1wYW5lbCI+CiAgICAgICAgPGxhYmVsPkphaHI8c2VsZWN0IGlkPSJhbmFseXNpc1llYXIiPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgPGxhYmVsPlZlcmdsZWljaDxzZWxlY3QgaWQ9ImFuYWx5c2lzQ29tcGFyZVllYXIiPjxvcHRpb24gdmFsdWU9Im5vbmUiPktlaW4gVmVyZ2xlaWNoPC9vcHRpb24+PC9zZWxlY3Q+PC9sYWJlbD4KICAgICAgPC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0ibWV0cmljLWdyaWQgYW5hbHlzaXMtbWV0cmljcyIgaWQ9ImFuYWx5c2lzTWV0cmljcyI+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkFVRlRFSUxVTkc8L3NwYW4+PGgyPlfDpHJtZXB1bXBlIMK3IEFsdGVudGVpbCDCtyBTY2hsZWUvS2x1czwvaDI+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ibGVnZW5kIj48c3BhbiBjbGFzcz0iaGVhdCI+V8Okcm1lcHVtcGU8L3NwYW4+PHNwYW4gY2xhc3M9ImFubmV4Ij5BbHRlbnRlaWw8L3NwYW4+PHNwYW4gY2xhc3M9InJlc3QiPlNjaGxlZS9LbHVzPC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImFsbG9jYXRpb25DaGFydCI+PC9jYW52YXM+PC9kaXY+PC9zZWN0aW9uPgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlZFUkdMRUlDSDwvc3Bhbj48aDI+R2VzYW10dmVyYnJhdWNoPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJ0b3RhbENoYXJ0Ij48L2NhbnZhcz48L2Rpdj48L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5Nb25hdGxpY2hlIFN0cm9ta29zdGVuPC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJjaGFydC13cmFwIGxhcmdlIj48Y2FudmFzIGlkPSJjb3N0Q2hhcnQiPjwvY2FudmFzPjwvZGl2Pjwvc2VjdGlvbj4KICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIiBpZD0iY29wUGFuZWwiPjxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPlfDhFJNRVBVTVBFPC9zcGFuPjxoMj5BcmJlaXRzemFobDwvaDI+PC9kaXY+PC9kaXY+PHAgY2xhc3M9Im11dGVkIj5XaXJkIG51ciBhdXMgTW9uYXRlbiBtaXQgZG9rdW1lbnRpZXJ0ZXIgZXJ6ZXVndGVyIFfDpHJtZSBiZXJlY2huZXQuPC9wPjxkaXYgY2xhc3M9ImNoYXJ0LXdyYXAgbGFyZ2UiPjxjYW52YXMgaWQ9ImNvcENoYXJ0Ij48L2NhbnZhcz48L2Rpdj48L3NlY3Rpb24+CiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+PGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+TU9OQVRFPC9zcGFuPjxoMj5KYWhyZXPDvGJlcnNpY2h0PC9oMj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJ0YWJsZS1zY3JvbGwiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5Nb25hdDwvdGg+PHRoPkdlc2FtdDwvdGg+PHRoPldQPC90aD48dGg+QWx0ZW50ZWlsPC90aD48dGg+U2NobGVlL0tsdXM8L3RoPjx0aD5Lb3N0ZW48L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImFuYWx5c2lzVGFibGUiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj48L3NlY3Rpb24+CiAgICA8L3NlY3Rpb24+CgogICAgPHNlY3Rpb24gY2xhc3M9InZpZXciIGlkPSJkYXRhVmlldyIgYXJpYS1sYWJlbGxlZGJ5PSJkYXRhVGl0bGUiPgogICAgICA8ZGl2IGNsYXNzPSJwYWdlLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPkRBVEVOPC9zcGFuPjxoMSBpZD0iZGF0YVRpdGxlIj5CYWNrdXAgJiBFaW5zdGVsbHVuZ2VuPC9oMT48cD5aw6RobGVyc3TDpG5kZSwgbXlWQUlMTEFOVC1JbXBvcnQsIFNpY2hlcnVuZyB1bmQgT3N0cm9tLjwvcD48L2Rpdj48L2Rpdj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+REFURU5RVUFMSVTDhFQ8L3NwYW4+PGgyPk1vbmF0c3dlcnRlIHByw7xmZW48L2gyPjwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im1ldHJpYy1ncmlkIGNvbXBhY3QtbWV0cmljcyIgaWQ9InF1YWxpdHlNZXRyaWNzIj48L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJxdWFsaXR5SXNzdWVzIiBjbGFzcz0iaXNzdWUtbGlzdCI+PC9kaXY+CiAgICAgIDwvc2VjdGlvbj4KCgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJtZXRlclBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDI+R2VzYW10ICYgQWx0ZW50ZWlsPC9oMj48L2Rpdj48YnV0dG9uIGlkPSJhZGRNZXRlckJ0biIgY2xhc3M9InByaW1hcnkgY29tcGFjdCIgdHlwZT0iYnV0dG9uIj4rIEVpbnRyYWdlbjwvYnV0dG9uPjwvZGl2PgogICAgICAgIDxwIGNsYXNzPSJtdXRlZCI+RHUgdHLDpGdzdCBudXIgZGllIGJlaWRlbiBha3R1ZWxsZW4gWsOkaGxlcnN0w6RuZGUgZWluLiBFbGRlaG9mIGJlcmVjaG5ldCBkYXJhdXMgYXV0b21hdGlzY2ggZGVuIE1vbmF0c3ZlcmJyYXVjaC4gQXVzZ2FuZ3NwdW5rdCBpc3QgZGVyIDAxLjEwLjIwMjYgbWl0IEdlc2FtdCAzNC4yNTUga1doIHVuZCBBbHRlbnRlaWwgOS4wNDUga1doLjwvcD4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRyaWMtZ3JpZCBtZXRlci1sYXRlc3QiIGlkPSJtZXRlckxhdGVzdCI+PC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibWV0ZXJIaXN0b3J5IiBjbGFzcz0ibWV0ZXItaGlzdG9yeSI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyBtZXRlci1hY3Rpb25zIj48YnV0dG9uIGlkPSJ1bmRvTGF0ZXN0TWV0ZXJCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+TGV0enRlbiBaw6RobGVyc3RhbmQgenVyw7xja25laG1lbjwvYnV0dG9uPjwvZGl2PgogICAgICA8L3NlY3Rpb24+CgogICAgICA8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJ2YWlsbGFudEltcG9ydFBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5Xw4RSTUVQVU1QRTwvc3Bhbj48aDI+bXlWQUlMTEFOVC1EYXRlbiBpbXBvcnRpZXJlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5Xw6RobGUgZGllIGV4cG9ydGllcnRlbiBDU1YtRGF0ZWllbiB2b24gYXJvVEhFUk0gdW5kIHVuaVRPV0VSLiBEYXJhdXMgw7xiZXJuaW1tdCBFbGRlaG9mIGRlbiBXw6RybWVwdW1wZW52ZXJicmF1Y2ggdW5kIGRpZSBXw6RybWVtZW5nZW4uIEdlc2FtdCB1bmQgQWx0ZW50ZWlsIGtvbW1lbiBhdXNzY2hsaWXDn2xpY2ggYXVzIGRlaW5lbiBaw6RobGVyc3TDpG5kZW4uPC9wPgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbi1yb3ciPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBwcmltYXJ5Ij5DU1YtRGF0ZWllbiBhdXN3w6RobGVuPGlucHV0IGlkPSJ2YWlsbGFudENzdkZpbGVzSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iLmNzdix0ZXh0L2Nzdix0ZXh0L3BsYWluIiBtdWx0aXBsZSBoaWRkZW4+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8cCBpZD0idmFpbGxhbnRJbXBvcnRTdGF0dXMiIGNsYXNzPSJzdGF0dXMtdGV4dCI+Tm9jaCBrZWluZSBEYXRlaWVuIGF1c2dld8OkaGx0LjwvcD4KICAgICAgPC9zZWN0aW9uPgoKICAgICAgPHNlY3Rpb24gY2xhc3M9InBhbmVsIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwYW5lbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5TSUNIRVJVTkc8L3NwYW4+PGgyPlByaXZhdGVzIEJhY2t1cDwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHAgY2xhc3M9Im11dGVkIj5EYXMgcHJpdmF0ZSBCYWNrdXAgZW50aMOkbHQgZGVpbmUgVmVyYnJhdWNoc2RhdGVuIHVuZCDigJMgc29mZXJuIGdlc3BlaWNoZXJ0IOKAkyBhdWNoIGRlbiBPc3Ryb20tQXBwLVNjaGzDvHNzZWwuIE5pY2h0IMO2ZmZlbnRsaWNoIGhvY2hsYWRlbi48L3A+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRCYWNrdXBCdG4iIGNsYXNzPSJwcmltYXJ5IiB0eXBlPSJidXR0b24iPkJhY2t1cCBleHBvcnRpZXJlbjwvYnV0dG9uPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWxlLWJ1dHRvbiBzZWNvbmRhcnkiPkJhY2t1cCBpbXBvcnRpZXJlbjxpbnB1dCBpZD0iaW1wb3J0QmFja3VwSW5wdXQiIHR5cGU9ImZpbGUiIGFjY2VwdD0iYXBwbGljYXRpb24vanNvbiwuanNvbiIgaGlkZGVuPjwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGlkPSJleHBvcnRDc3ZCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+Q1NWIGV4cG9ydGllcmVuPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPHAgaWQ9ImJhY2t1cFN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im9zdHJvbVNldHRpbmdzUGFuZWwiPgogICAgICAgIDxkaXYgY2xhc3M9InBhbmVsLWhlYWQiPjxkaXY+PHNwYW4gY2xhc3M9ImV5ZWJyb3ciPk9TVFJPTTwvc3Bhbj48aDI+UHJlaXPDvGJlcnNpY2h0IHZlcmJpbmRlbjwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+RWxkZWhvZi1BcHAtU2NobMO8c3NlbDxpbnB1dCBpZD0ib3N0cm9tQXBwS2V5SW5wdXQiIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9Im9mZiIgcGxhY2Vob2xkZXI9IkFwcC1TY2hsw7xzc2VsIj48L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9InNldHRpbmdzLWdyaWQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+WmVpdGZlbnN0ZXI8c2VsZWN0IGlkPSJwcmVmZXJyZWRXaW5kb3dIb3Vyc0lucHV0Ij48b3B0aW9uIHZhbHVlPSIxIj4xIFN0dW5kZTwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjIiPjIgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjMiPjMgU3R1bmRlbjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9IjQiPjQgU3R1bmRlbjwvb3B0aW9uPjwvc2VsZWN0PjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InN3aXRjaC1yb3ciPjxpbnB1dCBpZD0ib3N0cm9tQXV0b1JlZnJlc2hJbnB1dCIgdHlwZT0iY2hlY2tib3giPjxzcGFuPkF1dG9tYXRpc2NoIGFsbGUgMTAgTWludXRlbiBha3R1YWxpc2llcmVuPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9uLXJvdyI+PGJ1dHRvbiBpZD0ic2F2ZU9zdHJvbUJ0biIgY2xhc3M9InByaW1hcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuICYgcHLDvGZlbjwvYnV0dG9uPjxidXR0b24gaWQ9ImRpc2Nvbm5lY3RPc3Ryb21CdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+VmVyYmluZHVuZyBlbnRmZXJuZW48L2J1dHRvbj48L2Rpdj4KICAgICAgICA8cCBpZD0ib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIgY2xhc3M9InN0YXR1cy10ZXh0Ij48L3A+CiAgICAgIDwvc2VjdGlvbj4KCiAgICAgIDxzZWN0aW9uIGNsYXNzPSJwYW5lbCI+CiAgICAgICAgPGRpdiBjbGFzcz0icGFuZWwtaGVhZCI+PGRpdj48c3BhbiBjbGFzcz0iZXllYnJvdyI+S09TVEVOPC9zcGFuPjxoMj5GYWxsYmFjay1XZXJ0ZTwvaDI+PC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic2V0dGluZ3MtZ3JpZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5BcmJlaXRzcHJlaXMg4oKsL2tXaDxpbnB1dCBpZD0iZmFsbGJhY2tQcmljZUlucHV0IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5Nb25hdGxpY2hlIEZpeGtvc3RlbiDigqw8aW5wdXQgaWQ9ImRlZmF1bHRCYXNlRmVlSW5wdXQiIHR5cGU9Im51bWJlciIgbWluPSIwIiBzdGVwPSIwLjAxIj48L2xhYmVsPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9InNhdmVDb3N0U2V0dGluZ3NCdG4iIGNsYXNzPSJzZWNvbmRhcnkiIHR5cGU9ImJ1dHRvbiI+U3BlaWNoZXJuPC9idXR0b24+CiAgICAgIDwvc2VjdGlvbj4KICAgIDwvc2VjdGlvbj4KICA8L21haW4+CgogIDxuYXYgY2xhc3M9ImJvdHRvbS1uYXYiIGFyaWEtbGFiZWw9IkhhdXB0bmF2aWdhdGlvbiI+CiAgICA8YnV0dG9uIGNsYXNzPSJhY3RpdmUiIGRhdGEtbmF2PSJkYXNoYm9hcmRWaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKMgjwvc3Bhbj7DnGJlcnNpY2h0PC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtbmF2PSJjb25zdW1wdGlvblZpZXciIHR5cGU9ImJ1dHRvbiI+PHNwYW4+4pakPC9zcGFuPlZlcmJyYXVjaDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLW5hdj0iYW5hbHlzaXNWaWV3IiB0eXBlPSJidXR0b24iPjxzcGFuPuKWpTwvc3Bhbj5BdXN3ZXJ0dW5nPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtbmF2PSJkYXRhVmlldyIgdHlwZT0iYnV0dG9uIj48c3Bhbj7impk8L3NwYW4+RGF0ZW48L2J1dHRvbj4KICA8L25hdj4KPC9kaXY+Cgo8ZGl2IGlkPSJtZXRlck1vZGFsIiBjbGFzcz0ibW9kYWwgaGlkZGVuIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWxsZWRieT0ibWV0ZXJNb2RhbFRpdGxlIj4KICA8ZGl2IGNsYXNzPSJtb2RhbC1iYWNrZHJvcCIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbD48L2Rpdj4KICA8Zm9ybSBjbGFzcz0ibW9kYWwtY2FyZCIgaWQ9Im1ldGVyRm9ybSI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkIj48ZGl2PjxzcGFuIGNsYXNzPSJleWVicm93Ij5aw4RITEVSU1TDhE5ERTwvc3Bhbj48aDIgaWQ9Im1ldGVyTW9kYWxUaXRsZSI+TmV1ZSBBYmxlc3VuZzwvaDI+PC9kaXY+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJpY29uLWJ1dHRvbiIgZGF0YS1jbG9zZS1tZXRlci1tb2RhbCBhcmlhLWxhYmVsPSJTY2hsaWXDn2VuIj7DlzwvYnV0dG9uPjwvZGl2PgogICAgPHAgaWQ9Im1ldGVyUHJldmlvdXMiIGNsYXNzPSJtZXRlci1wcmV2aW91cyI+PC9wPgogICAgPHAgaWQ9Im1ldGVyVGFyZ2V0TW9udGgiIGNsYXNzPSJtdXRlZCI+PC9wPgogICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4KICAgICAgPGxhYmVsIGNsYXNzPSJmaWVsZCI+QWJsZXNlZGF0dW08aW5wdXQgaWQ9Im1ldGVyRGF0ZSIgdHlwZT0iZGF0ZSIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgICAgPHNwYW4+PC9zcGFuPgogICAgICA8bGFiZWwgY2xhc3M9ImZpZWxkIj5HZXNhbXQtWsOkaGxlcnN0YW5kIGtXaDxpbnB1dCBpZD0ibWV0ZXJUb3RhbCIgdHlwZT0ibnVtYmVyIiBtaW49IjAiIHN0ZXA9IjAuMDAxIiBpbnB1dG1vZGU9ImRlY2ltYWwiIHJlcXVpcmVkPjwvbGFiZWw+CiAgICAgIDxsYWJlbCBjbGFzcz0iZmllbGQiPkFsdGVudGVpbC1aw6RobGVyc3RhbmQga1doPGlucHV0IGlkPSJtZXRlckFubmV4IiB0eXBlPSJudW1iZXIiIG1pbj0iMCIgc3RlcD0iMC4wMDEiIGlucHV0bW9kZT0iZGVjaW1hbCIgcmVxdWlyZWQ+PC9sYWJlbD4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0ibWV0ZXJQcmV2aWV3IiBjbGFzcz0iZGVyaXZlZC1wcmV2aWV3Ij5Nb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXV0b21hdGlzY2ggYmVyZWNobmV0LjwvZGl2PgogICAgPHAgY2xhc3M9Im11dGVkIGNvbXBhY3Qtbm90ZSI+RGllIFfDpHJtZXB1bXBlIHdpcmQgbmljaHQgaGllciBlaW5nZXRyYWdlbi4gU2llIGtvbW10IGF1c3NjaGxpZcOfbGljaCBhdXMgZGVtIG15VkFJTExBTlQtQ1NWLUltcG9ydC48L3A+CiAgICA8cCBpZD0ibWV0ZXJWYWxpZGF0aW9uIiBjbGFzcz0idmFsaWRhdGlvbi10ZXh0Ij48L3A+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj48c3BhbiBjbGFzcz0ic3BhY2VyIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0ic2Vjb25kYXJ5IiB0eXBlPSJidXR0b24iIGRhdGEtY2xvc2UtbWV0ZXItbW9kYWw+QWJicmVjaGVuPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0icHJpbWFyeSIgdHlwZT0ic3VibWl0Ij5aw6RobGVyc3TDpG5kZSBzcGVpY2hlcm48L2J1dHRvbj48L2Rpdj4KICA8L2Zvcm0+CjwvZGl2PgoKPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJ0b2FzdCBoaWRkZW4iIHJvbGU9InN0YXR1cyIgYXJpYS1saXZlPSJwb2xpdGUiPjwvZGl2Pgo8c2NyaXB0IHNyYz0iYXBwLmpzP3Y9Ni4xLjAiPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K","type":"text/html; charset=utf-8","cache":"no-cache"},"/styles.css":{"body":"OnJvb3R7CiAgY29sb3Itc2NoZW1lOmRhcms7CiAgLS1iZzojMDYxMDFjOwogIC0tcGFuZWw6IzBjMWEyYTsKICAtLXBhbmVsMjojMTAyMjM1OwogIC0tbGluZTpyZ2JhKDE3MSwxOTgsMjIwLC4xNCk7CiAgLS10ZXh0OiNmNGY4ZmI7CiAgLS1tdXRlZDojOTRhOGJhOwogIC0tZ3JlZW46IzcyZGM1NzsKICAtLW9yYW5nZTojZmY5ZjQzOwogIC0tYmx1ZTojNGQ5Y2ZmOwogIC0teWVsbG93OiNmMmQxNWY7CiAgLS1yZWQ6I2ZmNmI2YjsKICAtLXNoYWRvdzowIDE4cHggNTVweCByZ2JhKDAsMCwwLC4yNCk7CiAgLS1yYWRpdXM6MjBweDsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbHtiYWNrZ3JvdW5kOnZhcigtLWJnKTttaW4taGVpZ2h0OjEwMCU7Zm9udC1mYW1pbHk6SW50ZXIsLWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixzYW5zLXNlcmlmOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQpib2R5e21hcmdpbjowO2JhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCB0b3AgcmlnaHQscmdiYSg2MCwxMjAsMTcwLC4xMCksdHJhbnNwYXJlbnQgMzUlKSx2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7bWluLWhlaWdodDoxMDB2aH0KYnV0dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXR9CmJ1dHRvbntjdXJzb3I6cG9pbnRlcn0KYnV0dG9uOmRpc2FibGVke29wYWNpdHk6LjQ4O2N1cnNvcjpub3QtYWxsb3dlZH0KLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQouYXBwLXNoZWxse21heC13aWR0aDoxMTgwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjAgMjJweCAxMTJweH0KLnRvcGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3BhZGRpbmc6Y2FsYygxNnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKSAwIDE4cHg7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MzA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQodG8gYm90dG9tLHJnYmEoNiwxNiwyOCwuOTgpLHJnYmEoNiwxNiwyOCwuODYpLHJnYmEoNiwxNiwyOCwwKSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCl9Ci5icmFuZHtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0Ojg1MDtsZXR0ZXItc3BhY2luZzotLjAzZW19LmJyYW5kLW1hcmt7ZGlzcGxheTppbmxpbmUtZ3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6MzZweDtoZWlnaHQ6MzZweDtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxZTYzMzMsIzJmOGU0OSk7Ym94LXNoYWRvdzowIDZweCAyNHB4IHJnYmEoNTMsMTkwLDkxLC4xOCl9Ci5zdWJ0aXRsZXtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWxlZnQ6NDZweDttYXJnaW4tdG9wOi00cHh9LmJ1aWxkLXBpbGx7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6cmdiYSgxMTQsMjIwLDg3LC4xMik7Y29sb3I6I2I5ZjVhYTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTE0LDIyMCw4NywuMjIpO3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLXJhZGl1czo5OTlweH0KbWFpbntkaXNwbGF5OmJsb2NrfS52aWV3e2Rpc3BsYXk6bm9uZTthbmltYXRpb246ZmFkZSAuMThzIGVhc2V9LnZpZXcuYWN0aXZle2Rpc3BsYXk6YmxvY2t9QGtleWZyYW1lcyBmYWRle2Zyb217b3BhY2l0eTouNTt0cmFuc2Zvcm06dHJhbnNsYXRlWSg0cHgpfXRve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5wYWdlLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDoyMnB4O21hcmdpbjoxOHB4IDAgMjRweH0ucGFnZS1oZWFkIGgxe2ZvbnQtc2l6ZTpjbGFtcCgyOHB4LDV2dyw0NHB4KTttYXJnaW46M3B4IDAgN3B4O2xpbmUtaGVpZ2h0OjEuMDU7bGV0dGVyLXNwYWNpbmc6LS4wNGVtfS5wYWdlLWhlYWQgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7bWF4LXdpZHRoOjY4MHB4O2xpbmUtaGVpZ2h0OjEuNX0uZXllYnJvd3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xNmVtO2ZvbnQtd2VpZ2h0Ojg1MDtjb2xvcjojN2Y5ZGI0O21hcmdpbi1ib3R0b206NXB4fQoucGFuZWx7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHJnYmEoMTUsMzEsNDgsLjk2KSxyZ2JhKDEwLDI0LDM5LC45OCkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjE4cHg7Ym94LXNoYWRvdzp2YXIoLS1zaGFkb3cpfQoucGFuZWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE4cHh9LnBhbmVsLWhlYWQgaDJ7bWFyZ2luOjJweCAwIDJweDtmb250LXNpemU6MjFweDtsZXR0ZXItc3BhY2luZzotLjAyNWVtfS5wYW5lbC1oZWFkIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0KLnByaW1hcnksLnNlY29uZGFyeSwuZGFuZ2VyLC5maWxlLWJ1dHRvbnthcHBlYXJhbmNlOm5vbmU7Ym9yZGVyLXJhZGl1czoxM3B4O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnQ7cGFkZGluZzoxMXB4IDE1cHg7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLXRleHQpO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjhweDt0ZXh0LWRlY29yYXRpb246bm9uZTttaW4taGVpZ2h0OjQ0cHh9LnByaW1hcnl7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyZjhlNDksIzFmNmMzOCk7Ym9yZGVyLWNvbG9yOnJnYmEoMTE0LDIyMCw4NywuMjgpO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDQ0LDE2MSw3NywuMTgpfS5wcmltYXJ5OmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMDYpfS5zZWNvbmRhcnksLmZpbGUtYnV0dG9ue2JhY2tncm91bmQ6IzEyMjYzYTtib3JkZXItY29sb3I6cmdiYSgxNzAsMjAwLDIyNCwuMTQpO2NvbG9yOiNkY2U5ZjN9LnNlY29uZGFyeTpob3ZlciwuZmlsZS1idXR0b246aG92ZXJ7YmFja2dyb3VuZDojMTczMDQ5fS5kYW5nZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xMCk7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjI1KTtjb2xvcjojZmZhYWE5fS5jb21wYWN0e21pbi1oZWlnaHQ6MzZweDtwYWRkaW5nOjhweCAxMXB4O2ZvbnQtc2l6ZToxM3B4fS5pY29uLWJ1dHRvbntib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjOWQ3ZTI7Zm9udC1zaXplOjMwcHg7bGluZS1oZWlnaHQ6MTtwYWRkaW5nOjAgNnB4fQoubWV0cmljLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNSxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxNnB4O21pbi13aWR0aDowfS5tZXRyaWMtZ3JpZCBhcnRpY2xlIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbTo3cHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZTpjbGFtcCgxOXB4LDN2dywyNnB4KTtsaW5lLWhlaWdodDoxLjE7ZGlzcGxheTpibG9jazt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Lm1ldHJpYy1ncmlkIGFydGljbGUgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojN2Y5NmFhO2ZvbnQtc2l6ZToxMXB4O21hcmdpbi10b3A6NnB4O2xpbmUtaGVpZ2h0OjEuMzV9LmNvbXBhcmlzb24tbGluZXttYXJnaW46MTVweCAwIDA7Y29sb3I6I2I4YzhkNTtmb250LXNpemU6MTNweH0uY29tcGFyaXNvbi1saW5lLnBvc2l0aXZle2NvbG9yOiNmZmIxYTh9LmNvbXBhcmlzb24tbGluZS5uZWdhdGl2ZXtjb2xvcjojYTVlNjlhfS5jb21wYXJpc29uLWxpbmUubmV1dHJhbHtjb2xvcjojYjhjOGQ1fQoub3N0cm9tLXBhbmVse292ZXJmbG93OmhpZGRlbn0ub3N0cm9tLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0ucHJpY2UtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMGIxYjJiO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MThweH0ucHJpY2UtY2FyZDpiZWZvcmV7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowIGF1dG8gMCAwO3dpZHRoOjRweDtiYWNrZ3JvdW5kOiM2ZDg1OTl9LnByaWNlLWNhcmQuYmVzdDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ncmVlbil9LnByaWNlLWNhcmQud29yc3Q6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tcmVkKX0ucHJpY2UtY2FyZC5jdXJyZW50OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLWJsdWUpfS5wcmljZS1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHh9LnByaWNlLWNhcmQgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjI3cHg7bWFyZ2luOjhweCAwIDRweH0ucHJpY2UtY2FyZCBzbWFsbHtjb2xvcjojOWNiMGMwfS5lbXB0eS1zdGF0ZXtib3JkZXI6MXB4IGRhc2hlZCByZ2JhKDE3MCwyMDAsMjI0LC4yKTtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjAyKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6OXB4IDE0cHg7YWxpZ24taXRlbXM6Y2VudGVyfS5lbXB0eS1zdGF0ZSBzdHJvbmd7d2lkdGg6MTAwJX0uZW1wdHktc3RhdGUgc3Bhbntjb2xvcjp2YXIoLS1tdXRlZCk7ZmxleDoxO21pbi13aWR0aDoyMDBweH0ucHJpY2UtY2hhcnQtd3JhcHttYXJnaW4tdG9wOjE2cHh9Ci5jaGFydC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDoyNjBweDt3aWR0aDoxMDAlO21pbi13aWR0aDowfS5jaGFydC13cmFwLmxhcmdle2hlaWdodDozNDBweH0uY2hhcnQtd3JhcCBjYW52YXN7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtkaXNwbGF5OmJsb2NrfS5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjI2MHB4fS5sZWdlbmR7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNXB4O21hcmdpbjotNnB4IDAgMTRweDtjb2xvcjojYjhjNmQyO2ZvbnQtc2l6ZToxMnB4fS5sZWdlbmQgc3BhbjpiZWZvcmV7Y29udGVudDoiIjtkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDo5cHg7aGVpZ2h0OjlweDtib3JkZXItcmFkaXVzOjNweDttYXJnaW4tcmlnaHQ6NnB4fS5sZWdlbmQgLmhlYXQ6YmVmb3Jle2JhY2tncm91bmQ6dmFyKC0tb3JhbmdlKX0ubGVnZW5kIC5hbm5leDpiZWZvcmV7YmFja2dyb3VuZDp2YXIoLS1ibHVlKX0ubGVnZW5kIC5yZXN0OmJlZm9yZXtiYWNrZ3JvdW5kOnZhcigtLXllbGxvdyl9Ci5yZWNvcmQtdG9vbGJhcntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MTRweH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0LC5maWx0ZXItcGFuZWwgc2VsZWN0e2JhY2tncm91bmQ6IzBiMWEyYTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEwcHggMTJweH0ucmVjb3JkLWxpc3R7ZGlzcGxheTpncmlkO2dhcDoxMHB4fS5yZWNvcmQtcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6bWlubWF4KDE1MHB4LDEuM2ZyKSByZXBlYXQoNCxtaW5tYXgoOTBweCwuODVmcikpIGF1dG87Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGExOTI4O2JvcmRlci1yYWRpdXM6MTVweDtwYWRkaW5nOjEzcHggMTRweH0ucmVjb3JkLXJvdzpob3ZlcntiYWNrZ3JvdW5kOiMwZTIwMzJ9LnJlY29yZC1tb250aCBzdHJvbmd7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTVweH0ucmVjb3JkLW1vbnRoIHNtYWxse2Rpc3BsYXk6YmxvY2s7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6M3B4fS5yZWNvcmQtdmFsdWUgc3BhbntkaXNwbGF5OmJsb2NrO2NvbG9yOiM3Zjk2YWE7Zm9udC1zaXplOjEwcHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wOGVtfS5yZWNvcmQtdmFsdWUgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5yZWNvcmQtcm93IC5lZGl0LXJlY29yZHtqdXN0aWZ5LXNlbGY6ZW5kfS5yZWNvcmQtcm93LmludmFsaWR7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDEwNywxMDcsLjMpfQouZmlsdGVyLXBhbmVse2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczplbmR9LmZpbHRlci1wYW5lbCBsYWJlbHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEycHg7bWluLXdpZHRoOjE1MHB4fS5hbmFseXNpcy1tZXRyaWNze21hcmdpbi1ib3R0b206MThweH0uYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDUsbWlubWF4KDAsMWZyKSl9Ci50YWJsZS1zY3JvbGx7b3ZlcmZsb3c6YXV0bztib3JkZXItcmFkaXVzOjEzcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzIwcHh9dGgsdGR7cGFkZGluZzoxMnB4IDEzcHg7dGV4dC1hbGlnbjpyaWdodDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmb250LXNpemU6MTNweH10aDpmaXJzdC1jaGlsZCx0ZDpmaXJzdC1jaGlsZHt0ZXh0LWFsaWduOmxlZnR9dGh7Zm9udC1zaXplOjExcHg7Y29sb3I6Izg4YTBiNTtsZXR0ZXItc3BhY2luZzouMDVlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7YmFja2dyb3VuZDojMGExOTI4O3Bvc2l0aW9uOnN0aWNreTt0b3A6MH10Ym9keSB0cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLmNvbXBhY3QtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDQsbWlubWF4KDAsMWZyKSl9Lmlzc3VlLWxpc3R7ZGlzcGxheTpncmlkO2dhcDo4cHg7bWFyZ2luLXRvcDoxNHB4fS5pc3N1ZXtkaXNwbGF5OmZsZXg7Z2FwOjEycHg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTJweCAxM3B4O2JvcmRlci1yYWRpdXM6MTNweDtiYWNrZ3JvdW5kOiMwYjFhMmE7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0uaXNzdWUud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yMil9Lmlzc3VlLmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4yNSl9Lmlzc3VlIGRpdnttaW4td2lkdGg6MH0uaXNzdWUgc3Ryb25ne2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEzcHh9Lmlzc3VlIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6M3B4fS5tdXRlZHtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS41NX0uYWN0aW9uLXJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5zdGF0dXMtdGV4dHttaW4taGVpZ2h0OjEuNGVtO21hcmdpbjoxMnB4IDAgMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHh9LnN0YXR1cy10ZXh0Lm9re2NvbG9yOiNhNWU2OWF9LnN0YXR1cy10ZXh0LmVycm9ye2NvbG9yOiNmZmFhYTl9LnNldHRpbmdzLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTNweDttYXJnaW46MTRweCAwfS5maWVsZHtkaXNwbGF5OmdyaWQ7Z2FwOjdweDtjb2xvcjojOWRiMGMwO2ZvbnQtc2l6ZToxMnB4fS5maWVsZCBpbnB1dCwuZmllbGQgc2VsZWN0LC5maWVsZCB0ZXh0YXJlYXt3aWR0aDoxMDAlO2JhY2tncm91bmQ6IzA4MTcyNTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTcxLDE5OCwyMjAsLjE2KTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4IDEycHg7b3V0bGluZTpub25lfS5maWVsZCBpbnB1dDpmb2N1cywuZmllbGQgc2VsZWN0OmZvY3VzLC5maWVsZCB0ZXh0YXJlYTpmb2N1c3tib3JkZXItY29sb3I6cmdiYSg3NywxNTYsMjU1LC41NSk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NywxNTYsMjU1LC4wOCl9LnN3aXRjaC1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjExcHggMTNweDtjb2xvcjojYzdkNWRmfS5zd2l0Y2gtcm93IGlucHV0e3dpZHRoOjIwcHg7aGVpZ2h0OjIwcHg7YWNjZW50LWNvbG9yOiMzYzlhNTN9Ci5iYW5uZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTZweDttYXJnaW46MTJweCAwIDE4cHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxNXB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGQyMDMyfS5iYW5uZXIud2FybmluZ3tib3JkZXItY29sb3I6cmdiYSgyNDIsMjA5LDk1LC4yOCk7YmFja2dyb3VuZDpyZ2JhKDI0MiwyMDksOTUsLjA2KX0uYmFubmVyIHN0cm9uZywuYmFubmVyIHNwYW57ZGlzcGxheTpibG9ja30uYmFubmVyIHNwYW57Y29sb3I6I2IzYzBjYTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjNweH0KLmJvdHRvbS1uYXZ7cG9zaXRpb246Zml4ZWQ7ei1pbmRleDo0MDtsZWZ0OjUwJTtib3R0b206bWF4KDEycHgsZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCg0LDFmcik7d2lkdGg6bWluKDYyMHB4LGNhbGMoMTAwJSAtIDI0cHgpKTtiYWNrZ3JvdW5kOnJnYmEoOCwyMCwzMywuOTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTYpO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjdweDtib3gtc2hhZG93OjAgMTZweCA1MHB4IHJnYmEoMCwwLDAsLjQyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxNnB4KX0uYm90dG9tLW5hdiBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojODU5OWFhO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjlweCA4cHg7ZGlzcGxheTpncmlkO2dhcDozcHg7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MDttaW4td2lkdGg6MH0uYm90dG9tLW5hdiBidXR0b24gc3Bhbntmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfS5ib3R0b20tbmF2IGJ1dHRvbi5hY3RpdmV7YmFja2dyb3VuZDojMTUzMTQ3O2NvbG9yOiNmNGY4ZmJ9Ci5tb2RhbHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7cGFkZGluZzoxOHB4fS5tb2RhbC1iYWNrZHJvcHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNzIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDVweCl9Lm1vZGFsLWNhcmR7cG9zaXRpb246cmVsYXRpdmU7d2lkdGg6bWluKDc2MHB4LDEwMCUpO21heC1oZWlnaHQ6Y2FsYygxMDB2aCAtIDM2cHgpO292ZXJmbG93OmF1dG87YmFja2dyb3VuZDojMGIxYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNzQsMjAxLDIyNCwuMTgpO2JvcmRlci1yYWRpdXM6MjJweDtwYWRkaW5nOjIycHg7Ym94LXNoYWRvdzowIDMwcHggOTBweCByZ2JhKDAsMCwwLC41NSl9Lm1vZGFsLWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxOHB4fS5tb2RhbC1oZWFkIGgye21hcmdpbjoycHggMCAwfS5mb3JtLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKTtnYXA6MTJweH0uZGVyaXZlZC1wcmV2aWV3e21hcmdpbjoxNHB4IDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOiMwODE3MjU7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTJweCAxNHB4O2ZvbnQtd2VpZ2h0OjgwMH0uZGVyaXZlZC1wcmV2aWV3LmVycm9ye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwxMDcsMTA3LC4zNSk7Y29sb3I6I2ZmYWFhOX0uZGV0YWlscy1jYXJke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbjoxMnB4IDA7YmFja2dyb3VuZDojMDgxNzI1fS5kZXRhaWxzLWNhcmQgc3VtbWFyeXtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjEycHggMTRweDtjb2xvcjojYzdkNWRmO2ZvbnQtd2VpZ2h0OjcwMH0uZGV0YWlscy1jYXJkIC5kZXRhaWwtZ3JpZHtwYWRkaW5nOjAgMTRweCAxNHB4fS52YWxpZGF0aW9uLXRleHR7bWluLWhlaWdodDoxLjJlbTtjb2xvcjojZmZhYWE5O2ZvbnQtc2l6ZToxMnB4fS5tb2RhbC1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OXB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjE2cHh9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntmbGV4OjF9Ci50b2FzdHtwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjE1MDtsZWZ0OjUwJTtib3R0b206MTAwcHg7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoLTUwJSk7YmFja2dyb3VuZDojMTkzNjRkO2NvbG9yOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIwMCwyMjAsMjM2LC4xNik7Ym9yZGVyLXJhZGl1czoxM3B4O3BhZGRpbmc6MTFweCAxNXB4O2JveC1zaGFkb3c6MCAxNnB4IDUwcHggcmdiYSgwLDAsMCwuNCk7bWF4LXdpZHRoOm1pbig5MHZ3LDU2MHB4KTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CkBtZWRpYShtYXgtd2lkdGg6OTAwcHgpey5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9LnJlY29yZC1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxNTBweCwxLjJmcikgcmVwZWF0KDIsbWlubWF4KDk1cHgsLjhmcikpIGF1dG99LnJlY29yZC1yb3cgLnJlY29yZC12YWx1ZTpudGgtb2YtdHlwZSg0KSwucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVlOm50aC1vZi10eXBlKDUpe2Rpc3BsYXk6bm9uZX0ub3N0cm9tLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9LnByaWNlLWNhcmQuY3VycmVudHtncmlkLWNvbHVtbjoxLy0xfS5jb21wYWN0LW1ldHJpY3MubWV0cmljLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfX0KQG1lZGlhKG1heC13aWR0aDo2MjBweCl7LmFwcC1zaGVsbHtwYWRkaW5nOjAgMTJweCAxMDRweH0udG9wYmFye3BhZGRpbmctbGVmdDo0cHg7cGFkZGluZy1yaWdodDo0cHh9LmJyYW5ke2ZvbnQtc2l6ZToyMXB4fS5icmFuZC1tYXJre3dpZHRoOjMzcHg7aGVpZ2h0OjMzcHh9LnN1YnRpdGxle21hcmdpbi1sZWZ0OjQzcHh9LnBhZ2UtaGVhZHthbGlnbi1pdGVtczpzdHJldGNoO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjttYXJnaW4tdG9wOjlweH0ucGFnZS1oZWFkIC5wcmltYXJ5e3dpZHRoOjEwMCV9LnBhZ2UtaGVhZCBoMXtmb250LXNpemU6MzFweH0ucGFuZWx7cGFkZGluZzoxNnB4O2JvcmRlci1yYWRpdXM6MTdweDttYXJnaW4tYm90dG9tOjEzcHh9LnBhbmVsLWhlYWR7Z2FwOjEwcHg7YWxpZ24taXRlbXM6Y2VudGVyfS5wYW5lbC1oZWFkIGgye2ZvbnQtc2l6ZToxOHB4fS5tZXRyaWMtZ3JpZCwuYW5hbHlzaXMtbWV0cmljcy5tZXRyaWMtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsbWlubWF4KDAsMWZyKSk7Z2FwOjlweH0ubWV0cmljLWdyaWQgYXJ0aWNsZXtwYWRkaW5nOjEzcHh9Lm1ldHJpYy1ncmlkIGFydGljbGUgc3Ryb25ne2ZvbnQtc2l6ZToyMHB4fS5vc3Ryb20tZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5wcmljZS1jYXJkLmN1cnJlbnR7Z3JpZC1jb2x1bW46YXV0b30ucHJpY2UtY2FyZHtwYWRkaW5nOjE1cHh9LnByaWNlLWNhcmQgc3Ryb25ne2ZvbnQtc2l6ZToyNHB4fS5jaGFydC13cmFwLC5kYXNoYm9hcmQtY2hhcnQtcGFuZWwgLmNoYXJ0LXdyYXB7aGVpZ2h0OjIyNXB4fS5jaGFydC13cmFwLmxhcmdle2hlaWdodDoyNzBweH0ucmVjb3JkLXRvb2xiYXJ7YWxpZ24taXRlbXM6c3RyZXRjaH0ucmVjb3JkLXRvb2xiYXIgc2VsZWN0e21heC13aWR0aDoxNDVweH0ucmVjb3JkLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjlweH0ucmVjb3JkLXJvdyAucmVjb3JkLXZhbHVle2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9LnJlY29yZC1yb3cgLmVkaXQtcmVjb3Jke2dyaWQtY29sdW1uOjI7Z3JpZC1yb3c6MX0ucmVjb3JkLW1vbnRoIHNtYWxse21heC13aWR0aDoyMzBweH0uZmlsdGVyLXBhbmVse2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtwYWRkaW5nOjE0cHh9LmZpbHRlci1wYW5lbCBsYWJlbHttaW4td2lkdGg6MH0uc2V0dGluZ3MtZ3JpZCwuZm9ybS1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9LmRldGFpbHMtY2FyZCAuZGV0YWlsLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uYWN0aW9uLXJvdz4qe2ZsZXg6MSAxIDE1MHB4fS5ib3R0b20tbmF2e3dpZHRoOmNhbGMoMTAwJSAtIDE2cHgpO2JvdHRvbTptYXgoOHB4LGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSk7Ym9yZGVyLXJhZGl1czoxN3B4fS5ib3R0b20tbmF2IGJ1dHRvbntmb250LXNpemU6MTBweDtwYWRkaW5nOjhweCAzcHh9LmJvdHRvbS1uYXYgYnV0dG9uIHNwYW57Zm9udC1zaXplOjE4cHh9Lm1vZGFse3BhZGRpbmc6OHB4fS5tb2RhbC1jYXJke3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE4cHg7bWF4LWhlaWdodDpjYWxjKDEwMHZoIC0gMTZweCl9Lm1vZGFsLWFjdGlvbnN7ZmxleC13cmFwOndyYXB9Lm1vZGFsLWFjdGlvbnMgLnNwYWNlcntkaXNwbGF5Om5vbmV9Lm1vZGFsLWFjdGlvbnMgYnV0dG9ue2ZsZXg6MSAxIDEyMHB4fS5iYW5uZXJ7YWxpZ24taXRlbXM6c3RyZXRjaDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59LmJhbm5lciBidXR0b257YWxpZ24tc2VsZjpmbGV4LXN0YXJ0fX0KQG1lZGlhKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246cmVkdWNlKXsqe3Njcm9sbC1iZWhhdmlvcjphdXRvIWltcG9ydGFudDthbmltYXRpb246bm9uZSFpbXBvcnRhbnQ7dHJhbnNpdGlvbjpub25lIWltcG9ydGFudH19CgovKiBFbGRlaG9mIDYuMC4xIOKAkyBsb2thbGVyIG15VkFJTExBTlQtSW1wb3J0ICovCiN2YWlsbGFudEltcG9ydFBhbmVsIC5hY3Rpb24tcm93e21hcmdpbi10b3A6MTRweH0KI3ZhaWxsYW50SW1wb3J0U3RhdHVzLm9re2NvbG9yOiNhNWU2OWF9CiN2YWlsbGFudEltcG9ydFN0YXR1cy5lcnJvcntjb2xvcjojZmZhYWE5fQoKLyogRWxkZWhvZiA2LjEuMCDigJMgWsOkaGxlcnN0w6RuZGUgYWxzIGVpbnppZ2UgbWFudWVsbGUgVmVyYnJhdWNoc2VpbmdhYmUgKi8KLnJlY29yZC1zdGF0dXMtYmFkZ2V7anVzdGlmeS1zZWxmOmVuZDtmb250LXNpemU6MTFweDtjb2xvcjojOWRiMGMwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzo2cHggOHB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDojMDgxNzI1fQoubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMyxtaW5tYXgoMCwxZnIpKTttYXJnaW46MTRweCAwfQoubWV0ZXItaGlzdG9yeXtkaXNwbGF5OmdyaWQ7Z2FwOjdweDttYXJnaW46MTRweCAwfS5tZXRlci1oaXN0b3J5LXJvd3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOm1pbm1heCgxMDBweCwxZnIpIHJlcGVhdCgyLG1pbm1heCgxMTBweCwxZnIpKSBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjEwcHggMTJweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiMwODE3MjU7Zm9udC1zaXplOjEycHh9Lm1ldGVyLWhpc3Rvcnktcm93IHNwYW4sLm1ldGVyLWhpc3Rvcnktcm93IHNtYWxse2NvbG9yOnZhcigtLW11dGVkKX0ubWV0ZXItaGlzdG9yeS1yb3cgc3Ryb25ne2ZvbnQtc2l6ZToxMnB4fS5tZXRlci1hY3Rpb25ze21hcmdpbi10b3A6MTJweH0ubWV0ZXItcHJldmlvdXN7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7YmFja2dyb3VuZDojMDgxNzI1O2NvbG9yOiNiOWM3ZDI7bGluZS1oZWlnaHQ6MS41fS5jb21wYWN0LW5vdGV7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4fQpAbWVkaWEobWF4LXdpZHRoOjYyMHB4KXsubWV0ZXItbGF0ZXN0Lm1ldHJpYy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyfS5tZXRlci1sYXRlc3QubWV0cmljLWdyaWQgYXJ0aWNsZTpmaXJzdC1jaGlsZHtncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0ubWV0ZXItaGlzdG9yeS1yb3cgc3BhbntncmlkLWNvbHVtbjoxLy0xfS5tZXRlci1oaXN0b3J5LXJvdyBzbWFsbHtkaXNwbGF5Om5vbmV9LnJlY29yZC1zdGF0dXMtYmFkZ2V7Zm9udC1zaXplOjEwcHh9fQo=","type":"text/css; charset=utf-8","cache":"no-cache"},"/app.js":{"body":"KCgpID0+IHsKICAidXNlIHN0cmljdCI7CgogIGNvbnN0IEFQUF9CVUlMRCA9ICI2LjEuMC1aQUVITEVSU1RBRU5ERS1WQUlMTEFOVC1PU1RST00tMjAyNjEwMDUiOwogIGNvbnN0IERBVEFfS0VZID0gImVsZGVob2YtdjMtcmVjb3JkcyI7CiAgY29uc3QgU0VUVElOR1NfS0VZID0gImVsZGVob2YtdjMtc2V0dGluZ3MiOwogIGNvbnN0IFZBSUxMQU5UX01PTlRIU19LRVkgPSAiZWxkZWhvZi12My12YWlsbGFudC1tb250aHMtdjM4MCI7CiAgY29uc3QgT1NUUk9NX0NBQ0hFX0tFWSA9ICJlbGRlaG9mLXYzLW9zdHJvbS1saXZlLWNhY2hlIjsKICBjb25zdCBPU1RST01fQ09OVFJPTF9LRVkgPSAiZWxkZWhvZi12NS1vc3Ryb20tY29udHJvbC12NTQxIjsKICBjb25zdCBTSEFET1dfS0VZID0gImVsZGVob2YtdjYtcmVjb3Jkcy1zaGFkb3ciOwogIGNvbnN0IFNIQURPV19NRVRBX0tFWSA9ICJlbGRlaG9mLXY2LXJlY29yZHMtc2hhZG93LW1ldGEiOwogIGNvbnN0IExBU1RfQkFDS1VQX0tFWSA9ICJlbGRlaG9mLXY2LWxhc3QtYmFja3VwLWF0IjsKICBjb25zdCBNRVRFUl9LRVkgPSAiZWxkZWhvZi12Ni1tZXRlci1yZWFkaW5ncy12NjEwIjsKICBjb25zdCBISVNUT1JZX1NFRURfS0VZID0gImVsZGVob2YtdjYtaGlzdG9yeS1zZWVkLXY2MTAiOwogIGNvbnN0IE1PTlRIUyA9IFsiSmFuIiwiRmViIiwiTcOkciIsIkFwciIsIk1haSIsIkp1biIsIkp1bCIsIkF1ZyIsIlNlcCIsIk9rdCIsIk5vdiIsIkRleiJdOwogIGNvbnN0IENPTE9SUyA9IHsgdG90YWw6IiM3MmRjNTciLCBoZWF0OiIjZmY5ZjQzIiwgYW5uZXg6IiM0ZDljZmYiLCByZXN0OiIjZjJkMTVmIiwgY29tcGFyZToiIzljN2RmZiIsIGNvc3Q6IiM1ZmM3YzIiLCBncmlkOiJyZ2JhKDE3MSwxOTgsMjIwLC4xNCkiLCB0ZXh0OiIjOTRhOGJhIiB9OwogIGNvbnN0IEhJU1RPUklDQUxfU0VFRCA9IHsiaGVhdFB1bXAiOnsiMjAyMy0xMiI6MTU1MCwiMjAyNC0wMSI6MTk4MCwiMjAyNC0wMiI6MTExMywiMjAyNC0wMyI6OTA3LCIyMDI0LTA0Ijo1MzUsIjIwMjQtMDUiOjE1NiwiMjAyNC0wNiI6MTEwLCIyMDI0LTA3IjoxMTAsIjIwMjQtMDgiOjEwOCwiMjAyNC0wOSI6MTk4LCIyMDI0LTEwIjo0OTAsIjIwMjQtMTEiOjEwMDMsIjIwMjQtMTIiOjEzMDUsIjIwMjUtMDEiOjE2OTQsIjIwMjUtMDIiOjE0NzgsIjIwMjUtMDMiOjEwMDUsIjIwMjUtMDQiOjQ5OCwiMjAyNS0wNSI6MzY3LCIyMDI1LTA2IjoxMzcsIjIwMjUtMDciOjEwNiwiMjAyNS0wOCI6MTI4LCIyMDI1LTA5IjoxODUsIjIwMjUtMTAiOjYwNywiMjAyNS0xMSI6MTA0MCwiMjAyNS0xMiI6MTI2NSwiMjAyNi0wMSI6MTg1NSwiMjAyNi0wMiI6MTQ4OCwiMjAyNi0wMyI6ODk1LCIyMDI2LTA0Ijo2NTYsIjIwMjYtMDUiOjMwMCwiMjAyNi0wNiI6MTI2LCIyMDI2LTA3IjoxMjgsIjIwMjYtMDgiOjEyMSwiMjAyNi0wOSI6MTM3fSwiYW5uZXgiOnsiMjAyNC0wMSI6MjEwLCIyMDI0LTAyIjoyMTAsIjIwMjQtMDMiOjIxOSwiMjAyNC0wNCI6MjAwLCIyMDI0LTA1IjoyMjIsIjIwMjQtMDYiOjE2NCwiMjAyNC0wNyI6MjE5LCIyMDI0LTA4IjoyMDEsIjIwMjQtMDkiOjE5MiwiMjAyNC0xMCI6MjM3LCIyMDI0LTExIjoyMjcsIjIwMjQtMTIiOjI2NiwiMjAyNS0wMSI6MjYxLCIyMDI1LTAyIjoyMzUsIjIwMjUtMDMiOjIyMSwiMjAyNS0wNCI6MjM4LCIyMDI1LTA1IjoyMjEsIjIwMjUtMDYiOjIzNywiMjAyNS0wNyI6MjQwLCIyMDI1LTA4IjoyMzIsIjIwMjUtMDkiOjMwOCwiMjAyNS0xMCI6MjIwLCIyMDI1LTExIjoyMzcsIjIwMjUtMTIiOjI3MywiMjAyNi0wMSI6MjQwLCIyMDI2LTAyIjoyMjUsIjIwMjYtMDMiOjI3MCwiMjAyNi0wNCI6MjE1LCIyMDI2LTA1IjoyMjAsIjIwMjYtMDYiOjI1MCwiMjAyNi0wNyI6MjEwLCIyMDI2LTA4IjoyNDAsIjIwMjYtMDkiOjI2NX0sInRvdGFsIjp7IjIwMjQtMDEiOjI0NTAsIjIwMjQtMDIiOjE2MTUsIjIwMjQtMDMiOjEzMjAsIjIwMjQtMDQiOjkzMywiMjAyNC0wNSI6NzMxLCIyMDI0LTA2Ijo1ODcsIjIwMjQtMDciOjYyMCwiMjAyNC0wOCI6NTQwLCIyMDI0LTA5Ijo2MTIsIjIwMjQtMTAiOjEwMTksIjIwMjQtMTEiOjE1MjEsIjIwMjQtMTIiOjE4NTcsIjIwMjUtMDEiOjIyODIsIjIwMjUtMDIiOjIwMjMsIjIwMjUtMDMiOjE0MTQsIjIwMjUtMDQiOjk2MCwiMjAyNS0wNSI6OTMzLCIyMDI1LTA2Ijo3NTEsIjIwMjUtMDciOjY4MCwiMjAyNS0wOCI6Njc2LCIyMDI1LTA5Ijo4MTQsIjIwMjUtMTAiOjExMDUsIjIwMjUtMTEiOjE2MTUsIjIwMjUtMTIiOjE4NTAsIjIwMjYtMDEiOjI0NTAsIjIwMjYtMDIiOjIwNjAsIjIwMjYtMDMiOjE1OTcsIjIwMjYtMDQiOjEwNTEsIjIwMjYtMDUiOjc2NywiMjAyNi0wNiI6NjYyLCIyMDI2LTA3Ijo2MDgsIjIwMjYtMDgiOjY4NSwiMjAyNi0wOSI6NjU1fX07CiAgY29uc3QgQkFTRUxJTkVfTUVURVJfUkVBRElORyA9IHtkYXRlOiIyMDI2LTEwLTAxIix0b3RhbDozNDI1NSxhbm5leDo5MDQ1LG5vdGU6IlN0YXJ0d2VydCBmw7xyIGRpZSBhdXRvbWF0aXNjaGUgQmVyZWNobnVuZyBhYiBPa3RvYmVyIDIwMjYifTsKICBjb25zdCAkID0gaWQgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwoKICBsZXQgc2V0dGluZ3MgPSBsb2FkU2V0dGluZ3MoKTsKICBsZXQgcmVjb3JkcyA9IGxvYWRSZWNvcmRzKCk7CiAgbGV0IHZhaWxsYW50TW9udGhzID0gbG9hZFZhaWxsYW50TW9udGhzKCk7CiAgbGV0IG9zdHJvbUxpdmUgPSBsb2FkT3N0cm9tQ2FjaGUoKTsKICBsZXQgb3N0cm9tQnVzeSA9IGZhbHNlOwogIGxldCBvc3Ryb21UaW1lciA9IG51bGw7CiAgbGV0IHRvYXN0VGltZXIgPSBudWxsOwogIGxldCByZXNpemVUaW1lciA9IG51bGw7CiAgbGV0IGN1cnJlbnRWaWV3ID0gImRhc2hib2FyZFZpZXciOwogIGxldCBtZXRlclJlYWRpbmdzID0gbG9hZE1ldGVyUmVhZGluZ3MoKTsKCiAgZnVuY3Rpb24gc2FmZUpzb25QYXJzZSh2YWx1ZSwgZmFsbGJhY2s9bnVsbCl7IHRyeXtyZXR1cm4gSlNPTi5wYXJzZSh2YWx1ZSk7fWNhdGNoe3JldHVybiBmYWxsYmFjazt9IH0KICBmdW5jdGlvbiBudWxsYWJsZU51bWJlcih2YWx1ZSl7IGlmKHZhbHVlPT09IiJ8fHZhbHVlPT09bnVsbHx8dmFsdWU9PT11bmRlZmluZWQpcmV0dXJuIG51bGw7IGNvbnN0IG49TnVtYmVyKHZhbHVlKTsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKT9uOm51bGw7IH0KICBmdW5jdGlvbiBzb3J0ZWQoaXRlbXM9cmVjb3Jkcyl7IHJldHVybiBbLi4uaXRlbXNdLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7IH0KICBmdW5jdGlvbiBjdXJyZW50TW9udGhLZXkoKXsgY29uc3QgZD1uZXcgRGF0ZSgpOyByZXR1cm4gYCR7ZC5nZXRGdWxsWWVhcigpfS0ke1N0cmluZyhkLmdldE1vbnRoKCkrMSkucGFkU3RhcnQoMiwiMCIpfWA7IH0KICBmdW5jdGlvbiBtb250aExhYmVsKG1vbnRoLGxvbmc9dHJ1ZSl7IGNvbnN0IFt5LG1dPVN0cmluZyhtb250aCkuc3BsaXQoIi0iKS5tYXAoTnVtYmVyKTsgaWYoIXl8fCFtKXJldHVybiBtb250aDsgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIsbG9uZz97bW9udGg6ImxvbmciLHllYXI6Im51bWVyaWMifTp7bW9udGg6InNob3J0Iix5ZWFyOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZSh5LG0tMSwxKSk7IH0KICBmdW5jdGlvbiBudW0odmFsdWUsZGlnaXRzPTApeyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcih2YWx1ZSkpP25ldyBJbnRsLk51bWJlckZvcm1hdCgiZGUtREUiLHttaW5pbXVtRnJhY3Rpb25EaWdpdHM6ZGlnaXRzLG1heGltdW1GcmFjdGlvbkRpZ2l0czpkaWdpdHN9KS5mb3JtYXQoTnVtYmVyKHZhbHVlKSk6IuKAkyI7IH0KICBmdW5jdGlvbiBldXJvKHZhbHVlKXsgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShOdW1iZXIodmFsdWUpKT9uZXcgSW50bC5OdW1iZXJGb3JtYXQoImRlLURFIix7c3R5bGU6ImN1cnJlbmN5IixjdXJyZW5jeToiRVVSIn0pLmZvcm1hdChOdW1iZXIodmFsdWUpKToi4oCTIjsgfQogIGZ1bmN0aW9uIHBjdCh2YWx1ZSl7IHJldHVybiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHZhbHVlKSk/YCR7dmFsdWU+MD8iKyI6IiJ9JHtudW0odmFsdWUsMSl9ICVgOiLigJMiOyB9CiAgZnVuY3Rpb24gZXNjYXBlSHRtbCh2YWx1ZSl7IHJldHVybiBTdHJpbmcodmFsdWU/PyIiKS5yZXBsYWNlKC9bJjw+IiddL2csY2g9Pih7IiYiOiImYW1wOyIsIjwiOiImbHQ7IiwiPiI6IiZndDsiLCJcIiI6IiZxdW90OyIsIiciOiImIzM5OyJ9W2NoXSkpOyB9CiAgZnVuY3Rpb24gY3N2Q2VsbCh2YWx1ZSl7IGNvbnN0IHM9U3RyaW5nKHZhbHVlPz8iIik7IHJldHVybiBgIiR7cy5yZXBsYWNlKC8iL2csJyIiJyl9ImA7IH0KICBmdW5jdGlvbiBkYXRlU3RhbXAoKXsgY29uc3QgZD1uZXcgRGF0ZSgpOyByZXR1cm4gYCR7ZC5nZXRGdWxsWWVhcigpfS0ke1N0cmluZyhkLmdldE1vbnRoKCkrMSkucGFkU3RhcnQoMiwiMCIpfS0ke1N0cmluZyhkLmdldERhdGUoKSkucGFkU3RhcnQoMiwiMCIpfWA7IH0KCiAgZnVuY3Rpb24gc2FuaXRpemVSZWNvcmQocmF3KXsKICAgIGNvbnN0IG1vbnRoPVN0cmluZyhyYXc/Lm1vbnRofHwiIik7CiAgICBpZighL15cZHs0fS1cZHsyfSQvLnRlc3QobW9udGgpKXJldHVybiBudWxsOwogICAgcmV0dXJuIHsKICAgICAgbW9udGgsCiAgICAgIGhlYXRQdW1wOm51bGxhYmxlTnVtYmVyKHJhdy5oZWF0UHVtcCksCiAgICAgIGFubmV4Om51bGxhYmxlTnVtYmVyKHJhdy5hbm5leCksCiAgICAgIHRvdGFsOm51bGxhYmxlTnVtYmVyKHJhdy50b3RhbCksCiAgICAgIHByaWNlQ3Q6bnVsbGFibGVOdW1iZXIocmF3LnByaWNlQ3QgPz8gcmF3LmF2ZXJhZ2VQcmljZUN0KSwKICAgICAgYmFzZUZlZTpudWxsYWJsZU51bWJlcihyYXcuYmFzZUZlZSksCiAgICAgIG5vdGU6U3RyaW5nKHJhdy5ub3RlfHwiIikudHJpbSgpLnNsaWNlKDAsODAwKSwKICAgICAgaGVhdEdlbmVyYXRlZDpudWxsYWJsZU51bWJlcihyYXcuaGVhdEdlbmVyYXRlZCksCiAgICAgIGhlYXRpbmdFbGVjdHJpY2l0eTpudWxsYWJsZU51bWJlcihyYXcuaGVhdGluZ0VsZWN0cmljaXR5KSwKICAgICAgZGh3RWxlY3RyaWNpdHk6bnVsbGFibGVOdW1iZXIocmF3LmRod0VsZWN0cmljaXR5KSwKICAgICAgaGVhdGluZ0hlYXQ6bnVsbGFibGVOdW1iZXIocmF3LmhlYXRpbmdIZWF0KSwKICAgICAgZGh3SGVhdDpudWxsYWJsZU51bWJlcihyYXcuZGh3SGVhdCksCiAgICAgIGhlYXRQdW1wU291cmNlOlN0cmluZyhyYXcuaGVhdFB1bXBTb3VyY2V8fCIiKS5zbGljZSgwLDYwKSwKICAgICAgaGVhdFB1bXBVcGRhdGVkQXQ6cmF3LmhlYXRQdW1wVXBkYXRlZEF0P1N0cmluZyhyYXcuaGVhdFB1bXBVcGRhdGVkQXQpOm51bGwsCiAgICAgIG1ldGVyUmVhZGluZ0RhdGU6cmF3Lm1ldGVyUmVhZGluZ0RhdGU/U3RyaW5nKHJhdy5tZXRlclJlYWRpbmdEYXRlKTpudWxsLAogICAgICBwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6cmF3LnByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZT9TdHJpbmcocmF3LnByZXZpb3VzTWV0ZXJSZWFkaW5nRGF0ZSk6bnVsbCwKICAgICAgdG90YWxNZXRlclJlYWRpbmc6bnVsbGFibGVOdW1iZXIocmF3LnRvdGFsTWV0ZXJSZWFkaW5nKSwKICAgICAgYW5uZXhNZXRlclJlYWRpbmc6bnVsbGFibGVOdW1iZXIocmF3LmFubmV4TWV0ZXJSZWFkaW5nKSwKICAgICAgbWV0ZXJTb3VyY2U6U3RyaW5nKHJhdy5tZXRlclNvdXJjZXx8IiIpLnNsaWNlKDAsNjApLAogICAgICBjbG9zZWQ6Qm9vbGVhbihyYXcuY2xvc2VkKSwKICAgICAgY2xvc2VkQXQ6cmF3LmNsb3NlZEF0P1N0cmluZyhyYXcuY2xvc2VkQXQpOm51bGwKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhbml0aXplUmVjb3JkcyhpdGVtcyl7CiAgICBjb25zdCBtYXA9bmV3IE1hcCgpOwogICAgZm9yKGNvbnN0IHJhdyBvZiBBcnJheS5pc0FycmF5KGl0ZW1zKT9pdGVtczpbXSl7IGNvbnN0IHI9c2FuaXRpemVSZWNvcmQocmF3KTsgaWYociltYXAuc2V0KHIubW9udGgscik7IH0KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLm1vbnRoLmxvY2FsZUNvbXBhcmUoYi5tb250aCkpOwogIH0KICBmdW5jdGlvbiBkZXJpdmVkKHIpeyBpZighW3I/LmhlYXRQdW1wLHI/LmFubmV4LHI/LnRvdGFsXS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpKXJldHVybiBudWxsOyByZXR1cm4gci50b3RhbC1yLmhlYXRQdW1wLXIuYW5uZXg7IH0KICBmdW5jdGlvbiBjb21wbGV0ZShyKXsgY29uc3QgcmVzdD1kZXJpdmVkKHIpOyByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0Pj0wOyB9CiAgZnVuY3Rpb24gcmVjb3JkQ29zdChyKXsKICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUocj8udG90YWwpKXJldHVybiBudWxsOwogICAgY29uc3QgcHJpY2U9TnVtYmVyLmlzRmluaXRlKHIucHJpY2VDdCk/ci5wcmljZUN0LzEwMDpOdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMik7CiAgICBjb25zdCBiYXNlPU51bWJlci5pc0Zpbml0ZShyLmJhc2VGZWUpP3IuYmFzZUZlZTpOdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApOwogICAgcmV0dXJuIHIudG90YWwqcHJpY2UrYmFzZTsKICB9CiAgZnVuY3Rpb24gcmVjb3JkQ29wKHIpeyByZXR1cm4gTnVtYmVyKHI/LmhlYXRQdW1wKT4wJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHI/LmhlYXRHZW5lcmF0ZWQpKT9OdW1iZXIoci5oZWF0R2VuZXJhdGVkKS9OdW1iZXIoci5oZWF0UHVtcCk6bnVsbDsgfQoKICBmdW5jdGlvbiByYXdTZXR0aW5ncygpeyBjb25zdCB2PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU0VUVElOR1NfS0VZKSx7fSk7IHJldHVybiB2JiZ0eXBlb2Ygdj09PSJvYmplY3QiJiYhQXJyYXkuaXNBcnJheSh2KT92Ont9OyB9CiAgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCl7CiAgICBjb25zdCByYXc9cmF3U2V0dGluZ3MoKTsKICAgIHJldHVybiB7CiAgICAgIC4uLnJhdywKICAgICAgZmFsbGJhY2tQcmljZTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5mYWxsYmFja1ByaWNlKSk/TnVtYmVyKHJhdy5mYWxsYmFja1ByaWNlKTpOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHJhdy5wcmljZSkpP051bWJlcihyYXcucHJpY2UpOjAuMzIsCiAgICAgIGRlZmF1bHRCYXNlRmVlOk51bWJlci5pc0Zpbml0ZShOdW1iZXIocmF3LmRlZmF1bHRCYXNlRmVlKSk/TnVtYmVyKHJhdy5kZWZhdWx0QmFzZUZlZSk6MCwKICAgICAgb3N0cm9tQXBwS2V5OlN0cmluZyhyYXcub3N0cm9tQXBwS2V5fHwiIiksCiAgICAgIG9zdHJvbUF1dG9SZWZyZXNoOnJhdy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlLAogICAgICBwcmVmZXJyZWRXaW5kb3dIb3VyczpbMSwyLDMsNF0uaW5jbHVkZXMoTnVtYmVyKHJhdy5wcmVmZXJyZWRXaW5kb3dIb3VycykpP051bWJlcihyYXcucHJlZmVycmVkV2luZG93SG91cnMpOjMKICAgIH07CiAgfQogIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncygpewogICAgY29uc3QgcHJldmlvdXM9cmF3U2V0dGluZ3MoKTsKICAgIGNvbnN0IG1lcmdlZD17Li4ucHJldmlvdXMsCiAgICAgIGZhbGxiYWNrUHJpY2U6TnVtYmVyKHNldHRpbmdzLmZhbGxiYWNrUHJpY2UpfHwwLAogICAgICBkZWZhdWx0QmFzZUZlZTpOdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWUpfHwwLAogICAgICBvc3Ryb21BcHBLZXk6U3RyaW5nKHNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiIpLAogICAgICBvc3Ryb21BdXRvUmVmcmVzaDpzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlLAogICAgICBwcmVmZXJyZWRXaW5kb3dIb3VyczpbMSwyLDMsNF0uaW5jbHVkZXMoTnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKSk/TnVtYmVyKHNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzKTozCiAgICB9OwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0VUVElOR1NfS0VZLEpTT04uc3RyaW5naWZ5KG1lcmdlZCkpOwogICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLm1lcmdlZH07CiAgfQoKICBmdW5jdGlvbiByZWFkUHJpbWFyeVJlY29yZHMoKXsgY29uc3QgcmF3PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oREFUQV9LRVkpLG51bGwpOyByZXR1cm4gQXJyYXkuaXNBcnJheShyYXcpP3Nhbml0aXplUmVjb3JkcyhyYXcpOm51bGw7IH0KICBmdW5jdGlvbiByZWFkU2hhZG93UmVjb3JkcygpeyBjb25zdCByYXc9c2FmZUpzb25QYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTSEFET1dfS0VZKSxudWxsKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9zYW5pdGl6ZVJlY29yZHMocmF3KTpbXTsgfQogIGZ1bmN0aW9uIGxvYWRSZWNvcmRzKCl7CiAgICBjb25zdCBwcmltYXJ5PXJlYWRQcmltYXJ5UmVjb3JkcygpOwogICAgaWYocHJpbWFyeSE9PW51bGwpcmV0dXJuIHByaW1hcnk7CiAgICBmb3IoY29uc3Qga2V5IG9mIFsiZWxkZWhvZi12MS1kYXRhIiwiZW5lcmhhdXMtdjEtZGF0YSJdKXsKICAgICAgY29uc3QgbGVnYWN5PXNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSxudWxsKTsKICAgICAgaWYoQXJyYXkuaXNBcnJheShsZWdhY3kpKXsKICAgICAgICBjb25zdCBtaWdyYXRlZD1zYW5pdGl6ZVJlY29yZHMobGVnYWN5KTsKICAgICAgICBpZihtaWdyYXRlZC5sZW5ndGgpbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkobWlncmF0ZWQpKTsKICAgICAgICByZXR1cm4gbWlncmF0ZWQ7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBbXTsKICB9CiAgZnVuY3Rpb24gc2F2ZVJlY29yZHMobmV4dCx7cmVhc29uPSLDhG5kZXJ1bmciLGFsbG93RW1wdHk9ZmFsc2V9PXt9KXsKICAgIGNvbnN0IGNsZWFuPXNhbml0aXplUmVjb3JkcyhuZXh0KTsKICAgIGNvbnN0IHByZXZpb3VzPXJlYWRQcmltYXJ5UmVjb3JkcygpfHxbXTsKICAgIGlmKCFhbGxvd0VtcHR5ICYmIHByZXZpb3VzLmxlbmd0aD4wICYmIGNsZWFuLmxlbmd0aD09PTApdGhyb3cgbmV3IEVycm9yKCJMZWVyZXIgTW9uYXRzYmVzdGFuZCB3aXJkIGF1cyBTaWNoZXJoZWl0c2dyw7xuZGVuIG5pY2h0IGF1dG9tYXRpc2NoIGdlc3BlaWNoZXJ0LiIpOwogICAgaWYocHJldmlvdXMubGVuZ3RoKXsKICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0hBRE9XX0tFWSxKU09OLnN0cmluZ2lmeShwcmV2aW91cykpOwogICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTSEFET1dfTUVUQV9LRVksSlNPTi5zdHJpbmdpZnkoe3NhdmVkQXQ6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLHJlYXNvbixyZWNvcmRzOnByZXZpb3VzLmxlbmd0aH0pKTsKICAgIH0KICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKERBVEFfS0VZLEpTT04uc3RyaW5naWZ5KGNsZWFuKSk7CiAgICByZWNvcmRzPWNsZWFuOwogICAgdXBkYXRlUmVjb3ZlcnlCYW5uZXIoKTsKICB9CiAgZnVuY3Rpb24gc2FuaXRpemVNZXRlclJlYWRpbmcocmF3KXsKICAgIGNvbnN0IGRhdGU9U3RyaW5nKHJhdz8uZGF0ZXx8IiIpOwogICAgY29uc3QgdG90YWw9bnVsbGFibGVOdW1iZXIocmF3Py50b3RhbCksYW5uZXg9bnVsbGFibGVOdW1iZXIocmF3Py5hbm5leCk7CiAgICBpZighL15cZHs0fS1cZHsyfS1cZHsyfSQvLnRlc3QoZGF0ZSl8fCFOdW1iZXIuaXNGaW5pdGUodG90YWwpfHwhTnVtYmVyLmlzRmluaXRlKGFubmV4KXx8dG90YWw8MHx8YW5uZXg8MClyZXR1cm4gbnVsbDsKICAgIHJldHVybiB7ZGF0ZSx0b3RhbCxhbm5leCxub3RlOlN0cmluZyhyYXc/Lm5vdGV8fCIiKS5zbGljZSgwLDE4MCl9OwogIH0KICBmdW5jdGlvbiBzYW5pdGl6ZU1ldGVyUmVhZGluZ3MoaXRlbXMpewogICAgY29uc3QgbWFwPW5ldyBNYXAoKTsKICAgIGZvcihjb25zdCByYXcgb2YgQXJyYXkuaXNBcnJheShpdGVtcyk/aXRlbXM6W10pe2NvbnN0IHI9c2FuaXRpemVNZXRlclJlYWRpbmcocmF3KTtpZihyKW1hcC5zZXQoci5kYXRlLHIpO30KICAgIHJldHVybiBbLi4ubWFwLnZhbHVlcygpXS5zb3J0KChhLGIpPT5hLmRhdGUubG9jYWxlQ29tcGFyZShiLmRhdGUpKTsKICB9CiAgZnVuY3Rpb24gbG9hZE1ldGVyUmVhZGluZ3MoKXtyZXR1cm4gc2FuaXRpemVNZXRlclJlYWRpbmdzKHNhZmVKc29uUGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oTUVURVJfS0VZKSxbXSkpO30KICBmdW5jdGlvbiBzYXZlTWV0ZXJSZWFkaW5ncyhuZXh0KXttZXRlclJlYWRpbmdzPXNhbml0aXplTWV0ZXJSZWFkaW5ncyhuZXh0KTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShNRVRFUl9LRVksSlNPTi5zdHJpbmdpZnkobWV0ZXJSZWFkaW5ncykpO30KICBmdW5jdGlvbiBsYXRlc3RNZXRlclJlYWRpbmcoKXtyZXR1cm4gbWV0ZXJSZWFkaW5ncy5hdCgtMSl8fG51bGw7fQogIGZ1bmN0aW9uIGRhdGVMYWJlbCh2YWx1ZSl7Y29uc3QgZD1uZXcgRGF0ZShgJHt2YWx1ZX1UMTI6MDA6MDBgKTtyZXR1cm4gTnVtYmVyLmlzTmFOKGQudmFsdWVPZigpKT92YWx1ZTpuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtkYXk6IjItZGlnaXQiLG1vbnRoOiIyLWRpZ2l0Iix5ZWFyOiJudW1lcmljIn0pLmZvcm1hdChkKTt9CiAgZnVuY3Rpb24gbmV4dE1vbnRoRmlyc3QoZGF0ZSl7Y29uc3QgW3ksbV09U3RyaW5nKGRhdGUpLnNwbGl0KCItIikubWFwKE51bWJlcik7Y29uc3QgZD1uZXcgRGF0ZSh5LG0sMSk7cmV0dXJuIGAke2QuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZC5nZXRNb250aCgpKzEpLnBhZFN0YXJ0KDIsIjAiKX0tMDFgO30KICBmdW5jdGlvbiBhcHBseUhpc3RvcmljYWxTZWVkKCl7CiAgICBpZihsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZX1NFRURfS0VZKSlyZXR1cm47CiAgICBjb25zdCBtYXA9bmV3IE1hcChyZWNvcmRzLm1hcChyPT5bci5tb250aCx7Li4ucn1dKSk7CiAgICBjb25zdCBtb250aHM9Wy4uLm5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKEhJU1RPUklDQUxfU0VFRC50b3RhbCksLi4uT2JqZWN0LmtleXMoSElTVE9SSUNBTF9TRUVELmFubmV4KSwuLi5PYmplY3Qua2V5cyhISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXApXSldLnNvcnQoKTsKICAgIGZvcihjb25zdCBtb250aCBvZiBtb250aHMpewogICAgICBjb25zdCByPW1hcC5nZXQobW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGh9KTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQudG90YWwsbW9udGgpKXIudG90YWw9SElTVE9SSUNBTF9TRUVELnRvdGFsW21vbnRoXTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQuYW5uZXgsbW9udGgpKXIuYW5uZXg9SElTVE9SSUNBTF9TRUVELmFubmV4W21vbnRoXTsKICAgICAgaWYoT2JqZWN0Lmhhc093bihISVNUT1JJQ0FMX1NFRUQuaGVhdFB1bXAsbW9udGgpKXsKICAgICAgICBjb25zdCBzZWVkPUhJU1RPUklDQUxfU0VFRC5oZWF0UHVtcFttb250aF07CiAgICAgICAgY29uc3Qga2VlcEV4aXN0aW5nPU51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSYmTWF0aC5hYnMoci5oZWF0UHVtcC1zZWVkKTw9MjsKICAgICAgICBpZigha2VlcEV4aXN0aW5nKXIuaGVhdFB1bXA9c2VlZDsKICAgICAgICBpZighci5oZWF0UHVtcFNvdXJjZSlyLmhlYXRQdW1wU291cmNlPSJoaXN0b3JpY2FsLXVzZXItZGF0YSI7CiAgICAgIH0KICAgICAgaWYobW9udGg9PT0iMjAyNC0wMyIpewogICAgICAgIGNvbnN0IG5vdGU9IlrDpGhsZXJ3ZWNoc2VsIEdlc2FtdHN0cm9tIGFtIDAxLjA0LjIwMjQ6IGFsdGVyIFrDpGhsZXIgNjIuMjk2IGtXaCwgbmV1ZXIgWsOkaGxlciAxOTcga1doOyBNb25hdHN2ZXJicmF1Y2gga29ycmVrdCBtaXQgMS4zMjAga1doIGJlcsO8Y2tzaWNodGlndC4iOwogICAgICAgIGlmKCFTdHJpbmcoci5ub3RlfHwiIikuaW5jbHVkZXMoIlrDpGhsZXJ3ZWNoc2VsIEdlc2FtdHN0cm9tIikpci5ub3RlPXIubm90ZT9gJHtyLm5vdGV9IOKAoiAke25vdGV9YDpub3RlOwogICAgICB9CiAgICAgIGlmKG1vbnRoPT09IjIwMjMtMTIiJiYhci5ub3RlKXIubm90ZT0iSGlzdG9yaXNjaCBpc3QgZsO8ciBEZXplbWJlciAyMDIzIG51ciBkZXIgV8Okcm1lcHVtcGVudmVyYnJhdWNoIGRva3VtZW50aWVydC4iOwogICAgICBtYXAuc2V0KG1vbnRoLHIpOwogICAgfQogICAgc2F2ZVJlY29yZHMoWy4uLm1hcC52YWx1ZXMoKV0se3JlYXNvbjoiSGlzdG9yaXNjaGUgVmVyYnJhdWNoc2RhdGVuIDIwMjTigJMwOS8yMDI2IMO8YmVybm9tbWVuIn0pOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWV9TRUVEX0tFWSxuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpOwogIH0KICBmdW5jdGlvbiBlbnN1cmVNZXRlckJhc2VsaW5lKCl7CiAgICBpZihtZXRlclJlYWRpbmdzLnNvbWUocj0+ci5kYXRlPT09QkFTRUxJTkVfTUVURVJfUkVBRElORy5kYXRlKSlyZXR1cm47CiAgICBpZihtZXRlclJlYWRpbmdzLmxlbmd0aD09PTApc2F2ZU1ldGVyUmVhZGluZ3MoW0JBU0VMSU5FX01FVEVSX1JFQURJTkddKTsKICB9CiAgZnVuY3Rpb24gbG9hZFZhaWxsYW50TW9udGhzKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFZBSUxMQU5UX01PTlRIU19LRVkpLFtdKTsgcmV0dXJuIEFycmF5LmlzQXJyYXkocmF3KT9yYXc6W107IH0KICBmdW5jdGlvbiBzYXZlVmFpbGxhbnRNb250aHMoKXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oVkFJTExBTlRfTU9OVEhTX0tFWSxKU09OLnN0cmluZ2lmeShBcnJheS5pc0FycmF5KHZhaWxsYW50TW9udGhzKT92YWlsbGFudE1vbnRoczpbXSkpOyB9CiAgZnVuY3Rpb24gbG9hZE9zdHJvbUNhY2hlKCl7IGNvbnN0IHJhdz1zYWZlSnNvblBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKE9TVFJPTV9DQUNIRV9LRVkpLG51bGwpOyByZXR1cm4gcmF3JiZyYXcuZ2VuZXJhdGVkQXQ/cmF3Om51bGw7IH0KICBmdW5jdGlvbiBzYXZlT3N0cm9tQ2FjaGUocGF5bG9hZCl7IG9zdHJvbUxpdmU9cGF5bG9hZHx8bnVsbDsgaWYocGF5bG9hZClsb2NhbFN0b3JhZ2Uuc2V0SXRlbShPU1RST01fQ0FDSEVfS0VZLEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTsgZWxzZSBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShPU1RST01fQ0FDSEVfS0VZKTsgfQoKICBmdW5jdGlvbiB1cGRhdGVSZWNvdmVyeUJhbm5lcigpewogICAgY29uc3QgcHJpbWFyeT1yZWFkUHJpbWFyeVJlY29yZHMoKTsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgY29uc3Qgc2hvdz0oIXByaW1hcnl8fHByaW1hcnkubGVuZ3RoPT09MCkmJnNoYWRvdy5sZW5ndGg+MDsKICAgICQoInJlY292ZXJ5QmFubmVyIikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwhc2hvdyk7CiAgfQogIGZ1bmN0aW9uIHJlc3RvcmVTaGFkb3coKXsKICAgIGNvbnN0IHNoYWRvdz1yZWFkU2hhZG93UmVjb3JkcygpOwogICAgaWYoIXNoYWRvdy5sZW5ndGgpcmV0dXJuOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oREFUQV9LRVksSlNPTi5zdHJpbmdpZnkoc2hhZG93KSk7CiAgICByZWNvcmRzPXNoYWRvdzsKICAgIHRvYXN0KGAke3NoYWRvdy5sZW5ndGh9IE1vbmF0c3dlcnRlIHdpZWRlcmhlcmdlc3RlbGx0YCk7CiAgICByZW5kZXJBbGwoKTsKICB9CgogIGZ1bmN0aW9uIHRvYXN0KG1lc3NhZ2UpeyBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7ICQoInRvYXN0IikudGV4dENvbnRlbnQ9bWVzc2FnZTsgJCgidG9hc3QiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsgdG9hc3RUaW1lcj1zZXRUaW1lb3V0KCgpPT4kKCJ0b2FzdCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpLDI2MDApOyB9CiAgZnVuY3Rpb24gc2V0U3RhdHVzKGlkLHRleHQsa2luZD0iIil7IGNvbnN0IGVsPSQoaWQpOyBlbC50ZXh0Q29udGVudD10ZXh0fHwiIjsgZWwuY2xhc3NOYW1lPWBzdGF0dXMtdGV4dCAke2tpbmR9YC50cmltKCk7IH0KCiAgZnVuY3Rpb24gc3dpdGNoVmlldyhpZCl7CiAgICBjdXJyZW50Vmlldz1pZDsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi52aWV3IikuZm9yRWFjaCh2PT52LmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsdi5pZD09PWlkKSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIuYm90dG9tLW5hdiBbZGF0YS1uYXZdIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsYi5kYXRhc2V0Lm5hdj09PWlkKSk7CiAgICB3aW5kb3cuc2Nyb2xsVG8oe3RvcDowLGJlaGF2aW9yOiJpbnN0YW50In0pOwogICAgaWYoaWQ9PT0iYW5hbHlzaXNWaWV3IilyZW5kZXJBbmFseXNpcygpOwogICAgaWYoaWQ9PT0iY29uc3VtcHRpb25WaWV3IilyZW5kZXJSZWNvcmRzKCk7CiAgICBpZihpZD09PSJkYXRhVmlldyIpcmVuZGVyRGF0YSgpOwogICAgaWYoaWQ9PT0iZGFzaGJvYXJkVmlldyIpcmVuZGVyRGFzaGJvYXJkKCk7CiAgfQoKICBmdW5jdGlvbiB5ZWFycygpeyByZXR1cm4gWy4uLm5ldyBTZXQocmVjb3Jkcy5tYXAocj0+TnVtYmVyKHIubW9udGguc2xpY2UoMCw0KSkpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKV0uc29ydCgoYSxiKT0+Yi1hKTsgfQogIGZ1bmN0aW9uIGxhdGVzdFJlY29yZCgpeyByZXR1cm4gc29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkuYXQoLTEpfHxzb3J0ZWQoKS5hdCgtMSl8fG51bGw7IH0KICBmdW5jdGlvbiByZWNvcmRGb3JNb250aChtb250aCl7IHJldHVybiByZWNvcmRzLmZpbmQocj0+ci5tb250aD09PW1vbnRoKXx8bnVsbDsgfQoKICBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmQoKXsKICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RSZWNvcmQoKTsKICAgICQoImxhdGVzdE1vbnRoVGl0bGUiKS50ZXh0Q29udGVudD1sYXRlc3Q/bW9udGhMYWJlbChsYXRlc3QubW9udGgpOiJOb2NoIGtlaW5lIE1vbmF0c3dlcnRlIjsKICAgIGNvbnN0IHJlc3Q9bGF0ZXN0P2Rlcml2ZWQobGF0ZXN0KTpudWxsOwogICAgY29uc3QgbWV0cmljcz1sYXRlc3Q/WwogICAgICBbIkdlc2FtdCIsYCR7bnVtKGxhdGVzdC50b3RhbCwxKX0ga1doYCxsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZT9gYXVzIFrDpGhsZXJzdGFuZCAke2RhdGVMYWJlbChsYXRlc3QubWV0ZXJSZWFkaW5nRGF0ZSl9YDoiZG9rdW1lbnRpZXJ0Il0sCiAgICAgIFsiV8Okcm1lcHVtcGUiLGAke251bShsYXRlc3QuaGVhdFB1bXAsMSl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKGxhdGVzdC50b3RhbCkmJmxhdGVzdC50b3RhbD4wJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LmhlYXRQdW1wKT9gJHtudW0obGF0ZXN0LmhlYXRQdW1wL2xhdGVzdC50b3RhbCoxMDAsMSl9ICUgQW50ZWlsYDoi4oCTIl0sCiAgICAgIFsiQWx0ZW50ZWlsIixgJHtudW0obGF0ZXN0LmFubmV4LDEpfSBrV2hgLGxhdGVzdC5tZXRlclJlYWRpbmdEYXRlP2Baw6RobGVyICR7bnVtKGxhdGVzdC5hbm5leE1ldGVyUmVhZGluZywwKX0ga1doYDpOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmbGF0ZXN0LnRvdGFsPjAmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QuYW5uZXgpP2Ake251bShsYXRlc3QuYW5uZXgvbGF0ZXN0LnRvdGFsKjEwMCwxKX0gJSBBbnRlaWxgOiLigJMiXSwKICAgICAgWyJTY2hsZWUvS2x1cyIsYCR7bnVtKHJlc3QsMSl9IGtXaGAsTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZOdW1iZXIuaXNGaW5pdGUobGF0ZXN0LnRvdGFsKSYmbGF0ZXN0LnRvdGFsPjA/YCR7bnVtKHJlc3QvbGF0ZXN0LnRvdGFsKjEwMCwxKX0gJSBBbnRlaWxgOiJhdXRvbWF0aXNjaCJdLAogICAgICBbIktvc3RlbiIsZXVybyhyZWNvcmRDb3N0KGxhdGVzdCkpLE51bWJlci5pc0Zpbml0ZShsYXRlc3QucHJpY2VDdCk/YCR7bnVtKGxhdGVzdC5wcmljZUN0LDIpfSBjdC9rV2hgOiJGYWxsYmFjay1QcmVpcyJdCiAgICBdOltbIkdlc2FtdCIsIuKAkyIsIk1vbmF0IGVpbnRyYWdlbiJdLFsiV8Okcm1lcHVtcGUiLCLigJMiLCIiXSxbIkFsdGVudGVpbCIsIuKAkyIsIiJdLFsiU2NobGVlL0tsdXMiLCLigJMiLCIiXSxbIktvc3RlbiIsIuKAkyIsIiJdXTsKICAgICQoImxhdGVzdE1ldHJpY3MiKS5pbm5lckhUTUw9bWV0cmljcy5tYXAoKFtsYWJlbCx2YWx1ZSxzbWFsbF0pPT5gPGFydGljbGU+PHNwYW4+JHtsYWJlbH08L3NwYW4+PHN0cm9uZz4ke3ZhbHVlfTwvc3Ryb25nPjxzbWFsbD4ke3NtYWxsfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgY29uc3QgY29tcGFyZT1sYXRlc3Q/cmVjb3JkRm9yTW9udGgoYCR7TnVtYmVyKGxhdGVzdC5tb250aC5zbGljZSgwLDQpKS0xfS0ke2xhdGVzdC5tb250aC5zbGljZSg1LDcpfWApOm51bGw7CiAgICBjb25zdCBkZWx0YT1sYXRlc3QmJmNvbXBhcmUmJk51bWJlci5pc0Zpbml0ZShsYXRlc3QudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoY29tcGFyZS50b3RhbCkmJmNvbXBhcmUudG90YWwhPT0wPyhsYXRlc3QudG90YWwtY29tcGFyZS50b3RhbCkvY29tcGFyZS50b3RhbCoxMDA6bnVsbDsKICAgIGNvbnN0IGNvbXA9JCgibGF0ZXN0Q29tcGFyaXNvbiIpOwogICAgY29tcC5jbGFzc05hbWU9ImNvbXBhcmlzb24tbGluZSBuZXV0cmFsIjsKICAgIGlmKE51bWJlci5pc0Zpbml0ZShkZWx0YSkpewogICAgICBjb21wLnRleHRDb250ZW50PWBadW0gZ2xlaWNoZW4gTW9uYXQgZGVzIFZvcmphaHJlczogJHtwY3QoZGVsdGEpfSAoJHtudW0obGF0ZXN0LnRvdGFsLWNvbXBhcmUudG90YWwsMSl9IGtXaCkuYDsKICAgICAgY29tcC5jbGFzc05hbWU9YGNvbXBhcmlzb24tbGluZSAke2RlbHRhPjA/InBvc2l0aXZlIjpkZWx0YTwwPyJuZWdhdGl2ZSI6Im5ldXRyYWwifWA7CiAgICB9ZWxzZSBjb21wLnRleHRDb250ZW50PWxhdGVzdD8iRsO8ciBkaWVzZW4gTW9uYXQgaXN0IG5vY2gga2VpbiB2b2xsc3TDpG5kaWdlciBWb3JqYWhyZXN2ZXJnbGVpY2ggdm9yaGFuZGVuLiI6IlRyYWdlIGRlbiBlcnN0ZW4gTW9uYXRzd2VydCBlaW4uIjsKICAgIGRyYXdEYXNoYm9hcmRDb25zdW1wdGlvbigpOwogICAgcmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJSZWNvcmRzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3Qgc2VsZWN0PSQoInJlY29yZFllYXJGaWx0ZXIiKTsKICAgIGNvbnN0IGN1cnJlbnQ9c2VsZWN0LnZhbHVlfHwiYWxsIjsKICAgIHNlbGVjdC5pbm5lckhUTUw9JzxvcHRpb24gdmFsdWU9ImFsbCI+QWxsZSBKYWhyZTwvb3B0aW9uPicreXMubWFwKHk9PmA8b3B0aW9uIHZhbHVlPSIke3l9Ij4ke3l9PC9vcHRpb24+YCkuam9pbigiIik7CiAgICBzZWxlY3QudmFsdWU9eXMuaW5jbHVkZXMoTnVtYmVyKGN1cnJlbnQpKT9jdXJyZW50OiJhbGwiOwogICAgY29uc3QgZmlsdGVyZWQ9c29ydGVkKCkucmV2ZXJzZSgpLmZpbHRlcihyPT5zZWxlY3QudmFsdWU9PT0iYWxsInx8ci5tb250aC5zdGFydHNXaXRoKGAke3NlbGVjdC52YWx1ZX0tYCkpOwogICAgJCgicmVjb3JkQ291bnQiKS50ZXh0Q29udGVudD1gJHtmaWx0ZXJlZC5sZW5ndGh9ICR7ZmlsdGVyZWQubGVuZ3RoPT09MT8iTW9uYXQiOiJNb25hdGUifWA7CiAgICBpZighZmlsdGVyZWQubGVuZ3RoKXsgJCgicmVjb3JkTGlzdCIpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPjxzdHJvbmc+Tm9jaCBrZWluZSBNb25hdHN3ZXJ0ZSBpbiBkaWVzZXIgQXVzd2FobC48L3N0cm9uZz48c3Bhbj5aw6RobGVyc3TDpG5kZSB1bmQgbXlWQUlMTEFOVC1DU1YgZXJ6ZXVnZW4gZGllIE1vbmF0c3dlcnRlIGF1dG9tYXRpc2NoLjwvc3Bhbj48L2Rpdj4nOyByZXR1cm47IH0KICAgICQoInJlY29yZExpc3QiKS5pbm5lckhUTUw9ZmlsdGVyZWQubWFwKHI9PnsKICAgICAgY29uc3QgcmVzdD1kZXJpdmVkKHIpLCBpbnZhbGlkPU51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwOwogICAgICBjb25zdCBzdGF0dXM9aW52YWxpZD8iVW5wbGF1c2liZWwiOmNvbXBsZXRlKHIpPyJ2b2xsc3TDpG5kaWciOiJ1bnZvbGxzdMOkbmRpZyI7CiAgICAgIGNvbnN0IHNvdXJjZT1yLm1ldGVyUmVhZGluZ0RhdGU/YCDigKIgWsOkaGxlciBiaXMgJHtkYXRlTGFiZWwoci5tZXRlclJlYWRpbmdEYXRlKX1gOnIuaGVhdFB1bXBTb3VyY2U/LnN0YXJ0c1dpdGgoIm15dmFpbGxhbnQiKT8iIOKAoiBXw6RybWVwdW1wZSBhdXMgQ1NWIjoiIjsKICAgICAgcmV0dXJuIGA8YXJ0aWNsZSBjbGFzcz0icmVjb3JkLXJvdyAke2ludmFsaWQ/ImludmFsaWQiOiIifSI+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLW1vbnRoIj48c3Ryb25nPiR7ZXNjYXBlSHRtbChtb250aExhYmVsKHIubW9udGgpKX08L3N0cm9uZz48c21hbGw+JHtzdGF0dXN9JHtzb3VyY2V9JHtyLm5vdGU/YCDigKIgJHtlc2NhcGVIdG1sKHIubm90ZS5zbGljZSgwLDcwKSl9YDoiIn08L3NtYWxsPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+R2VzYW10PC9zcGFuPjxzdHJvbmc+JHtudW0oci50b3RhbCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5Xw6RybWVwdW1wZTwvc3Bhbj48c3Ryb25nPiR7bnVtKHIuaGVhdFB1bXAsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlY29yZC12YWx1ZSI+PHNwYW4+QWx0ZW50ZWlsPC9zcGFuPjxzdHJvbmc+JHtudW0oci5hbm5leCwxKX0ga1doPC9zdHJvbmc+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVjb3JkLXZhbHVlIj48c3Bhbj5TY2hsZWUvS2x1czwvc3Bhbj48c3Ryb25nPiR7bnVtKHJlc3QsMSl9IGtXaDwvc3Ryb25nPjwvZGl2PgogICAgICAgIDxzcGFuIGNsYXNzPSJyZWNvcmQtc3RhdHVzLWJhZGdlIj4ke3N0YXR1c308L3NwYW4+CiAgICAgIDwvYXJ0aWNsZT5gOwogICAgfSkuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiBvcGVuTWV0ZXJNb2RhbCgpewogICAgY29uc3QgcHJldmlvdXM9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighcHJldmlvdXMpe2FsZXJ0KCJFcyBmZWhsdCBlaW4gQXVzZ2FuZ3N6w6RobGVyc3RhbmQuIik7cmV0dXJuO30KICAgICQoIm1ldGVyRGF0ZSIpLnZhbHVlPW5leHRNb250aEZpcnN0KHByZXZpb3VzLmRhdGUpOwogICAgJCgibWV0ZXJUb3RhbCIpLnZhbHVlPSIiOwogICAgJCgibWV0ZXJBbm5leCIpLnZhbHVlPSIiOwogICAgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IiI7CiAgICB1cGRhdGVNZXRlclByZXZpZXcoKTsKICAgICQoIm1ldGVyTW9kYWwiKS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsKICAgIGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9ImhpZGRlbiI7CiAgICBzZXRUaW1lb3V0KCgpPT4kKCJtZXRlclRvdGFsIikuZm9jdXMoKSw1MCk7CiAgfQogIGZ1bmN0aW9uIGNsb3NlTWV0ZXJNb2RhbCgpeyAkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7IGRvY3VtZW50LmJvZHkuc3R5bGUub3ZlcmZsb3c9IiI7IH0KICBmdW5jdGlvbiB1cGRhdGVNZXRlclByZXZpZXcoKXsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXJldHVybjsKICAgIGNvbnN0IGRhdGU9JCgibWV0ZXJEYXRlIikudmFsdWV8fG5leHRNb250aEZpcnN0KHByZXZpb3VzLmRhdGUpOwogICAgY29uc3QgdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpOwogICAgJCgibWV0ZXJQcmV2aW91cyIpLmlubmVySFRNTD1gVm9yaGVyaWdlciBTdGFuZDogPHN0cm9uZz4ke2RhdGVMYWJlbChwcmV2aW91cy5kYXRlKX08L3N0cm9uZz4gwrcgR2VzYW10IDxzdHJvbmc+JHtudW0ocHJldmlvdXMudG90YWwsMCl9IGtXaDwvc3Ryb25nPiDCtyBBbHRlbnRlaWwgPHN0cm9uZz4ke251bShwcmV2aW91cy5hbm5leCwwKX0ga1doPC9zdHJvbmc+YDsKICAgICQoIm1ldGVyVGFyZ2V0TW9udGgiKS50ZXh0Q29udGVudD1gQmVyZWNobmV0IHdpcmQgZGVyIFZlcmJyYXVjaCBmw7xyICR7bW9udGhMYWJlbCh0YXJnZXRNb250aCl9LmA7CiAgICBjb25zdCB0b3RhbD1udWxsYWJsZU51bWJlcigkKCJtZXRlclRvdGFsIikudmFsdWUpLGFubmV4PW51bGxhYmxlTnVtYmVyKCQoIm1ldGVyQW5uZXgiKS52YWx1ZSk7CiAgICBpZihOdW1iZXIuaXNGaW5pdGUodG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoYW5uZXgpKXsKICAgICAgY29uc3QgdG90YWxVc2U9dG90YWwtcHJldmlvdXMudG90YWwsYW5uZXhVc2U9YW5uZXgtcHJldmlvdXMuYW5uZXg7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKSxoZWF0PWV4aXN0aW5nPy5oZWF0UHVtcDsKICAgICAgY29uc3QgcmVzdD1OdW1iZXIuaXNGaW5pdGUoaGVhdCk/dG90YWxVc2UtYW5uZXhVc2UtaGVhdDpudWxsOwogICAgICAkKCJtZXRlclByZXZpZXciKS5pbm5lckhUTUw9YEdlc2FtdDogPHN0cm9uZz4ke251bSh0b3RhbFVzZSwxKX0ga1doPC9zdHJvbmc+IMK3IEFsdGVudGVpbDogPHN0cm9uZz4ke251bShhbm5leFVzZSwxKX0ga1doPC9zdHJvbmc+JHtOdW1iZXIuaXNGaW5pdGUoaGVhdCk/YCDCtyBXw6RybWVwdW1wZTogPHN0cm9uZz4ke251bShoZWF0LDEpfSBrV2g8L3N0cm9uZz4gwrcgU2NobGVlL0tsdXM6IDxzdHJvbmc+JHtudW0ocmVzdCwxKX0ga1doPC9zdHJvbmc+YDpgIMK3IFfDpHJtZXB1bXBlOiA8c3Ryb25nPkNTViBmZWhsdDwvc3Ryb25nPmB9YDsKICAgICAgJCgibWV0ZXJQcmV2aWV3IikuY2xhc3NMaXN0LnRvZ2dsZSgiZXJyb3IiLHRvdGFsVXNlPDB8fGFubmV4VXNlPDB8fChOdW1iZXIuaXNGaW5pdGUocmVzdCkmJnJlc3Q8MCkpOwogICAgfWVsc2V7CiAgICAgICQoIm1ldGVyUHJldmlldyIpLnRleHRDb250ZW50PSJNb25hdHN2ZXJicsOkdWNoZSB3ZXJkZW4gYXVzIGRlciBEaWZmZXJlbnogenVtIHZvcmhlcmlnZW4gWsOkaGxlcnN0YW5kIGJlcmVjaG5ldC4iOwogICAgICAkKCJtZXRlclByZXZpZXciKS5jbGFzc0xpc3QucmVtb3ZlKCJlcnJvciIpOwogICAgfQogIH0KICBmdW5jdGlvbiBzYXZlTWV0ZXJSZWFkaW5nRnJvbUZvcm0oZXZlbnQpewogICAgZXZlbnQucHJldmVudERlZmF1bHQoKTsKICAgIGNvbnN0IHByZXZpb3VzPWxhdGVzdE1ldGVyUmVhZGluZygpOwogICAgaWYoIXByZXZpb3VzKXJldHVybjsKICAgIGNvbnN0IGRhdGU9JCgibWV0ZXJEYXRlIikudmFsdWUsdG90YWw9bnVsbGFibGVOdW1iZXIoJCgibWV0ZXJUb3RhbCIpLnZhbHVlKSxhbm5leD1udWxsYWJsZU51bWJlcigkKCJtZXRlckFubmV4IikudmFsdWUpOwogICAgaWYoIS9eXGR7NH0tXGR7Mn0tXGR7Mn0kLy50ZXN0KGRhdGUpKXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkJpdHRlIGVpbiBnw7xsdGlnZXMgQWJsZXNlZGF0dW0gd8OkaGxlbi4iOyByZXR1cm47IH0KICAgIGlmKGRhdGU8PXByZXZpb3VzLmRhdGUpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1gRGFzIERhdHVtIG11c3MgbmFjaCBkZW0gbGV0enRlbiBTdGFuZCB2b20gJHtkYXRlTGFiZWwocHJldmlvdXMuZGF0ZSl9IGxpZWdlbi5gOyByZXR1cm47IH0KICAgIGlmKCFOdW1iZXIuaXNGaW5pdGUodG90YWwpfHwhTnVtYmVyLmlzRmluaXRlKGFubmV4KSl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJCaXR0ZSBiZWlkZSBaw6RobGVyc3TDpG5kZSBlaW50cmFnZW4uIjsgcmV0dXJuOyB9CiAgICBpZih0b3RhbDxwcmV2aW91cy50b3RhbCl7ICQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PSJEZXIgR2VzYW10esOkaGxlcnN0YW5kIGlzdCBrbGVpbmVyIGFscyBkZXIgdm9yaGVyaWdlIFN0YW5kLiBFaW4gbmV1ZXIgWsOkaGxlciBtw7xzc3RlIHNlcGFyYXQgYmVyw7xja3NpY2h0aWd0IHdlcmRlbi4iOyByZXR1cm47IH0KICAgIGlmKGFubmV4PHByZXZpb3VzLmFubmV4KXsgJCgibWV0ZXJWYWxpZGF0aW9uIikudGV4dENvbnRlbnQ9IkRlciBBbHRlbnRlaWwtWsOkaGxlcnN0YW5kIGlzdCBrbGVpbmVyIGFscyBkZXIgdm9yaGVyaWdlIFN0YW5kLiI7IHJldHVybjsgfQogICAgY29uc3QgdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpLHRvdGFsVXNlPXRvdGFsLXByZXZpb3VzLnRvdGFsLGFubmV4VXNlPWFubmV4LXByZXZpb3VzLmFubmV4OwogICAgY29uc3QgZXhpc3Rpbmc9cmVjb3JkRm9yTW9udGgodGFyZ2V0TW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6dGFyZ2V0TW9udGh9KTsKICAgIGNvbnN0IHJlc3Q9TnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmhlYXRQdW1wKT90b3RhbFVzZS1hbm5leFVzZS1leGlzdGluZy5oZWF0UHVtcDpudWxsOwogICAgaWYoTnVtYmVyLmlzRmluaXRlKHJlc3QpJiZyZXN0PC0uMDEpeyAkKCJtZXRlclZhbGlkYXRpb24iKS50ZXh0Q29udGVudD1gVW5wbGF1c2liZWw6IE5hY2ggQWJ6dWcgdm9uIFfDpHJtZXB1bXBlIHVuZCBBbHRlbnRlaWwgZXJnaWJ0IFNjaGxlZS9LbHVzICR7bnVtKHJlc3QsMSl9IGtXaC5gOyByZXR1cm47IH0KICAgIGNvbnN0IG5leHRSZWNvcmQ9ey4uLmV4aXN0aW5nLHRvdGFsOnRvdGFsVXNlLGFubmV4OmFubmV4VXNlLG1ldGVyUmVhZGluZ0RhdGU6ZGF0ZSxwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6cHJldmlvdXMuZGF0ZSx0b3RhbE1ldGVyUmVhZGluZzp0b3RhbCxhbm5leE1ldGVyUmVhZGluZzphbm5leCxtZXRlclNvdXJjZToiY3VtdWxhdGl2ZS1yZWFkaW5ncyJ9OwogICAgY29uc3QgbmV4dD1yZWNvcmRzLmZpbHRlcihyPT5yLm1vbnRoIT09dGFyZ2V0TW9udGgpO25leHQucHVzaChuZXh0UmVjb3JkKTsKICAgIHRyeXsKICAgICAgc2F2ZVJlY29yZHMobmV4dCx7cmVhc29uOmBaw6RobGVyc3TDpG5kZSAke2RhdGVMYWJlbChkYXRlKX0gZ2VzcGVpY2hlcnRgfSk7CiAgICAgIHNhdmVNZXRlclJlYWRpbmdzKFsuLi5tZXRlclJlYWRpbmdzLHtkYXRlLHRvdGFsLGFubmV4LG5vdGU6YFZlcmJyYXVjaCAke3RhcmdldE1vbnRofWB9XSk7CiAgICB9Y2F0Y2goZXJyb3IpeyQoIm1ldGVyVmFsaWRhdGlvbiIpLnRleHRDb250ZW50PWVycm9yLm1lc3NhZ2U7cmV0dXJuO30KICAgIGNsb3NlTWV0ZXJNb2RhbCgpO3JlbmRlckFsbCgpOwogICAgdG9hc3QoTnVtYmVyLmlzRmluaXRlKGV4aXN0aW5nLmhlYXRQdW1wKT9gJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0gdm9sbHN0w6RuZGlnIGJlcmVjaG5ldGA6YFrDpGhsZXJzdMOkbmRlIGdlc3BlaWNoZXJ0IMK3IFfDpHJtZXB1bXBlbi1DU1YgZmVobHQgbm9jaGApOwogIH0KICBmdW5jdGlvbiB1bmRvTGF0ZXN0TWV0ZXJSZWFkaW5nKCl7CiAgICBpZihtZXRlclJlYWRpbmdzLmxlbmd0aDw9MSlyZXR1cm47CiAgICBjb25zdCBsYXRlc3Q9bWV0ZXJSZWFkaW5ncy5hdCgtMSkscHJldmlvdXM9bWV0ZXJSZWFkaW5ncy5hdCgtMiksdGFyZ2V0TW9udGg9cHJldmlvdXMuZGF0ZS5zbGljZSgwLDcpOwogICAgaWYoIWNvbmZpcm0oYFrDpGhsZXJzdGFuZCB2b20gJHtkYXRlTGFiZWwobGF0ZXN0LmRhdGUpfSB6dXLDvGNrbmVobWVuPyBEaWUgZGFyYXVzIGJlcmVjaG5ldGVuIFdlcnRlIGbDvHIgJHttb250aExhYmVsKHRhcmdldE1vbnRoKX0gd2VyZGVuIGVudGZlcm50LmApKXJldHVybjsKICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZEZvck1vbnRoKHRhcmdldE1vbnRoKTsKICAgIGlmKGV4aXN0aW5nKXsKICAgICAgY29uc3QgY2xlYXJlZD17Li4uZXhpc3RpbmcsdG90YWw6bnVsbCxhbm5leDpudWxsLG1ldGVyUmVhZGluZ0RhdGU6bnVsbCxwcmV2aW91c01ldGVyUmVhZGluZ0RhdGU6bnVsbCx0b3RhbE1ldGVyUmVhZGluZzpudWxsLGFubmV4TWV0ZXJSZWFkaW5nOm51bGwsbWV0ZXJTb3VyY2U6IiJ9OwogICAgICBjb25zdCBuZXh0PXJlY29yZHMuZmlsdGVyKHI9PnIubW9udGghPT10YXJnZXRNb250aCk7bmV4dC5wdXNoKGNsZWFyZWQpO3NhdmVSZWNvcmRzKG5leHQse3JlYXNvbjpgTGV0enRlbiBaw6RobGVyc3RhbmQgJHtsYXRlc3QuZGF0ZX0genVyw7xja2dlbm9tbWVuYH0pOwogICAgfQogICAgc2F2ZU1ldGVyUmVhZGluZ3MobWV0ZXJSZWFkaW5ncy5zbGljZSgwLC0xKSk7cmVuZGVyQWxsKCk7dG9hc3QoIkxldHp0ZW4gWsOkaGxlcnN0YW5kIHp1csO8Y2tnZW5vbW1lbiIpOwogIH0KCiAgZnVuY3Rpb24gYW5hbHlzaXNZZWFyUm93cyh5ZWFyKXsgcmV0dXJuIHJlY29yZHMuZmlsdGVyKHI9PnIubW9udGguc3RhcnRzV2l0aChgJHt5ZWFyfS1gKSkuc29ydCgoYSxiKT0+YS5tb250aC5sb2NhbGVDb21wYXJlKGIubW9udGgpKTsgfQogIGZ1bmN0aW9uIGFubnVhbFN1bXMocm93cyl7CiAgICByZXR1cm4gcm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKWEudG90YWwrPXIudG90YWw7IGlmKE51bWJlci5pc0Zpbml0ZShyLmhlYXRQdW1wKSlhLmhlYXQrPXIuaGVhdFB1bXA7IGlmKE51bWJlci5pc0Zpbml0ZShyLmFubmV4KSlhLmFubmV4Kz1yLmFubmV4OyBjb25zdCByZXN0PWRlcml2ZWQocik7IGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdD49MClhLnJlc3QrPXJlc3Q7IGNvbnN0IGNvc3Q9cmVjb3JkQ29zdChyKTsgaWYoTnVtYmVyLmlzRmluaXRlKGNvc3QpKWEuY29zdCs9Y29zdDsgaWYoTnVtYmVyLmlzRmluaXRlKHIudG90YWwpKWEuY291bnQrKzsgcmV0dXJuIGE7IH0se3RvdGFsOjAsaGVhdDowLGFubmV4OjAscmVzdDowLGNvc3Q6MCxjb3VudDowfSk7CiAgfQogIGZ1bmN0aW9uIHJlbmRlckFuYWx5c2lzKCl7CiAgICBjb25zdCB5cz15ZWFycygpOwogICAgY29uc3QgeWVhclNlbGVjdD0kKCJhbmFseXNpc1llYXIiKSwgY29tcGFyZVNlbGVjdD0kKCJhbmFseXNpc0NvbXBhcmVZZWFyIik7CiAgICBjb25zdCBwcmlvcj1OdW1iZXIoeWVhclNlbGVjdC52YWx1ZSk7IGNvbnN0IHNlbGVjdGVkPXlzLmluY2x1ZGVzKHByaW9yKT9wcmlvcjooeXNbMF18fG5ldyBEYXRlKCkuZ2V0RnVsbFllYXIoKSk7CiAgICB5ZWFyU2VsZWN0LmlubmVySFRNTD0oeXMubGVuZ3RoP3lzOltuZXcgRGF0ZSgpLmdldEZ1bGxZZWFyKCldKS5tYXAoeT0+YDxvcHRpb24gdmFsdWU9IiR7eX0iPiR7eX08L29wdGlvbj5gKS5qb2luKCIiKTsgeWVhclNlbGVjdC52YWx1ZT1TdHJpbmcoc2VsZWN0ZWQpOwogICAgY29uc3Qgb2xkQ29tcGFyZT1jb21wYXJlU2VsZWN0LnZhbHVlfHwibm9uZSI7CiAgICBjb21wYXJlU2VsZWN0LmlubmVySFRNTD0nPG9wdGlvbiB2YWx1ZT0ibm9uZSI+S2VpbiBWZXJnbGVpY2g8L29wdGlvbj4nK3lzLmZpbHRlcih5PT55IT09c2VsZWN0ZWQpLm1hcCh5PT5gPG9wdGlvbiB2YWx1ZT0iJHt5fSI+JHt5fTwvb3B0aW9uPmApLmpvaW4oIiIpOwogICAgY29tcGFyZVNlbGVjdC52YWx1ZT15cy5pbmNsdWRlcyhOdW1iZXIob2xkQ29tcGFyZSkpJiZOdW1iZXIob2xkQ29tcGFyZSkhPT1zZWxlY3RlZD9vbGRDb21wYXJlOih5cy5pbmNsdWRlcyhzZWxlY3RlZC0xKT9TdHJpbmcoc2VsZWN0ZWQtMSk6Im5vbmUiKTsKICAgIGNvbnN0IHJvd3M9YW5hbHlzaXNZZWFyUm93cyhzZWxlY3RlZCksIHN1bXM9YW5udWFsU3Vtcyhyb3dzKTsgY29uc3QgY29tcFllYXI9Y29tcGFyZVNlbGVjdC52YWx1ZT09PSJub25lIj9udWxsOk51bWJlcihjb21wYXJlU2VsZWN0LnZhbHVlKTsgY29uc3QgY29tcFJvd3M9Y29tcFllYXI/YW5hbHlzaXNZZWFyUm93cyhjb21wWWVhcik6W107IGNvbnN0IGNvbXA9YW5udWFsU3Vtcyhjb21wUm93cyk7CiAgICBjb25zdCB0b3RhbERlbHRhPWNvbXAuY291bnQmJmNvbXAudG90YWw/KChzdW1zLnRvdGFsLWNvbXAudG90YWwpL2NvbXAudG90YWwqMTAwKTpudWxsOwogICAgY29uc3QgY29wUm93cz1yb3dzLm1hcChyZWNvcmRDb3ApLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpOyBjb25zdCBhbm51YWxDb3A9cm93cy5yZWR1Y2UoKGEscik9PnsgaWYoTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApJiZOdW1iZXIuaXNGaW5pdGUoci5oZWF0R2VuZXJhdGVkKSl7YS5lKz1yLmhlYXRQdW1wO2EuaCs9ci5oZWF0R2VuZXJhdGVkO30gcmV0dXJuIGE7fSx7ZTowLGg6MH0pOwogICAgY29uc3QgbWV0cmljcz1bCiAgICAgIFsiR2VzYW10IixgJHtudW0oc3Vtcy50b3RhbCwwKX0ga1doYCxOdW1iZXIuaXNGaW5pdGUodG90YWxEZWx0YSk/YCR7cGN0KHRvdGFsRGVsdGEpfSB6dSAke2NvbXBZZWFyfWA6YCR7c3Vtcy5jb3VudH0gTW9uYXRlYF0sCiAgICAgIFsiV8Okcm1lcHVtcGUiLGAke251bShzdW1zLmhlYXQsMCl9IGtXaGAsc3Vtcy50b3RhbD9gJHtudW0oc3Vtcy5oZWF0L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiQWx0ZW50ZWlsIixgJHtudW0oc3Vtcy5hbm5leCwwKX0ga1doYCxzdW1zLnRvdGFsP2Ake251bShzdW1zLmFubmV4L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiU2NobGVlL0tsdXMiLGAke251bShzdW1zLnJlc3QsMCl9IGtXaGAsc3Vtcy50b3RhbD9gJHtudW0oc3Vtcy5yZXN0L3N1bXMudG90YWwqMTAwLDEpfSAlYDoi4oCTIl0sCiAgICAgIFsiS29zdGVuIixldXJvKHN1bXMuY29zdCksYW5udWFsQ29wLmU+MD9gV1AtQXJiZWl0c3phaGwgJHtudW0oYW5udWFsQ29wLmgvYW5udWFsQ29wLmUsMil9YDoib2huZSB2b2xsc3TDpG5kaWdlIFdQLVfDpHJtZWRhdGVuIl0KICAgIF07CiAgICAkKCJhbmFseXNpc01ldHJpY3MiKS5pbm5lckhUTUw9bWV0cmljcy5tYXAoKFtsLHYsc10pPT5gPGFydGljbGU+PHNwYW4+JHtsfTwvc3Bhbj48c3Ryb25nPiR7dn08L3N0cm9uZz48c21hbGw+JHtzfTwvc21hbGw+PC9hcnRpY2xlPmApLmpvaW4oIiIpOwogICAgJCgiYW5hbHlzaXNUYWJsZSIpLmlubmVySFRNTD1yb3dzLmxlbmd0aD9yb3dzLm1hcChyPT5gPHRyPjx0ZD4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChyLm1vbnRoLGZhbHNlKSl9PC90ZD48dGQ+JHtudW0oci50b3RhbCwxKX08L3RkPjx0ZD4ke251bShyLmhlYXRQdW1wLDEpfTwvdGQ+PHRkPiR7bnVtKHIuYW5uZXgsMSl9PC90ZD48dGQ+JHtudW0oZGVyaXZlZChyKSwxKX08L3RkPjx0ZD4ke2V1cm8ocmVjb3JkQ29zdChyKSl9PC90ZD48L3RyPmApLmpvaW4oIiIpOic8dHI+PHRkIGNvbHNwYW49IjYiPktlaW5lIE1vbmF0c2RhdGVuIGbDvHIgZGllc2VzIEphaHIuPC90ZD48L3RyPic7CiAgICAkKCJjb3BQYW5lbCIpLmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIWNvcFJvd3MubGVuZ3RoKTsKICAgIGRyYXdBbGxvY2F0aW9uQ2hhcnQocm93cyk7IGRyYXdUb3RhbENoYXJ0KHJvd3MsY29tcFJvd3Msc2VsZWN0ZWQsY29tcFllYXIpOyBkcmF3Q29zdENoYXJ0KHJvd3MpOyBpZihjb3BSb3dzLmxlbmd0aClkcmF3Q29wQ2hhcnQocm93cyk7CiAgfQoKICBmdW5jdGlvbiBjYW52YXNTZXR1cChjYW52YXMpewogICAgaWYoIWNhbnZhcylyZXR1cm4gbnVsbDsKICAgIGNvbnN0IHJlY3Q9Y2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOyBjb25zdCBkcHI9TWF0aC5taW4od2luZG93LmRldmljZVBpeGVsUmF0aW98fDEsMik7IGNvbnN0IHdpZHRoPU1hdGgubWF4KDI4MCxNYXRoLnJvdW5kKHJlY3Qud2lkdGh8fDYwMCkpOyBjb25zdCBoZWlnaHQ9TWF0aC5tYXgoMTgwLE1hdGgucm91bmQocmVjdC5oZWlnaHR8fDI2MCkpOwogICAgY2FudmFzLndpZHRoPU1hdGgucm91bmQod2lkdGgqZHByKTsgY2FudmFzLmhlaWdodD1NYXRoLnJvdW5kKGhlaWdodCpkcHIpOyBjb25zdCBjdHg9Y2FudmFzLmdldENvbnRleHQoIjJkIik7IGN0eC5zZXRUcmFuc2Zvcm0oZHByLDAsMCxkcHIsMCwwKTsgY3R4LmNsZWFyUmVjdCgwLDAsd2lkdGgsaGVpZ2h0KTsgcmV0dXJuIHtjdHgsd2lkdGgsaGVpZ2h0fTsKICB9CiAgZnVuY3Rpb24gZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsdGV4dD0iS2VpbmUgRGF0ZW4iKXsKICAgIGN0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7IGN0eC5mb250PSIxM3B4IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LFNlZ29lIFVJLHNhbnMtc2VyaWYiOyBjdHgudGV4dEFsaWduPSJjZW50ZXIiOyBjdHguZmlsbFRleHQodGV4dCx3aWR0aC8yLGhlaWdodC8yKTsgY3R4LnRleHRBbGlnbj0ibGVmdCI7CiAgfQogIGZ1bmN0aW9uIGNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsbGFiZWxzLHtsZWZ0PTQ4LGJvdHRvbT0zNCx0b3A9MTUscmlnaHQ9MTJ9PXt9KXsKICAgIGNvbnN0IHBsb3RXPXdpZHRoLWxlZnQtcmlnaHQsIHBsb3RIPWhlaWdodC10b3AtYm90dG9tOwogICAgY3R4LnN0cm9rZVN0eWxlPUNPTE9SUy5ncmlkOyBjdHguZmlsbFN0eWxlPUNPTE9SUy50ZXh0OyBjdHguZm9udD0iMTBweCAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCxTZWdvZSBVSSxzYW5zLXNlcmlmIjsgY3R4LmxpbmVXaWR0aD0xOwogICAgZm9yKGxldCBpPTA7aTw9NDtpKyspeyBjb25zdCB5PXRvcCtwbG90SCppLzQ7IGN0eC5iZWdpblBhdGgoKTtjdHgubW92ZVRvKGxlZnQseSk7Y3R4LmxpbmVUbyh3aWR0aC1yaWdodCx5KTtjdHguc3Ryb2tlKCk7IGNvbnN0IHZhbD1tYXgqKDEtaS80KTtjdHguZmlsbFRleHQobnVtKHZhbCwwKSw0LHkrMyk7IH0KICAgIGlmKGxhYmVscz8ubGVuZ3RoKXsgbGFiZWxzLmZvckVhY2goKGxhYmVsLGkpPT57IGNvbnN0IHg9bGVmdCsobGFiZWxzLmxlbmd0aD09PTE/cGxvdFcvMjpwbG90VyppLyhsYWJlbHMubGVuZ3RoLTEpKTsgY3R4LmZpbGxUZXh0KGxhYmVsLHgtMTAsaGVpZ2h0LTEwKTsgfSk7IH0KICAgIHJldHVybiB7bGVmdCxyaWdodCx0b3AsYm90dG9tLHBsb3RXLHBsb3RIfTsKICB9CiAgZnVuY3Rpb24gZHJhd0Rhc2hib2FyZENvbnN1bXB0aW9uKCl7CiAgICBjb25zdCBjPWNhbnZhc1NldHVwKCQoImRhc2hib2FyZENvbnN1bXB0aW9uQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHJvd3M9c29ydGVkKCkuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkuc2xpY2UoLTEyKTsgaWYoIXJvd3MubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCk7cmV0dXJuO30KICAgIGNvbnN0IG1heD1NYXRoLm1heCguLi5yb3dzLm1hcChyPT5yLnRvdGFsKSkqMS4xMnx8MTsgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxyb3dzLm1hcChyPT5NT05USFNbTnVtYmVyKHIubW9udGguc2xpY2UoNSw3KSktMV0pLHt9KTsKICAgIGN0eC5zdHJva2VTdHlsZT1DT0xPUlMudG90YWw7Y3R4LmxpbmVXaWR0aD0yLjU7Y3R4LmJlZ2luUGF0aCgpO3Jvd3MuZm9yRWFjaCgocixpKT0+e2NvbnN0IHg9ZnJhbWUubGVmdCsocm93cy5sZW5ndGg9PT0xP2ZyYW1lLnBsb3RXLzI6ZnJhbWUucGxvdFcqaS8ocm93cy5sZW5ndGgtMSkpO2NvbnN0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLXIudG90YWwvbWF4KTtpP2N0eC5saW5lVG8oeCx5KTpjdHgubW92ZVRvKHgseSk7fSk7Y3R4LnN0cm9rZSgpOwogICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMudG90YWw7cm93cy5mb3JFYWNoKChyLGkpPT57Y29uc3QgeD1mcmFtZS5sZWZ0Kyhyb3dzLmxlbmd0aD09PTE/ZnJhbWUucGxvdFcvMjpmcmFtZS5wbG90VyppLyhyb3dzLmxlbmd0aC0xKSk7Y29uc3QgeT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtci50b3RhbC9tYXgpO2N0eC5iZWdpblBhdGgoKTtjdHguYXJjKHgseSwzLDAsTWF0aC5QSSoyKTtjdHguZmlsbCgpO30pOwogIH0KICBmdW5jdGlvbiBkcmF3QWxsb2NhdGlvbkNoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJhbGxvY2F0aW9uQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbGlkPXJvd3MuZmlsdGVyKHI9PltyLmhlYXRQdW1wLHIuYW5uZXgsci50b3RhbF0uc29tZShOdW1iZXIuaXNGaW5pdGUpKTsgaWYoIXZhbGlkLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQpO3JldHVybjt9CiAgICBjb25zdCBtYXg9TWF0aC5tYXgoLi4udmFsaWQubWFwKHI9Pk1hdGgubWF4KDAsTnVtYmVyKHIudG90YWwpfHwoKE51bWJlcihyLmhlYXRQdW1wKXx8MCkrKE51bWJlcihyLmFubmV4KXx8MCkrKE1hdGgubWF4KDAsZGVyaXZlZChyKSl8fDApKSkpKSoxLjF8fDE7IGNvbnN0IGxhYmVscz12YWxpZC5tYXAocj0+TU9OVEhTW051bWJlcihyLm1vbnRoLnNsaWNlKDUsNykpLTFdKTsgY29uc3QgZnJhbWU9Y2hhcnRGcmFtZShjdHgsd2lkdGgsaGVpZ2h0LG1heCxsYWJlbHMse30pOyBjb25zdCBzbG90PWZyYW1lLnBsb3RXL3ZhbGlkLmxlbmd0aCwgYmFyVz1NYXRoLm1pbigzOCxzbG90Ki42Mik7CiAgICB2YWxpZC5mb3JFYWNoKChyLGkpPT57IGNvbnN0IHg9ZnJhbWUubGVmdCtzbG90KmkrKHNsb3QtYmFyVykvMjsgbGV0IHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIOyBjb25zdCBwYXJ0cz1bW01hdGgubWF4KDAsTnVtYmVyKHIuaGVhdFB1bXApfHwwKSxDT0xPUlMuaGVhdF0sW01hdGgubWF4KDAsTnVtYmVyKHIuYW5uZXgpfHwwKSxDT0xPUlMuYW5uZXhdLFtNYXRoLm1heCgwLGRlcml2ZWQocil8fDApLENPTE9SUy5yZXN0XV07IGZvcihjb25zdCBbdixjb2xvcl0gb2YgcGFydHMpe2NvbnN0IGg9ZnJhbWUucGxvdEgqdi9tYXg7eS09aDtjdHguZmlsbFN0eWxlPWNvbG9yO2N0eC5maWxsUmVjdCh4LHksYmFyVyxoKTt9IH0pOwogIH0KICBmdW5jdGlvbiBkcmF3VG90YWxDaGFydChyb3dzLGNvbXBSb3dzLHllYXIsY29tcFllYXIpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJ0b3RhbENoYXJ0IikpOyBpZighYylyZXR1cm47IGNvbnN0IHtjdHgsd2lkdGgsaGVpZ2h0fT1jOyBjb25zdCB2YWxzPVsuLi5yb3dzLC4uLmNvbXBSb3dzXS5maWx0ZXIocj0+TnVtYmVyLmlzRmluaXRlKHIudG90YWwpKTsgaWYoIXZhbHMubGVuZ3RoKXtkcmF3RW1wdHkoY3R4LHdpZHRoLGhlaWdodCk7cmV0dXJuO30gY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMubWFwKHI9PnIudG90YWwpKSoxLjEyfHwxOyBjb25zdCBsYWJlbHM9TU9OVEhTOyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LGxhYmVscyx7fSk7CiAgICBjb25zdCBkcmF3TGluZT0oZGF0YSxjb2xvcixkYXNoZWQ9ZmFsc2UpPT57IGNvbnN0IG1hcD1uZXcgTWFwKGRhdGEuZmlsdGVyKHI9Pk51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSkubWFwKHI9PltOdW1iZXIoci5tb250aC5zbGljZSg1LDcpKS0xLHIudG90YWxdKSk7IGN0eC5zdHJva2VTdHlsZT1jb2xvcjtjdHgubGluZVdpZHRoPTIuNDtjdHguc2V0TGluZURhc2goZGFzaGVkP1s2LDVdOltdKTtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7Zm9yKGxldCBtPTA7bTwxMjttKyspe2lmKCFtYXAuaGFzKG0pKWNvbnRpbnVlO2NvbnN0IHg9ZnJhbWUubGVmdCtmcmFtZS5wbG90VyptLzExLHk9ZnJhbWUudG9wK2ZyYW1lLnBsb3RIKigxLW1hcC5nZXQobSkvbWF4KTtpZighc3RhcnRlZCl7Y3R4Lm1vdmVUbyh4LHkpO3N0YXJ0ZWQ9dHJ1ZTt9ZWxzZSBjdHgubGluZVRvKHgseSk7fWN0eC5zdHJva2UoKTtjdHguc2V0TGluZURhc2goW10pO307CiAgICBkcmF3TGluZShyb3dzLENPTE9SUy50b3RhbCxmYWxzZSk7IGlmKGNvbXBZZWFyKWRyYXdMaW5lKGNvbXBSb3dzLENPTE9SUy5jb21wYXJlLHRydWUpOwogICAgY3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZm9udD0iMTFweCBzYW5zLXNlcmlmIjtjdHguZmlsbFRleHQoU3RyaW5nKHllYXIpLGZyYW1lLmxlZnQrNSxmcmFtZS50b3ArMTIpO2lmKGNvbXBZZWFyKXtjdHguZmlsbFN0eWxlPUNPTE9SUy5jb21wYXJlO2N0eC5maWxsVGV4dChg4oadICR7Y29tcFllYXJ9YCxmcmFtZS5sZWZ0KzU1LGZyYW1lLnRvcCsxMik7fQogIH0KICBmdW5jdGlvbiBkcmF3Q29zdENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3N0Q2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGNvbnN0IHZhbHM9cm93cy5tYXAocj0+cmVjb3JkQ29zdChyKSk7IGlmKCF2YWxzLnNvbWUoTnVtYmVyLmlzRmluaXRlKSl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsIktlaW5lIEtvc3RlbmRhdGVuIik7cmV0dXJuO30gY29uc3QgbWF4PU1hdGgubWF4KC4uLnZhbHMuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSkpKjEuMTJ8fDE7IGNvbnN0IGZyYW1lPWNoYXJ0RnJhbWUoY3R4LHdpZHRoLGhlaWdodCxtYXgsTU9OVEhTLHt9KTsgY29uc3Qgc2xvdD1mcmFtZS5wbG90Vy8xMixiYXJXPU1hdGgubWluKDM4LHNsb3QqLjYyKTsgdmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgaD1mcmFtZS5wbG90SCp2L21heCx4PWZyYW1lLmxlZnQrc2xvdCppKyhzbG90LWJhclcpLzIseT1mcmFtZS50b3ArZnJhbWUucGxvdEgtaDtjdHguZmlsbFN0eWxlPUNPTE9SUy5jb3N0O2N0eC5maWxsUmVjdCh4LHksYmFyVyxoKTt9KTsKICB9CiAgZnVuY3Rpb24gZHJhd0NvcENoYXJ0KHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJjb3BDaGFydCIpKTsgaWYoIWMpcmV0dXJuOyBjb25zdCB7Y3R4LHdpZHRoLGhlaWdodH09YzsgY29uc3QgdmFscz1yb3dzLm1hcChyZWNvcmRDb3ApOyBpZighdmFscy5zb21lKE51bWJlci5pc0Zpbml0ZSkpe2RyYXdFbXB0eShjdHgsd2lkdGgsaGVpZ2h0KTtyZXR1cm47fSBjb25zdCBtYXg9TWF0aC5tYXgoNSwuLi52YWxzLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpKSoxLjA1OyBjb25zdCBmcmFtZT1jaGFydEZyYW1lKGN0eCx3aWR0aCxoZWlnaHQsbWF4LE1PTlRIUyx7fSk7IGN0eC5zdHJva2VTdHlsZT1DT0xPUlMuaGVhdDtjdHgubGluZVdpZHRoPTIuNDtjdHguYmVnaW5QYXRoKCk7bGV0IHN0YXJ0ZWQ9ZmFsc2U7dmFscy5mb3JFYWNoKCh2LGkpPT57aWYoIU51bWJlci5pc0Zpbml0ZSh2KSlyZXR1cm47Y29uc3QgeD1mcmFtZS5sZWZ0K2ZyYW1lLnBsb3RXKmkvMTEseT1mcmFtZS50b3ArZnJhbWUucGxvdEgqKDEtdi9tYXgpO2lmKCFzdGFydGVkKXtjdHgubW92ZVRvKHgseSk7c3RhcnRlZD10cnVlO31lbHNlIGN0eC5saW5lVG8oeCx5KTt9KTtjdHguc3Ryb2tlKCk7CiAgfQoKICBmdW5jdGlvbiByZW5kZXJNZXRlclBhbmVsKCl7CiAgICBjb25zdCBsYXRlc3Q9bGF0ZXN0TWV0ZXJSZWFkaW5nKCk7CiAgICBpZighbGF0ZXN0KXJldHVybjsKICAgICQoIm1ldGVyTGF0ZXN0IikuaW5uZXJIVE1MPWA8YXJ0aWNsZT48c3Bhbj5TdGFuZCB2b208L3NwYW4+PHN0cm9uZz4ke2RhdGVMYWJlbChsYXRlc3QuZGF0ZSl9PC9zdHJvbmc+PHNtYWxsPmxldHp0ZSBBYmxlc3VuZzwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkdlc2FtdDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC50b3RhbCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPjxhcnRpY2xlPjxzcGFuPkFsdGVudGVpbDwvc3Bhbj48c3Ryb25nPiR7bnVtKGxhdGVzdC5hbm5leCwwKX0ga1doPC9zdHJvbmc+PHNtYWxsPlrDpGhsZXJzdGFuZDwvc21hbGw+PC9hcnRpY2xlPmA7CiAgICAkKCJtZXRlckhpc3RvcnkiKS5pbm5lckhUTUw9bWV0ZXJSZWFkaW5ncy5zbGljZSgpLnJldmVyc2UoKS5zbGljZSgwLDgpLm1hcCgocixpKT0+YDxkaXYgY2xhc3M9Im1ldGVyLWhpc3Rvcnktcm93Ij48c3Bhbj4ke2RhdGVMYWJlbChyLmRhdGUpfTwvc3Bhbj48c3Ryb25nPkdlc2FtdCAke251bShyLnRvdGFsLDApfTwvc3Ryb25nPjxzdHJvbmc+QWx0ZW50ZWlsICR7bnVtKHIuYW5uZXgsMCl9PC9zdHJvbmc+JHtpPT09bWV0ZXJSZWFkaW5ncy5sZW5ndGgtMT8nPHNtYWxsPlN0YXJ0d2VydDwvc21hbGw+JzonJ308L2Rpdj5gKS5qb2luKCIiKTsKICAgICQoInVuZG9MYXRlc3RNZXRlckJ0biIpLmRpc2FibGVkPW1ldGVyUmVhZGluZ3MubGVuZ3RoPD0xOwogIH0KICBmdW5jdGlvbiByZW5kZXJEYXRhKCl7CiAgICBjb25zdCBpc3N1ZXM9W107IGxldCBjb21wbGV0ZUNvdW50PTA7CiAgICBmb3IoY29uc3QgciBvZiByZWNvcmRzKXsKICAgICAgY29uc3QgbWlzc2luZz1bXTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLnRvdGFsKSltaXNzaW5nLnB1c2goIkdlc2FtdCIpOyBpZighTnVtYmVyLmlzRmluaXRlKHIuaGVhdFB1bXApKW1pc3NpbmcucHVzaCgiV8Okcm1lcHVtcGUiKTsgaWYoIU51bWJlci5pc0Zpbml0ZShyLmFubmV4KSltaXNzaW5nLnB1c2goIkFsdGVudGVpbCIpOyBjb25zdCByZXN0PWRlcml2ZWQocik7CiAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShyZXN0KSYmcmVzdDwwKWlzc3Vlcy5wdXNoKHtsZXZlbDoiZXJyb3IiLG1vbnRoOnIubW9udGgsdGl0bGU6IkF1ZnRlaWx1bmcgdW5wbGF1c2liZWwiLGRldGFpbDpgU2NobGVlL0tsdXMgZXJnaWJ0ICR7bnVtKHJlc3QsMSl9IGtXaC5gfSk7CiAgICAgIGVsc2UgaWYobWlzc2luZy5sZW5ndGgpaXNzdWVzLnB1c2goe2xldmVsOiJ3YXJuaW5nIixtb250aDpyLm1vbnRoLHRpdGxlOiJNb25hdCB1bnZvbGxzdMOkbmRpZyIsZGV0YWlsOmBGZWhsdDogJHttaXNzaW5nLmpvaW4oIiwgIil9YH0pOwogICAgICBlbHNlIGNvbXBsZXRlQ291bnQrKzsKICAgIH0KICAgIGNvbnN0IGxhdGVzdD1sYXRlc3RSZWNvcmQoKTsKICAgIGNvbnN0IHE9WwogICAgICBbIk1vbmF0ZSIsU3RyaW5nKHJlY29yZHMubGVuZ3RoKSwiZ2VzcGVpY2hlcnQiXSwKICAgICAgWyJWb2xsc3TDpG5kaWciLFN0cmluZyhjb21wbGV0ZUNvdW50KSxyZWNvcmRzLmxlbmd0aD9gJHtudW0oY29tcGxldGVDb3VudC9yZWNvcmRzLmxlbmd0aCoxMDAsMCl9ICVgOiLigJMiXSwKICAgICAgWyJIaW53ZWlzZSIsU3RyaW5nKGlzc3Vlcy5sZW5ndGgpLGlzc3Vlcy5zb21lKGk9PmkubGV2ZWw9PT0iZXJyb3IiKT8ibWluZC4gMSBGZWhsZXIiOiJwcsO8ZmVuIl0sCiAgICAgIFsiTGV0enRlciBNb25hdCIsbGF0ZXN0P21vbnRoTGFiZWwobGF0ZXN0Lm1vbnRoLGZhbHNlKToi4oCTIiwiYXV0b21hdGlzY2ggYmVyZWNobmV0Il0KICAgIF07CiAgICAkKCJxdWFsaXR5TWV0cmljcyIpLmlubmVySFRNTD1xLm1hcCgoW2wsdixzXSk9PmA8YXJ0aWNsZT48c3Bhbj4ke2x9PC9zcGFuPjxzdHJvbmc+JHt2fTwvc3Ryb25nPjxzbWFsbD4ke3N9PC9zbWFsbD48L2FydGljbGU+YCkuam9pbigiIik7CiAgICAkKCJxdWFsaXR5SXNzdWVzIikuaW5uZXJIVE1MPWlzc3Vlcy5sZW5ndGg/aXNzdWVzLnNsaWNlKCkucmV2ZXJzZSgpLnNsaWNlKDAsMTYpLm1hcChpPT5gPGFydGljbGUgY2xhc3M9Imlzc3VlICR7aS5sZXZlbH0iPjxkaXY+PHN0cm9uZz4ke2VzY2FwZUh0bWwobW9udGhMYWJlbChpLm1vbnRoKSl9OiAke2VzY2FwZUh0bWwoaS50aXRsZSl9PC9zdHJvbmc+PHNtYWxsPiR7ZXNjYXBlSHRtbChpLmRldGFpbCl9PC9zbWFsbD48L2Rpdj48L2FydGljbGU+YCkuam9pbigiIik6JzxhcnRpY2xlIGNsYXNzPSJpc3N1ZSI+PGRpdj48c3Ryb25nPktlaW5lIEF1ZmbDpGxsaWdrZWl0ZW48L3N0cm9uZz48c21hbGw+QWxsZSBnZXNwZWljaGVydGVuIE1vbmF0ZSBzaW5kIHBsYXVzaWJlbCB1bmQgdm9sbHN0w6RuZGlnLjwvc21hbGw+PC9kaXY+PC9hcnRpY2xlPic7CiAgICByZW5kZXJNZXRlclBhbmVsKCk7CiAgICAkKCJvc3Ryb21BcHBLZXlJbnB1dCIpLnZhbHVlPXNldHRpbmdzLm9zdHJvbUFwcEtleXx8IiI7CiAgICAkKCJvc3Ryb21BdXRvUmVmcmVzaElucHV0IikuY2hlY2tlZD1zZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaCE9PWZhbHNlOwogICAgJCgicHJlZmVycmVkV2luZG93SG91cnNJbnB1dCIpLnZhbHVlPVN0cmluZyhzZXR0aW5ncy5wcmVmZXJyZWRXaW5kb3dIb3Vyc3x8Myk7CiAgICAkKCJmYWxsYmFja1ByaWNlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZmFsbGJhY2tQcmljZXx8MC4zMikudG9GaXhlZCgzKTsKICAgICQoImRlZmF1bHRCYXNlRmVlSW5wdXQiKS52YWx1ZT1OdW1iZXIoc2V0dGluZ3MuZGVmYXVsdEJhc2VGZWV8fDApLnRvRml4ZWQoMik7CiAgICBjb25zdCBsYXN0QmFja3VwPWxvY2FsU3RvcmFnZS5nZXRJdGVtKExBU1RfQkFDS1VQX0tFWSk7ICQoImJhY2t1cFN0YXR1cyIpLnRleHRDb250ZW50PWxhc3RCYWNrdXA/YExldHp0ZXMgQmFja3VwOiAke25ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2RhdGVTdHlsZToibWVkaXVtIix0aW1lU3R5bGU6InNob3J0In0pLmZvcm1hdChuZXcgRGF0ZShsYXN0QmFja3VwKSl9YDoiTm9jaCBrZWluIEJhY2t1cCBtaXQgRWxkZWhvZiA2LjEgZXJzdGVsbHQuIjsKICB9CgogIGZ1bmN0aW9uIGRvd25sb2FkQmxvYihjb250ZW50LGZpbGVuYW1lLHR5cGUpeyBjb25zdCBibG9iPW5ldyBCbG9iKFtjb250ZW50XSx7dHlwZX0pOyBjb25zdCB1cmw9VVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsgY29uc3QgYT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJhIik7IGEuaHJlZj11cmw7YS5kb3dubG9hZD1maWxlbmFtZTtkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGEpO2EuY2xpY2soKTthLnJlbW92ZSgpO3NldFRpbWVvdXQoKCk9PlVSTC5yZXZva2VPYmplY3RVUkwodXJsKSwxMDAwKTsgfQogIGZ1bmN0aW9uIGV4cG9ydEJhY2t1cCgpewogICAgY29uc3Qgbm93PW5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIGNvbnN0IHJlbGV2YW50U2V0dGluZ3M9e2ZhbGxiYWNrUHJpY2U6c2V0dGluZ3MuZmFsbGJhY2tQcmljZSxkZWZhdWx0QmFzZUZlZTpzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZSxvc3Ryb21BcHBLZXk6c2V0dGluZ3Mub3N0cm9tQXBwS2V5LG9zdHJvbUF1dG9SZWZyZXNoOnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoLHByZWZlcnJlZFdpbmRvd0hvdXJzOnNldHRpbmdzLnByZWZlcnJlZFdpbmRvd0hvdXJzfTsKICAgIGNvbnN0IHBheWxvYWQ9e3ZlcnNpb246IjYuMS4wIixhcHA6IkVsZGVob2YiLHB1cnBvc2U6IlByaXZhdGVzIGxva2FsZXMgQmFja3VwIOKAkyBuaWNodCDDtmZmZW50bGljaCBob2NobGFkZW4iLGV4cG9ydGVkQXQ6bm93LHNldHRpbmdzOnJlbGV2YW50U2V0dGluZ3MscmVjb3Jkcyx2YWlsbGFudE1vbnRocyxtZXRlclJlYWRpbmdzfTsKICAgIGRvd25sb2FkQmxvYihKU09OLnN0cmluZ2lmeShwYXlsb2FkLG51bGwsMiksYEVsZGVob2ZfUFJJVkFURV9CYWNrdXBfJHtkYXRlU3RhbXAoKX0uanNvbmAsImFwcGxpY2F0aW9uL2pzb24iKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTEFTVF9CQUNLVVBfS0VZLG5vdyk7IHJlbmRlckRhdGEoKTsgdG9hc3QoIlByaXZhdGVzIEJhY2t1cCBlcnN0ZWxsdCIpOwogIH0KICBmdW5jdGlvbiBleHBvcnRDc3YoKXsKICAgIGNvbnN0IHJvd3M9W1siTW9uYXQiLCJXw6RybWVwdW1wZSBrV2giLCJFcnpldWd0ZSBXw6RybWUga1doIiwiQXJiZWl0c3phaGwiLCJBbHRlbnRlaWwga1doIiwiU2NobGVlL0tsdXMga1doIiwiR2VzYW10IGtXaCIsIkdlc2FtdC1aw6RobGVyc3RhbmQga1doIiwiQWx0ZW50ZWlsLVrDpGhsZXJzdGFuZCBrV2giLCJBYmxlc2VkYXR1bSIsIlByZWlzIGN0L2tXaCIsIkZpeGtvc3RlbiBFVVIiLCJLb3N0ZW4gRVVSIiwiTm90aXoiXV07CiAgICBmb3IoY29uc3QgciBvZiBzb3J0ZWQoKSlyb3dzLnB1c2goW3IubW9udGgsci5oZWF0UHVtcD8/IiIsci5oZWF0R2VuZXJhdGVkPz8iIixyZWNvcmRDb3Aocik/PyIiLHIuYW5uZXg/PyIiLGRlcml2ZWQocik/PyIiLHIudG90YWw/PyIiLHIudG90YWxNZXRlclJlYWRpbmc/PyIiLHIuYW5uZXhNZXRlclJlYWRpbmc/PyIiLHIubWV0ZXJSZWFkaW5nRGF0ZT8/IiIsci5wcmljZUN0Pz8iIixyLmJhc2VGZWU/PyIiLHJlY29yZENvc3Qocik/PyIiLHIubm90ZXx8IiJdKTsKICAgIGRvd25sb2FkQmxvYigiXHVGRUZGIityb3dzLm1hcChyb3c9PnJvdy5tYXAoY3N2Q2VsbCkuam9pbigiOyIpKS5qb2luKCJcbiIpLGBFbGRlaG9mX1ZlcmJyYXVjaF8ke2RhdGVTdGFtcCgpfS5jc3ZgLCJ0ZXh0L2NzdjtjaGFyc2V0PXV0Zi04Iik7IHRvYXN0KCJDU1YgZXJzdGVsbHQiKTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gaW1wb3J0QmFja3VwKGZpbGUpewogICAgdHJ5ewogICAgICBjb25zdCBwYXlsb2FkPUpTT04ucGFyc2UoYXdhaXQgZmlsZS50ZXh0KCkpOyBjb25zdCBpbmNvbWluZz1BcnJheS5pc0FycmF5KHBheWxvYWQpP3BheWxvYWQ6KEFycmF5LmlzQXJyYXkocGF5bG9hZC5yZWNvcmRzKT9wYXlsb2FkLnJlY29yZHM6cGF5bG9hZC5kYXRhKTsgaWYoIUFycmF5LmlzQXJyYXkoaW5jb21pbmcpKXRocm93IG5ldyBFcnJvcigiS2VpbmUgTW9uYXRzZGF0ZW4gZ2VmdW5kZW4uIik7CiAgICAgIGNvbnN0IGNsZWFuZWQ9c2FuaXRpemVSZWNvcmRzKGluY29taW5nKTsgaWYoIWNsZWFuZWQubGVuZ3RoJiYhY29uZmlybSgiRGFzIEJhY2t1cCBlbnRow6RsdCBrZWluZSBNb25hdHN3ZXJ0ZS4gTGVlcmVuIEJlc3RhbmQgd2lya2xpY2ggaW1wb3J0aWVyZW4/IikpcmV0dXJuOwogICAgICBpZighY29uZmlybShgJHtjbGVhbmVkLmxlbmd0aH0gTW9uYXRzd2VydGUgYXVzIGRlbSBCYWNrdXAgw7xiZXJuZWhtZW4/IERlciBha3R1ZWxsZSBTdGFuZCB3aXJkIHZvcmhlciBsb2thbCBnZXNpY2hlcnQuYCkpcmV0dXJuOwogICAgICBzYXZlUmVjb3JkcyhjbGVhbmVkLHtyZWFzb246IkJhY2t1cCBpbXBvcnRpZXJ0IixhbGxvd0VtcHR5OnRydWV9KTsKICAgICAgaWYocGF5bG9hZC5zZXR0aW5ncyYmdHlwZW9mIHBheWxvYWQuc2V0dGluZ3M9PT0ib2JqZWN0Iil7CiAgICAgICAgc2V0dGluZ3M9ey4uLnNldHRpbmdzLC4uLnBheWxvYWQuc2V0dGluZ3N9OwogICAgICAgIGlmKE51bWJlci5pc0Zpbml0ZShOdW1iZXIocGF5bG9hZC5zZXR0aW5ncy5wcmljZSkpJiYhTnVtYmVyLmlzRmluaXRlKE51bWJlcihwYXlsb2FkLnNldHRpbmdzLmZhbGxiYWNrUHJpY2UpKSlzZXR0aW5ncy5mYWxsYmFja1ByaWNlPU51bWJlcihwYXlsb2FkLnNldHRpbmdzLnByaWNlKTsKICAgICAgICBzYXZlU2V0dGluZ3MoKTsKICAgICAgfQogICAgICBpZihBcnJheS5pc0FycmF5KHBheWxvYWQudmFpbGxhbnRNb250aHMpKXsgdmFpbGxhbnRNb250aHM9cGF5bG9hZC52YWlsbGFudE1vbnRoczsgc2F2ZVZhaWxsYW50TW9udGhzKCk7IH0KICAgICAgaWYoQXJyYXkuaXNBcnJheShwYXlsb2FkLm1ldGVyUmVhZGluZ3MpKXtzYXZlTWV0ZXJSZWFkaW5ncyhwYXlsb2FkLm1ldGVyUmVhZGluZ3MpO31lbHNle21ldGVyUmVhZGluZ3M9bG9hZE1ldGVyUmVhZGluZ3MoKTtlbnN1cmVNZXRlckJhc2VsaW5lKCk7fQogICAgICByZW5kZXJBbGwoKTsgdG9hc3QoIkJhY2t1cCBpbXBvcnRpZXJ0Iik7CiAgICB9Y2F0Y2goZXJyb3IpeyBhbGVydChgQmFja3VwIGtvbm50ZSBuaWNodCBpbXBvcnRpZXJ0IHdlcmRlbjogJHtlcnJvci5tZXNzYWdlfWApOyB9CiAgICBmaW5hbGx5eyAkKCJpbXBvcnRCYWNrdXBJbnB1dCIpLnZhbHVlPSIiOyB9CiAgfQoKCiAgLyogRWxkZWhvZiA2LjAuMSDigJMgc2NobGFua2VyIGxva2FsZXIgbXlWQUlMTEFOVC1DU1YtSW1wb3J0ICovCiAgZnVuY3Rpb24gdmFpbGxhbnRDc3ZOdW1iZXIodmFsdWUpewogICAgY29uc3QgdGV4dD1TdHJpbmcodmFsdWU/PyIiKS50cmltKCk7CiAgICBpZighdGV4dClyZXR1cm4gbnVsbDsKICAgIGNvbnN0IG5vcm1hbGl6ZWQ9dGV4dC5pbmNsdWRlcygiLCIpJiZ0ZXh0LmluY2x1ZGVzKCIuIikKICAgICAgP3RleHQubGFzdEluZGV4T2YoIiwiKT50ZXh0Lmxhc3RJbmRleE9mKCIuIikKICAgICAgICA/dGV4dC5yZXBsYWNlKC9cLi9nLCIiKS5yZXBsYWNlKCIsIiwiLiIpCiAgICAgICAgOnRleHQucmVwbGFjZSgvLC9nLCIiKQogICAgICA6dGV4dC5yZXBsYWNlKCIsIiwiLiIpOwogICAgY29uc3QgbnVtYmVyPU51bWJlcihub3JtYWxpemVkKTsKICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobnVtYmVyKT9udW1iZXI6bnVsbDsKICB9CiAgZnVuY3Rpb24gdmFpbGxhbnRDc3ZEYXRlUGFydHModmFsdWUpewogICAgY29uc3QgbWF0Y2g9L14oXGR7NH0pLShcZHsyfSktKFxkezJ9KSg/OlsgVF0oXGR7Mn0pOihcZHsyfSk6KFxkezJ9KSk/JC8uZXhlYyhTdHJpbmcodmFsdWV8fCIiKS50cmltKCkpOwogICAgaWYoIW1hdGNoKXJldHVybiBudWxsOwogICAgY29uc3QgeWVhcj1OdW1iZXIobWF0Y2hbMV0pLG1vbnRoPU51bWJlcihtYXRjaFsyXSksZGF5PU51bWJlcihtYXRjaFszXSk7CiAgICBjb25zdCBkYXRlPW5ldyBEYXRlKERhdGUuVVRDKHllYXIsbW9udGgtMSxkYXkpKTsKICAgIGlmKGRhdGUuZ2V0VVRDRnVsbFllYXIoKSE9PXllYXJ8fGRhdGUuZ2V0VVRDTW9udGgoKSE9PW1vbnRoLTF8fGRhdGUuZ2V0VVRDRGF0ZSgpIT09ZGF5KXJldHVybiBudWxsOwogICAgcmV0dXJuIHt5ZWFyLG1vbnRoLGRheSxkYXRlS2V5OmAke21hdGNoWzFdfS0ke21hdGNoWzJdfS0ke21hdGNoWzNdfWAsbW9udGhLZXk6YCR7bWF0Y2hbMV19LSR7bWF0Y2hbMl19YCxkYXRlVGltZTpTdHJpbmcodmFsdWV8fCIiKS50cmltKCl9OwogIH0KICBmdW5jdGlvbiBkZXRlY3RWYWlsbGFudENzdlR5cGUoaGVhZGVycyl7CiAgICBjb25zdCBmaWVsZHM9bmV3IFNldChoZWFkZXJzKSxoYXM9bmFtZT0+ZmllbGRzLmhhcyhuYW1lKTsKICAgIGlmKGhhcygiRGF0ZVRpbWUiKSYmaGFzKCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6SGVhdGluZyIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikmJmhhcygiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikmJmhhcygiSGVhdEdlbmVyYXRlZDpEb21lc3RpY0hvdFdhdGVyIikpcmV0dXJuICJhcm90aGVybS1lbmVyZ3kiOwogICAgaWYoaGFzKCJEYXRlVGltZSIpJiZoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikmJmhhcygiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikmJiFoYXMoIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpEb21lc3RpY0hvdFdhdGVyIikpcmV0dXJuICJ1bml0b3dlci1lbmVyZ3kiOwogICAgcmV0dXJuICJ1bmtub3duIjsKICB9CiAgZnVuY3Rpb24gcGFyc2VWYWlsbGFudENzdlRleHQodGV4dCxpbmRleD0wKXsKICAgIGNvbnN0IG5vcm1hbGl6ZWQ9U3RyaW5nKHRleHR8fCIiKS5yZXBsYWNlKC9eXHVGRUZGLywiIikucmVwbGFjZSgvXHJcbj8vZywiXG4iKTsKICAgIGNvbnN0IGRhdGFMaW5lcz1ub3JtYWxpemVkLnNwbGl0KCJcbiIpLmZpbHRlcihsaW5lPT57Y29uc3QgdD1saW5lLnRyaW0oKTtyZXR1cm4gdCYmIXQuc3RhcnRzV2l0aCgiIyIpO30pOwogICAgaWYoIWRhdGFMaW5lcy5sZW5ndGgpcmV0dXJuIHtpbmRleCx0eXBlOiJ1bmtub3duIixyb3dzOltdLGludmFsaWRSb3dzOjB9OwogICAgY29uc3QgZGVsaW1pdGVyPWRhdGFMaW5lc1swXS5pbmNsdWRlcygiOyIpPyI7IjoiLCI7CiAgICBjb25zdCBoZWFkZXJzPWRhdGFMaW5lc1swXS5zcGxpdChkZWxpbWl0ZXIpLm1hcCh2PT52LnRyaW0oKSk7CiAgICBjb25zdCB0eXBlPWRldGVjdFZhaWxsYW50Q3N2VHlwZShoZWFkZXJzKSxyb3dzPVtdO2xldCBpbnZhbGlkUm93cz0wOwogICAgZm9yKGNvbnN0IGxpbmUgb2YgZGF0YUxpbmVzLnNsaWNlKDEpKXsKICAgICAgaWYoIWxpbmUudHJpbSgpKWNvbnRpbnVlOwogICAgICBjb25zdCB2YWx1ZXM9bGluZS5zcGxpdChkZWxpbWl0ZXIpOwogICAgICBjb25zdCByYXc9T2JqZWN0LmZyb21FbnRyaWVzKGhlYWRlcnMubWFwKChoZWFkZXIsY29sdW1uKT0+W2hlYWRlcix2YWx1ZXNbY29sdW1uXT8/IiJdKSk7CiAgICAgIGNvbnN0IGRhdGU9dmFpbGxhbnRDc3ZEYXRlUGFydHMocmF3LkRhdGVUaW1lKTtpZighZGF0ZSl7aW52YWxpZFJvd3MrKztjb250aW51ZTt9CiAgICAgIGNvbnN0IHBhcnNlZD17Li4uZGF0ZSx2YWx1ZXM6e319OwogICAgICBmb3IoY29uc3QgaGVhZGVyIG9mIGhlYWRlcnMpe2lmKGhlYWRlciE9PSJEYXRlVGltZSIpcGFyc2VkLnZhbHVlc1toZWFkZXJdPXZhaWxsYW50Q3N2TnVtYmVyKHJhd1toZWFkZXJdKTt9CiAgICAgIHJvd3MucHVzaChwYXJzZWQpOwogICAgfQogICAgcmV0dXJuIHtpbmRleCx0eXBlLGhlYWRlcnMscm93cyxpbnZhbGlkUm93c307CiAgfQogIGZ1bmN0aW9uIHNhbWVWYWlsbGFudFZhbHVlKGEsYix0b2xlcmFuY2U9LjA1KXsKICAgIGlmKGE9PW51bGx8fGI9PW51bGwpcmV0dXJuIGE9PW51bGwmJmI9PW51bGw7CiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKE51bWJlcihhKSkmJk51bWJlci5pc0Zpbml0ZShOdW1iZXIoYikpP01hdGguYWJzKE51bWJlcihhKS1OdW1iZXIoYikpPD10b2xlcmFuY2U6U3RyaW5nKGEpPT09U3RyaW5nKGIpOwogIH0KICBmdW5jdGlvbiBidWlsZFZhaWxsYW50SW1wb3J0UHJldmlldyhwYXJzZWRGaWxlcyl7CiAgICBjb25zdCBlbmVyZ3lUeXBlcz1bImFyb3RoZXJtLWVuZXJneSIsInVuaXRvd2VyLWVuZXJneSJdOwogICAgY29uc3QgZGFpbHk9eyJhcm90aGVybS1lbmVyZ3kiOm5ldyBNYXAoKSwidW5pdG93ZXItZW5lcmd5IjpuZXcgTWFwKCl9OwogICAgY29uc3QgY29uZmxpY3RNb250aHM9bmV3IFNldCgpO2xldCBkdXBsaWNhdGVSb3dzPTA7CiAgICBmb3IoY29uc3QgZmlsZSBvZiBwYXJzZWRGaWxlcy5maWx0ZXIoZj0+ZW5lcmd5VHlwZXMuaW5jbHVkZXMoZi50eXBlKSkpewogICAgICBjb25zdCB0YXJnZXQ9ZGFpbHlbZmlsZS50eXBlXTsKICAgICAgZm9yKGNvbnN0IHJvdyBvZiBmaWxlLnJvd3MpewogICAgICAgIGNvbnN0IGV4aXN0aW5nPXRhcmdldC5nZXQocm93LmRhdGVLZXkpOwogICAgICAgIGlmKCFleGlzdGluZyl7dGFyZ2V0LnNldChyb3cuZGF0ZUtleSxyb3cpO2NvbnRpbnVlO30KICAgICAgICBjb25zdCBtZXRyaWNzPW5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKGV4aXN0aW5nLnZhbHVlc3x8e30pLC4uLk9iamVjdC5rZXlzKHJvdy52YWx1ZXN8fHt9KV0pOwogICAgICAgIGNvbnN0IGRpZmZlcnM9Wy4uLm1ldHJpY3NdLnNvbWUobWV0cmljPT4hc2FtZVZhaWxsYW50VmFsdWUoZXhpc3RpbmcudmFsdWVzPy5bbWV0cmljXSxyb3cudmFsdWVzPy5bbWV0cmljXSkpOwogICAgICAgIGlmKGRpZmZlcnMpY29uZmxpY3RNb250aHMuYWRkKHJvdy5tb250aEtleSk7ZWxzZSBkdXBsaWNhdGVSb3dzKys7CiAgICAgIH0KICAgIH0KICAgIGNvbnN0IGFsbERhdGVzPVsuLi5uZXcgU2V0KFsuLi5kYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0ua2V5cygpLC4uLmRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXS5rZXlzKCldKV07CiAgICBjb25zdCBtb250aEtleXM9Wy4uLm5ldyBTZXQoYWxsRGF0ZXMubWFwKGQ9PmQuc2xpY2UoMCw3KSkpXS5zb3J0KCk7CiAgICBjb25zdCBzdW09KG1hcCxkYXRlcyxtZXRyaWMpPT5kYXRlcy5yZWR1Y2UoKHMsa2V5KT0+e2NvbnN0IHY9bWFwLmdldChrZXkpPy52YWx1ZXM/LlttZXRyaWNdO3JldHVybiBzKyhOdW1iZXIuaXNGaW5pdGUodik/djowKTt9LDApOwogICAgY29uc3QgZnVsbD0oZGF0ZXMseSxtKT0+e2NvbnN0IGV4cGVjdGVkPW5ldyBEYXRlKHksbSwwKS5nZXREYXRlKCksdT1bLi4ubmV3IFNldChkYXRlcyldLnNvcnQoKTtyZXR1cm4gdS5sZW5ndGg9PT1leHBlY3RlZCYmdVswXT09PWAke3l9LSR7U3RyaW5nKG0pLnBhZFN0YXJ0KDIsIjAiKX0tMDFgJiZ1LmF0KC0xKT09PWAke3l9LSR7U3RyaW5nKG0pLnBhZFN0YXJ0KDIsIjAiKX0tJHtTdHJpbmcoZXhwZWN0ZWQpLnBhZFN0YXJ0KDIsIjAiKX1gO307CiAgICBjb25zdCBjdXJyZW50PWN1cnJlbnRNb250aEtleSgpOwogICAgY29uc3QgbW9udGhzPW1vbnRoS2V5cy5tYXAobW9udGg9PnsKICAgICAgY29uc3QgeT1OdW1iZXIobW9udGguc2xpY2UoMCw0KSksbT1OdW1iZXIobW9udGguc2xpY2UoNSw3KSk7CiAgICAgIGNvbnN0IGFybz1bLi4uZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLmtleXMoKV0uZmlsdGVyKGs9Pmsuc3RhcnRzV2l0aChgJHttb250aH0tYCkpLnNvcnQoKTsKICAgICAgY29uc3QgdW5pPVsuLi5kYWlseVsidW5pdG93ZXItZW5lcmd5Il0ua2V5cygpXS5maWx0ZXIoaz0+ay5zdGFydHNXaXRoKGAke21vbnRofS1gKSkuc29ydCgpOwogICAgICBjb25zdCB1bmlvbj1bLi4ubmV3IFNldChbLi4uYXJvLC4uLnVuaV0pXS5zb3J0KCk7CiAgICAgIGNvbnN0IGNvbXBsZXRlPWZ1bGwoYXJvLHksbSkmJmZ1bGwodW5pLHksbSk7CiAgICAgIGNvbnN0IGhlYXRpbmdFbGVjdHJpY2l0eT0oc3VtKGRhaWx5WyJhcm90aGVybS1lbmVyZ3kiXSxhcm8sIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikrc3VtKGRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXSx1bmksIkNvbnN1bWVkRWxlY3RyaWNhbEVuZXJneTpIZWF0aW5nIikpLzEwMDA7CiAgICAgIGNvbnN0IGRod0VsZWN0cmljaXR5PXN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJDb25zdW1lZEVsZWN0cmljYWxFbmVyZ3k6RG9tZXN0aWNIb3RXYXRlciIpLzEwMDA7CiAgICAgIGNvbnN0IGhlYXRpbmdIZWF0PShzdW0oZGFpbHlbImFyb3RoZXJtLWVuZXJneSJdLGFybywiSGVhdEdlbmVyYXRlZDpIZWF0aW5nIikrc3VtKGRhaWx5WyJ1bml0b3dlci1lbmVyZ3kiXSx1bmksIkhlYXRHZW5lcmF0ZWQ6SGVhdGluZyIpKS8xMDAwOwogICAgICBjb25zdCBkaHdIZWF0PXN1bShkYWlseVsiYXJvdGhlcm0tZW5lcmd5Il0sYXJvLCJIZWF0R2VuZXJhdGVkOkRvbWVzdGljSG90V2F0ZXIiKS8xMDAwOwogICAgICBjb25zdCBlbGVjdHJpY2l0eUtXaD1oZWF0aW5nRWxlY3RyaWNpdHkrZGh3RWxlY3RyaWNpdHksaGVhdEdlbmVyYXRlZEtXaD1oZWF0aW5nSGVhdCtkaHdIZWF0OwogICAgICBjb25zdCBleGlzdGluZz1yZWNvcmRGb3JNb250aChtb250aCk7CiAgICAgIGNvbnN0IG5lZ2F0aXZlUmVzdD1Cb29sZWFuKGV4aXN0aW5nJiZOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcudG90YWwpJiZOdW1iZXIuaXNGaW5pdGUoZXhpc3RpbmcuYW5uZXgpJiZleGlzdGluZy50b3RhbC1lbGVjdHJpY2l0eUtXaC1leGlzdGluZy5hbm5leDwtLjAxKTsKICAgICAgY29uc3QgaGFzQ29uZmxpY3Q9Y29uZmxpY3RNb250aHMuaGFzKG1vbnRoKSxoYXNCb3RoPWFyby5sZW5ndGg+MCYmdW5pLmxlbmd0aD4wLGlzQ3VycmVudD1tb250aD09PWN1cnJlbnQsaXNGdXR1cmU9bW9udGg+Y3VycmVudDsKICAgICAgY29uc3QgYmxvY2tlZD0haGFzQm90aHx8aGFzQ29uZmxpY3R8fG5lZ2F0aXZlUmVzdHx8aXNGdXR1cmV8fCghY29tcGxldGUmJiFpc0N1cnJlbnQpOwogICAgICByZXR1cm4ge21vbnRoLGVsZWN0cmljaXR5S1doLGhlYXRHZW5lcmF0ZWRLV2gsaGVhdGluZ0VsZWN0cmljaXR5S1doOmhlYXRpbmdFbGVjdHJpY2l0eSxkaHdFbGVjdHJpY2l0eUtXaDpkaHdFbGVjdHJpY2l0eSxoZWF0aW5nSGVhdEtXaDpoZWF0aW5nSGVhdCxkaHdIZWF0S1doOmRod0hlYXQsY29tcGxldGUsY292ZXJhZ2VTdGFydDp1bmlvblswXXx8bnVsbCxjb3ZlcmFnZUVuZDp1bmlvbi5hdCgtMSl8fG51bGwsYmxvY2tlZCxoYXNCb3RoLGhhc0NvbmZsaWN0LG5lZ2F0aXZlUmVzdCxpc0N1cnJlbnR9OwogICAgfSk7CiAgICByZXR1cm4ge21vbnRocyxkdXBsaWNhdGVSb3dzLHJlY29nbml6ZWQ6cGFyc2VkRmlsZXMuZmlsdGVyKGY9PmYudHlwZSE9PSJ1bmtub3duIikubGVuZ3RoLHVua25vd246cGFyc2VkRmlsZXMuZmlsdGVyKGY9PmYudHlwZT09PSJ1bmtub3duIikubGVuZ3RoLGludmFsaWRSb3dzOnBhcnNlZEZpbGVzLnJlZHVjZSgocyxmKT0+cytmLmludmFsaWRSb3dzLDApfTsKICB9CiAgZnVuY3Rpb24gbWVyZ2VWYWlsbGFudEltcG9ydChtb250aHMpewogICAgY29uc3QgcmVjb3JkTWFwPW5ldyBNYXAocmVjb3Jkcy5tYXAocj0+W3IubW9udGgsey4uLnJ9XSkpOwogICAgY29uc3QgdmFpbGxhbnRNYXA9bmV3IE1hcCgodmFpbGxhbnRNb250aHN8fFtdKS5tYXAodj0+W3YubW9udGgsey4uLnZ9XSkpOwogICAgY29uc3Qgc3RhbXA9bmV3IERhdGUoKS50b0lTT1N0cmluZygpO2xldCBpbXBvcnRlZD0wLGNyZWF0ZWQ9MCxwYXJ0aWFsPTA7CiAgICBmb3IoY29uc3QgbW9udGggb2YgbW9udGhzLmZpbHRlcihtPT4hbS5ibG9ja2VkKSl7CiAgICAgIGNvbnN0IGV4aXN0aW5nPXJlY29yZE1hcC5nZXQobW9udGgubW9udGgpfHxzYW5pdGl6ZVJlY29yZCh7bW9udGg6bW9udGgubW9udGh9KTsKICAgICAgY29uc3Qgd2FzTmV3PSFyZWNvcmRNYXAuaGFzKG1vbnRoLm1vbnRoKTsKICAgICAgZXhpc3RpbmcuaGVhdFB1bXA9bW9udGguZWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRHZW5lcmF0ZWQ9bW9udGguaGVhdEdlbmVyYXRlZEtXaDsKICAgICAgZXhpc3RpbmcuaGVhdGluZ0VsZWN0cmljaXR5PW1vbnRoLmhlYXRpbmdFbGVjdHJpY2l0eUtXaDsKICAgICAgZXhpc3RpbmcuZGh3RWxlY3RyaWNpdHk9bW9udGguZGh3RWxlY3RyaWNpdHlLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRpbmdIZWF0PW1vbnRoLmhlYXRpbmdIZWF0S1doOwogICAgICBleGlzdGluZy5kaHdIZWF0PW1vbnRoLmRod0hlYXRLV2g7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wU291cmNlPW1vbnRoLmNvbXBsZXRlPyJteXZhaWxsYW50LWNzdi1pbXBvcnQiOiJteXZhaWxsYW50LWNzdi1pbXBvcnQtcGFydGlhbCI7CiAgICAgIGV4aXN0aW5nLmhlYXRQdW1wVXBkYXRlZEF0PXN0YW1wOwogICAgICBpZighbW9udGguY29tcGxldGUpewogICAgICAgIHBhcnRpYWwrKzsKICAgICAgICBjb25zdCBub3RlPWBteVZBSUxMQU5UIENTVi1UZWlsbW9uYXQgJHttb250aC5jb3ZlcmFnZVN0YXJ0fSBiaXMgJHttb250aC5jb3ZlcmFnZUVuZH1gOwogICAgICAgIGlmKCFTdHJpbmcoZXhpc3Rpbmcubm90ZXx8IiIpLmluY2x1ZGVzKG5vdGUpKWV4aXN0aW5nLm5vdGU9ZXhpc3Rpbmcubm90ZT9gJHtleGlzdGluZy5ub3RlfSDigKIgJHtub3RlfWA6bm90ZTsKICAgICAgICBleGlzdGluZy5jbG9zZWQ9ZmFsc2U7ZXhpc3RpbmcuY2xvc2VkQXQ9bnVsbDsKICAgICAgfQogICAgICByZWNvcmRNYXAuc2V0KG1vbnRoLm1vbnRoLGV4aXN0aW5nKTsKICAgICAgdmFpbGxhbnRNYXAuc2V0KG1vbnRoLm1vbnRoLHttb250aDptb250aC5tb250aCxlbGVjdHJpY2l0eUtXaDptb250aC5lbGVjdHJpY2l0eUtXaCxoZWF0R2VuZXJhdGVkS1doOm1vbnRoLmhlYXRHZW5lcmF0ZWRLV2gsaGVhdGluZ0VsZWN0cmljaXR5S1doOm1vbnRoLmhlYXRpbmdFbGVjdHJpY2l0eUtXaCxkaHdFbGVjdHJpY2l0eUtXaDptb250aC5kaHdFbGVjdHJpY2l0eUtXaCxoZWF0aW5nSGVhdEtXaDptb250aC5oZWF0aW5nSGVhdEtXaCxkaHdIZWF0S1doOm1vbnRoLmRod0hlYXRLV2gsc291cmNlOmV4aXN0aW5nLmhlYXRQdW1wU291cmNlLGVzdGltYXRlZDohbW9udGguY29tcGxldGUsdXBkYXRlZEF0OnN0YW1wfSk7CiAgICAgIGltcG9ydGVkKys7aWYod2FzTmV3KWNyZWF0ZWQrKzsKICAgIH0KICAgIHNhdmVSZWNvcmRzKFsuLi5yZWNvcmRNYXAudmFsdWVzKCldLHtyZWFzb246Im15VkFJTExBTlQgQ1NWIGltcG9ydGllcnQifSk7CiAgICB2YWlsbGFudE1vbnRocz1bLi4udmFpbGxhbnRNYXAudmFsdWVzKCldLnNvcnQoKGEsYik9PmEubW9udGgubG9jYWxlQ29tcGFyZShiLm1vbnRoKSk7c2F2ZVZhaWxsYW50TW9udGhzKCk7CiAgICByZXR1cm4ge2ltcG9ydGVkLGNyZWF0ZWQscGFydGlhbH07CiAgfQogIGFzeW5jIGZ1bmN0aW9uIGltcG9ydFZhaWxsYW50Q3N2RmlsZXMoZmlsZUxpc3QpewogICAgY29uc3QgZmlsZXM9Wy4uLihmaWxlTGlzdHx8W10pXTsKICAgIGlmKCFmaWxlcy5sZW5ndGgpcmV0dXJuOwogICAgc2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsIkRhdGVpZW4gd2VyZGVuIGxva2FsIGdlcHLDvGZ0IOKApiIpOwogICAgdHJ5ewogICAgICBjb25zdCBwYXJzZWQ9W107CiAgICAgIGZvcihsZXQgaT0wO2k8ZmlsZXMubGVuZ3RoO2krKylwYXJzZWQucHVzaChwYXJzZVZhaWxsYW50Q3N2VGV4dChhd2FpdCBmaWxlc1tpXS50ZXh0KCksaSkpOwogICAgICBjb25zdCBwcmV2aWV3PWJ1aWxkVmFpbGxhbnRJbXBvcnRQcmV2aWV3KHBhcnNlZCk7CiAgICAgIGNvbnN0IGltcG9ydGFibGU9cHJldmlldy5tb250aHMuZmlsdGVyKG09PiFtLmJsb2NrZWQpOwogICAgICBjb25zdCBtaXNzaW5nQXJvPSFwYXJzZWQuc29tZShmPT5mLnR5cGU9PT0iYXJvdGhlcm0tZW5lcmd5IiksbWlzc2luZ1VuaT0hcGFyc2VkLnNvbWUoZj0+Zi50eXBlPT09InVuaXRvd2VyLWVuZXJneSIpOwogICAgICBpZihtaXNzaW5nQXJvfHxtaXNzaW5nVW5pKXRocm93IG5ldyBFcnJvcihgRXMgZmVobGVuICR7W21pc3NpbmdBcm8/ImFyb1RIRVJNLUVuZXJnaWUiOm51bGwsbWlzc2luZ1VuaT8idW5pVE9XRVItRW5lcmdpZSI6bnVsbF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIiB1bmQgIil9LiBCaXR0ZSBiZWlkZSBFeHBvcnRkYXRlaWVuIGF1c3fDpGhsZW4uYCk7CiAgICAgIGlmKCFwcmV2aWV3Lm1vbnRocy5sZW5ndGgpdGhyb3cgbmV3IEVycm9yKCJLZWluZSBXw6RybWVwdW1wZW4tTW9uYXRzZGF0ZW4gZXJrYW5udC4iKTsKICAgICAgaWYoIWltcG9ydGFibGUubGVuZ3RoKXsKICAgICAgICBjb25zdCBibG9ja2VkPXByZXZpZXcubW9udGhzLm1hcChtPT5gJHttb250aExhYmVsKG0ubW9udGgsZmFsc2UpfTogJHttLmhhc0NvbmZsaWN0PyJLb25mbGlrdCI6bS5uZWdhdGl2ZVJlc3Q/InVucGxhdXNpYmxlciBSZXN0dmVyYnJhdWNoIjohbS5oYXNCb3RoPyJEYXRlaSBmZWhsdCI6IW0uY29tcGxldGUmJiFtLmlzQ3VycmVudD8iaGlzdG9yaXNjaGVyIFRlaWxtb25hdCI6Im5pY2h0IGltcG9ydGllcmJhciJ9YCkuam9pbigiIOKAoiAiKTsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEtlaW5lIGltcG9ydGllcmJhcmVuIE1vbmF0ZS4gJHtibG9ja2VkfWApOwogICAgICB9CiAgICAgIGNvbnN0IGJsb2NrZWRDb3VudD1wcmV2aWV3Lm1vbnRocy5sZW5ndGgtaW1wb3J0YWJsZS5sZW5ndGg7CiAgICAgIGNvbnN0IG1lc3NhZ2U9YCR7aW1wb3J0YWJsZS5sZW5ndGh9IE1vbmF0KGUpIGltcG9ydGllcmVuPyR7YmxvY2tlZENvdW50P2AgJHtibG9ja2VkQ291bnR9IHVudm9sbHN0w6RuZGlnZS9hdWZmw6RsbGlnZSBNb25hdGUgd2VyZGVuIMO8YmVyc3BydW5nZW4uYDoiIn0gR2VzYW10dmVyYnJhdWNoLCBBbHRlbnRlaWwsIFByZWlzZSB1bmQgTm90aXplbiBibGVpYmVuIGVyaGFsdGVuLmA7CiAgICAgIGlmKCFjb25maXJtKG1lc3NhZ2UpKXtzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIiwiSW1wb3J0IGFiZ2Vicm9jaGVuLiIpO3JldHVybjt9CiAgICAgIGNvbnN0IHJlc3VsdD1tZXJnZVZhaWxsYW50SW1wb3J0KGltcG9ydGFibGUpOwogICAgICByZW5kZXJBbGwoKTsKICAgICAgc2V0U3RhdHVzKCJ2YWlsbGFudEltcG9ydFN0YXR1cyIsYCR7cmVzdWx0LmltcG9ydGVkfSBNb25hdChlKSBpbXBvcnRpZXJ0JHtyZXN1bHQucGFydGlhbD9gIMK3ICR7cmVzdWx0LnBhcnRpYWx9IGFrdHVlbGxlciBUZWlsbW9uYXRgOiIifSR7YmxvY2tlZENvdW50P2AgwrcgJHtibG9ja2VkQ291bnR9IMO8YmVyc3BydW5nZW5gOiIifS5gLCJvayIpOwogICAgICB0b2FzdChgJHtyZXN1bHQuaW1wb3J0ZWR9IFfDpHJtZXB1bXBlbi1Nb25hdGUgaW1wb3J0aWVydGApOwogICAgfWNhdGNoKGVycm9yKXtzZXRTdGF0dXMoInZhaWxsYW50SW1wb3J0U3RhdHVzIixlcnJvci5tZXNzYWdlLCJlcnJvciIpO30KICAgIGZpbmFsbHl7JCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikudmFsdWU9IiI7fQogIH0KCiAgYXN5bmMgZnVuY3Rpb24gb3N0cm9tRmV0Y2gocGF0aCl7CiAgICBpZighc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXRocm93IG5ldyBFcnJvcigiQXBwLVNjaGzDvHNzZWwgZmVobHQuIik7CiAgICBjb25zdCByZXNwb25zZT1hd2FpdCBmZXRjaChwYXRoLHtoZWFkZXJzOnsieC1lbGRlaG9mLWtleSI6c2V0dGluZ3Mub3N0cm9tQXBwS2V5LCJhY2NlcHQiOiJhcHBsaWNhdGlvbi9qc29uIn0sY2FjaGU6Im5vLXN0b3JlIn0pOyBjb25zdCB0ZXh0PWF3YWl0IHJlc3BvbnNlLnRleHQoKTsgbGV0IHBheWxvYWQ9e307IHRyeXtwYXlsb2FkPXRleHQ/SlNPTi5wYXJzZSh0ZXh0KTp7fTt9Y2F0Y2h7fQogICAgaWYoIXJlc3BvbnNlLm9rKXRocm93IG5ldyBFcnJvcihwYXlsb2FkLmVycm9yfHxwYXlsb2FkLm1lc3NhZ2V8fHRleHR8fGBGZWhsZXIgJHtyZXNwb25zZS5zdGF0dXN9YCk7IHJldHVybiBwYXlsb2FkOwogIH0KICBhc3luYyBmdW5jdGlvbiByZWZyZXNoT3N0cm9tKHNob3dUb2FzdD1mYWxzZSl7CiAgICBpZihvc3Ryb21CdXN5fHwhc2V0dGluZ3Mub3N0cm9tQXBwS2V5KXtyZW5kZXJPc3Ryb21EYXNoYm9hcmQoKTtyZXR1cm4gZmFsc2U7fQogICAgb3N0cm9tQnVzeT10cnVlO3JlbmRlck9zdHJvbURhc2hib2FyZCgpOwogICAgdHJ5eyBjb25zdCBwYXlsb2FkPWF3YWl0IG9zdHJvbUZldGNoKGAvYXBpL2xpdmUke3Nob3dUb2FzdD8iP3JlZnJlc2g9MSI6IiJ9YCk7IHNhdmVPc3Ryb21DYWNoZShwYXlsb2FkKTsgaWYoc2hvd1RvYXN0KXRvYXN0KCJPc3Ryb20gYWt0dWFsaXNpZXJ0Iik7IHJldHVybiB0cnVlOyB9CiAgICBjYXRjaChlcnJvcil7IHNldE9zdHJvbVN0YXR1cyhgRmVobGVyOiAke2Vycm9yLm1lc3NhZ2V9YCwiZXJyb3IiKTsgaWYoc2hvd1RvYXN0KXRvYXN0KGBPc3Ryb206ICR7ZXJyb3IubWVzc2FnZX1gKTsgcmV0dXJuIGZhbHNlOyB9CiAgICBmaW5hbGx5e29zdHJvbUJ1c3k9ZmFsc2U7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7fQogIH0KICBmdW5jdGlvbiBzY2hlZHVsZU9zdHJvbSgpeyBjbGVhckludGVydmFsKG9zdHJvbVRpbWVyKTtvc3Ryb21UaW1lcj1udWxsOyBpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkmJnNldHRpbmdzLm9zdHJvbUF1dG9SZWZyZXNoIT09ZmFsc2Upb3N0cm9tVGltZXI9c2V0SW50ZXJ2YWwoKCk9PnJlZnJlc2hPc3Ryb20oZmFsc2UpLDEwKjYwKjEwMDApOyB9CiAgZnVuY3Rpb24gc2V0T3N0cm9tU3RhdHVzKHRleHQsa2luZD0iIil7IGNvbnN0IGVsPSQoIm9zdHJvbVN0YXR1cyIpO2VsLnRleHRDb250ZW50PXRleHQ7ZWwuc3R5bGUuY29sb3I9a2luZD09PSJlcnJvciI/IiNmZmFhYTkiOiIiOyB9CiAgZnVuY3Rpb24gZm9ybWF0RGF0ZVRpbWUodmFsdWUpeyBjb25zdCBkPW5ldyBEYXRlKHZhbHVlKTsgaWYoTnVtYmVyLmlzTmFOKGQudmFsdWVPZigpKSlyZXR1cm4gIuKAkyI7IHJldHVybiBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHt3ZWVrZGF5OiJzaG9ydCIsZGF5OiIyLWRpZ2l0Iixtb250aDoiMi1kaWdpdCIsaG91cjoiMi1kaWdpdCIsbWludXRlOiIyLWRpZ2l0In0pLmZvcm1hdChkKTsgfQogIGZ1bmN0aW9uIGludGVydmFsUm93cygpeyByZXR1cm4gKEFycmF5LmlzQXJyYXkob3N0cm9tTGl2ZT8ucHJpY2VGb3JlY2FzdCk/b3N0cm9tTGl2ZS5wcmljZUZvcmVjYXN0OltdKS5tYXAocD0+KHt0aW1lOm5ldyBEYXRlKHAuZGF0ZXx8cC5zdGFydHx8cC50aW1lc3RhbXApLmdldFRpbWUoKSxwcmljZTpOdW1iZXIocC50b3RhbEN0UGVyS1doPz9wLnByaWNlQ3RQZXJLV2g/P3AucHJpY2UpfSkpLmZpbHRlcihwPT5OdW1iZXIuaXNGaW5pdGUocC50aW1lKSYmTnVtYmVyLmlzRmluaXRlKHAucHJpY2UpKS5zb3J0KChhLGIpPT5hLnRpbWUtYi50aW1lKTsgfQogIGZ1bmN0aW9uIGluZmVyU3RlcChyb3dzKXsgY29uc3QgZGlmZnM9W107Zm9yKGxldCBpPTE7aTxyb3dzLmxlbmd0aDtpKyspe2NvbnN0IGQ9cm93c1tpXS50aW1lLXJvd3NbaS0xXS50aW1lO2lmKGQ+PTUqNjBlMyYmZDw9MiozNjAwZTMpZGlmZnMucHVzaChkKTt9IGlmKCFkaWZmcy5sZW5ndGgpcmV0dXJuIDM2MDBlMztkaWZmcy5zb3J0KChhLGIpPT5hLWIpO3JldHVybiBkaWZmc1tNYXRoLmZsb29yKGRpZmZzLmxlbmd0aC8yKV07IH0KICBmdW5jdGlvbiBjb21wdXRlUHJpY2VXaW5kb3cocm93cyxob3Vycyxtb2RlKXsKICAgIGlmKCFyb3dzLmxlbmd0aClyZXR1cm4gbnVsbDsgY29uc3Qgc3RlcD1pbmZlclN0ZXAocm93cyk7IGNvbnN0IGNvdW50PU1hdGgubWF4KDEsTWF0aC5yb3VuZChob3VycyozNjAwZTMvc3RlcCkpOyBjb25zdCBub3c9RGF0ZS5ub3coKTsgY29uc3QgcG9vbD1yb3dzLmZpbHRlcihyPT5yLnRpbWU+PW5vdy1zdGVwKS5zbGljZSgwLE1hdGgubWF4KGNvdW50LE1hdGgucm91bmQoNDgqMzYwMGUzL3N0ZXApKSk7CiAgICBsZXQgYmVzdD1udWxsOwogICAgZm9yKGxldCBpPTA7aStjb3VudDw9cG9vbC5sZW5ndGg7aSsrKXtjb25zdCBzbGljZT1wb29sLnNsaWNlKGksaStjb3VudCk7bGV0IGNvbnRpZ3VvdXM9dHJ1ZTtmb3IobGV0IGo9MTtqPHNsaWNlLmxlbmd0aDtqKyspaWYoc2xpY2Vbal0udGltZS1zbGljZVtqLTFdLnRpbWU+c3RlcCoxLjYpe2NvbnRpZ3VvdXM9ZmFsc2U7YnJlYWs7fWlmKCFjb250aWd1b3VzKWNvbnRpbnVlO2NvbnN0IGF2Zz1zbGljZS5yZWR1Y2UoKHMscik9PnMrci5wcmljZSwwKS9zbGljZS5sZW5ndGg7Y29uc3QgY2FuZGlkYXRlPXtzdGFydDpzbGljZVswXS50aW1lLGVuZDpzbGljZS5hdCgtMSkudGltZStzdGVwLGF2Z307aWYoIWJlc3R8fChtb2RlPT09Im1pbiI/YXZnPGJlc3QuYXZnOmF2Zz5iZXN0LmF2ZykpYmVzdD1jYW5kaWRhdGU7fQogICAgcmV0dXJuIGJlc3Q7CiAgfQogIGZ1bmN0aW9uIHJlbmRlck9zdHJvbURhc2hib2FyZCgpewogICAgY29uc3QgY29ubmVjdGVkPUJvb2xlYW4oc2V0dGluZ3Mub3N0cm9tQXBwS2V5KTsgJCgib3N0cm9tU2V0dXBIaW50IikuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIixjb25uZWN0ZWQpOyAkKCJvc3Ryb21EYXNoYm9hcmQiKS5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCFjb25uZWN0ZWQpOyAkKCJvc3Ryb21NaW5pQ2hhcnQiKS5wYXJlbnRFbGVtZW50LmNsYXNzTGlzdC50b2dnbGUoImhpZGRlbiIsIWNvbm5lY3RlZCk7ICQoInJlZnJlc2hPc3Ryb21CdG4iKS5kaXNhYmxlZD0hY29ubmVjdGVkfHxvc3Ryb21CdXN5OwogICAgaWYoIWNvbm5lY3RlZCl7IHNldE9zdHJvbVN0YXR1cygiTmljaHQgdmVyYnVuZGVuIik7IHJldHVybjsgfQogICAgaWYob3N0cm9tQnVzeSlzZXRPc3Ryb21TdGF0dXMoIkFrdHVhbGlzaWVydW5nIGzDpHVmdCDigKYiKTsgZWxzZSBpZihvc3Ryb21MaXZlPy5nZW5lcmF0ZWRBdClzZXRPc3Ryb21TdGF0dXMoYEFrdHVhbGlzaWVydCAke2Zvcm1hdERhdGVUaW1lKG9zdHJvbUxpdmUuZ2VuZXJhdGVkQXQpfWApOyBlbHNlIHNldE9zdHJvbVN0YXR1cygiTm9jaCBrZWluZSBMaXZlLURhdGVuIik7CiAgICBjb25zdCByb3dzPWludGVydmFsUm93cygpOyBpZighcm93cy5sZW5ndGgpeyBbIm9zdHJvbUN1cnJlbnRQcmljZSIsIm9zdHJvbUJlc3RQcmljZSIsIm9zdHJvbVdvcnN0UHJpY2UiXS5mb3JFYWNoKGlkPT4kKGlkKS50ZXh0Q29udGVudD0i4oCTIik7IFsib3N0cm9tQ3VycmVudE1ldGEiLCJvc3Ryb21CZXN0TWV0YSIsIm9zdHJvbVdvcnN0TWV0YSJdLmZvckVhY2goaWQ9PiQoaWQpLnRleHRDb250ZW50PSJOb2NoIGtlaW5lIFByZWlzdm9yc2NoYXUiKTsgZHJhd09zdHJvbU1pbmkoW10pOyByZXR1cm47IH0KICAgIGNvbnN0IG5vdz1EYXRlLm5vdygpLHN0ZXA9aW5mZXJTdGVwKHJvd3MpOyBjb25zdCBjdXJyZW50PXJvd3MuZmluZCgocixpKT0+ci50aW1lPD1ub3cmJihyb3dzW2krMV0/LnRpbWU/P3IudGltZStzdGVwKT5ub3cpfHxyb3dzLmZpbmQocj0+ci50aW1lPm5vdyl8fHJvd3MuYXQoLTEpOyBjb25zdCBob3Vycz1OdW1iZXIoc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnMpfHwzOyBjb25zdCBiZXN0PWNvbXB1dGVQcmljZVdpbmRvdyhyb3dzLGhvdXJzLCJtaW4iKSwgd29yc3Q9Y29tcHV0ZVByaWNlV2luZG93KHJvd3MsaG91cnMsIm1heCIpOwogICAgJCgib3N0cm9tQmVzdExhYmVsIikudGV4dENvbnRlbnQ9YEJlc3RlcyAke2hvdXJzfWgtRmVuc3RlcmA7ICQoIm9zdHJvbVdvcnN0TGFiZWwiKS50ZXh0Q29udGVudD1gU2NobGVjaHRlc3RlcyAke2hvdXJzfWgtRmVuc3RlcmA7CiAgICAkKCJvc3Ryb21DdXJyZW50UHJpY2UiKS50ZXh0Q29udGVudD1gJHtudW0oY3VycmVudD8ucHJpY2UsMil9IGN0L2tXaGA7ICQoIm9zdHJvbUN1cnJlbnRNZXRhIikudGV4dENvbnRlbnQ9Y3VycmVudD9mb3JtYXREYXRlVGltZShjdXJyZW50LnRpbWUpOiLigJMiOwogICAgJCgib3N0cm9tQmVzdFByaWNlIikudGV4dENvbnRlbnQ9YmVzdD9gJHtudW0oYmVzdC5hdmcsMil9IGN0L2tXaGA6IuKAkyI7ICQoIm9zdHJvbUJlc3RNZXRhIikudGV4dENvbnRlbnQ9YmVzdD9gJHtmb3JtYXREYXRlVGltZShiZXN0LnN0YXJ0KX0g4oCTICR7bmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoImRlLURFIix7aG91cjoiMi1kaWdpdCIsbWludXRlOiIyLWRpZ2l0In0pLmZvcm1hdChuZXcgRGF0ZShiZXN0LmVuZCkpfWA6IuKAkyI7CiAgICAkKCJvc3Ryb21Xb3JzdFByaWNlIikudGV4dENvbnRlbnQ9d29yc3Q/YCR7bnVtKHdvcnN0LmF2ZywyKX0gY3Qva1doYDoi4oCTIjsgJCgib3N0cm9tV29yc3RNZXRhIikudGV4dENvbnRlbnQ9d29yc3Q/YCR7Zm9ybWF0RGF0ZVRpbWUod29yc3Quc3RhcnQpfSDigJMgJHtuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgiZGUtREUiLHtob3VyOiIyLWRpZ2l0IixtaW51dGU6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHdvcnN0LmVuZCkpfWA6IuKAkyI7CiAgICBkcmF3T3N0cm9tTWluaShyb3dzLmZpbHRlcihyPT5yLnRpbWU+PW5vdy1zdGVwKS5zbGljZSgwLDQ4KSk7CiAgfQogIGZ1bmN0aW9uIGRyYXdPc3Ryb21NaW5pKHJvd3MpewogICAgY29uc3QgYz1jYW52YXNTZXR1cCgkKCJvc3Ryb21NaW5pQ2hhcnQiKSk7IGlmKCFjKXJldHVybjsgY29uc3Qge2N0eCx3aWR0aCxoZWlnaHR9PWM7IGlmKCFyb3dzLmxlbmd0aCl7ZHJhd0VtcHR5KGN0eCx3aWR0aCxoZWlnaHQsIktlaW5lIE9zdHJvbS1QcmVpc2RhdGVuIik7cmV0dXJuO30gY29uc3QgbWluPU1hdGgubWluKC4uLnJvd3MubWFwKHI9PnIucHJpY2UpKSxtYXg9TWF0aC5tYXgoLi4ucm93cy5tYXAocj0+ci5wcmljZSkpLHNwYW49TWF0aC5tYXgoMSxtYXgtbWluKTsgY29uc3QgcGFkPXtsOjQzLHI6OCx0OjEyLGI6MzB9LHc9d2lkdGgtcGFkLmwtcGFkLnIsaD1oZWlnaHQtcGFkLnQtcGFkLmI7CiAgICBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLmdyaWQ7Y3R4LmZpbGxTdHlsZT1DT0xPUlMudGV4dDtjdHguZm9udD0iMTBweCBzYW5zLXNlcmlmIjtmb3IobGV0IGk9MDtpPD0zO2krKyl7Y29uc3QgeT1wYWQudCtoKmkvMztjdHguYmVnaW5QYXRoKCk7Y3R4Lm1vdmVUbyhwYWQubCx5KTtjdHgubGluZVRvKHdpZHRoLXBhZC5yLHkpO2N0eC5zdHJva2UoKTtjdHguZmlsbFRleHQobnVtKG1heC1zcGFuKmkvMywwKSw0LHkrMyk7fSBjdHguc3Ryb2tlU3R5bGU9Q09MT1JTLnRvdGFsO2N0eC5saW5lV2lkdGg9MjtjdHguYmVnaW5QYXRoKCk7cm93cy5mb3JFYWNoKChyLGkpPT57Y29uc3QgeD1wYWQubCsocm93cy5sZW5ndGg9PT0xP3cvMjp3KmkvKHJvd3MubGVuZ3RoLTEpKSx5PXBhZC50K2gqKDEtKHIucHJpY2UtbWluKS9zcGFuKTtpP2N0eC5saW5lVG8oeCx5KTpjdHgubW92ZVRvKHgseSk7fSk7Y3R4LnN0cm9rZSgpOwogICAgY29uc3Qgc3RlcD1NYXRoLm1heCgxLE1hdGguZmxvb3Iocm93cy5sZW5ndGgvNSkpOyByb3dzLmZvckVhY2goKHIsaSk9PntpZihpJXN0ZXAmJmkhPT1yb3dzLmxlbmd0aC0xKXJldHVybjtjb25zdCB4PXBhZC5sKyhyb3dzLmxlbmd0aD09PTE/dy8yOncqaS8ocm93cy5sZW5ndGgtMSkpO2N0eC5maWxsU3R5bGU9Q09MT1JTLnRleHQ7Y3R4LmZpbGxUZXh0KG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCJkZS1ERSIse2hvdXI6IjItZGlnaXQifSkuZm9ybWF0KG5ldyBEYXRlKHIudGltZSkpLHgtOCxoZWlnaHQtOSk7fSk7CiAgfQogIGFzeW5jIGZ1bmN0aW9uIHNhdmVBbmRDaGVja09zdHJvbSgpewogICAgY29uc3Qga2V5PSQoIm9zdHJvbUFwcEtleUlucHV0IikudmFsdWUudHJpbSgpOyBzZXR0aW5ncy5vc3Ryb21BcHBLZXk9a2V5OyBzZXR0aW5ncy5vc3Ryb21BdXRvUmVmcmVzaD0kKCJvc3Ryb21BdXRvUmVmcmVzaElucHV0IikuY2hlY2tlZDsgc2V0dGluZ3MucHJlZmVycmVkV2luZG93SG91cnM9TnVtYmVyKCQoInByZWZlcnJlZFdpbmRvd0hvdXJzSW5wdXQiKS52YWx1ZSl8fDM7IHNhdmVTZXR0aW5ncygpOwogICAgaWYoIWtleSl7c2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIiwiQml0dGUgQXBwLVNjaGzDvHNzZWwgZWludHJhZ2VuLiIsImVycm9yIik7cmVuZGVyT3N0cm9tRGFzaGJvYXJkKCk7cmV0dXJuO30KICAgIHNldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIlZlcmJpbmR1bmcgd2lyZCBnZXByw7xmdCDigKYiKTsKICAgIHRyeXsgY29uc3QgaGVhbHRoPWF3YWl0IG9zdHJvbUZldGNoKCIvYXBpL2hlYWx0aD9kZWVwPXRva2VuIik7IGlmKCFoZWFsdGguY29uZmlndXJlZCl0aHJvdyBuZXcgRXJyb3IoIkNsb3VkZmxhcmUtU2VjcmV0cyBzaW5kIG5pY2h0IHZvbGxzdMOkbmRpZyBlaW5nZXJpY2h0ZXQuIik7IHNldFN0YXR1cygib3N0cm9tQ29ubmVjdGlvblN0YXR1cyIsIk9zdHJvbS1WZXJiaW5kdW5nIGVyZm9sZ3JlaWNoLiIsIm9rIik7IGF3YWl0IHJlZnJlc2hPc3Ryb20odHJ1ZSk7IHNjaGVkdWxlT3N0cm9tKCk7IHJlbmRlckFsbCgpOyB9CiAgICBjYXRjaChlcnJvcil7c2V0U3RhdHVzKCJvc3Ryb21Db25uZWN0aW9uU3RhdHVzIixlcnJvci5tZXNzYWdlLCJlcnJvciIpO30KICB9CiAgZnVuY3Rpb24gZGlzY29ubmVjdE9zdHJvbSgpeyBpZihzZXR0aW5ncy5vc3Ryb21BcHBLZXkmJiFjb25maXJtKCJPc3Ryb20tVmVyYmluZHVuZyB3aXJrbGljaCBlbnRmZXJuZW4/IikpcmV0dXJuOyBzZXR0aW5ncy5vc3Ryb21BcHBLZXk9IiI7c2F2ZVNldHRpbmdzKCk7c2F2ZU9zdHJvbUNhY2hlKG51bGwpO2xvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKE9TVFJPTV9DT05UUk9MX0tFWSk7c2NoZWR1bGVPc3Ryb20oKTtyZW5kZXJBbGwoKTtzZXRTdGF0dXMoIm9zdHJvbUNvbm5lY3Rpb25TdGF0dXMiLCJWZXJiaW5kdW5nIGVudGZlcm50LiIpO3RvYXN0KCJPc3Ryb20gZ2V0cmVubnQiKTsgfQoKICBmdW5jdGlvbiBzYXZlQ29zdFNldHRpbmdzKCl7IHNldHRpbmdzLmZhbGxiYWNrUHJpY2U9TWF0aC5tYXgoMCxOdW1iZXIoJCgiZmFsbGJhY2tQcmljZUlucHV0IikudmFsdWUpfHwwKTtzZXR0aW5ncy5kZWZhdWx0QmFzZUZlZT1NYXRoLm1heCgwLE51bWJlcigkKCJkZWZhdWx0QmFzZUZlZUlucHV0IikudmFsdWUpfHwwKTtzYXZlU2V0dGluZ3MoKTtyZW5kZXJBbGwoKTt0b2FzdCgiS29zdGVuLUVpbnN0ZWxsdW5nZW4gZ2VzcGVpY2hlcnQiKTsgfQoKICBmdW5jdGlvbiByZW5kZXJBbGwoKXsgdXBkYXRlUmVjb3ZlcnlCYW5uZXIoKTtyZW5kZXJEYXNoYm9hcmQoKTtyZW5kZXJSZWNvcmRzKCk7cmVuZGVyQW5hbHlzaXMoKTtyZW5kZXJEYXRhKCk7IH0KICBmdW5jdGlvbiByZXNpemVDaGFydHMoKXsgY2xlYXJUaW1lb3V0KHJlc2l6ZVRpbWVyKTtyZXNpemVUaW1lcj1zZXRUaW1lb3V0KCgpPT57IGlmKGN1cnJlbnRWaWV3PT09ImRhc2hib2FyZFZpZXciKXJlbmRlckRhc2hib2FyZCgpOyBpZihjdXJyZW50Vmlldz09PSJhbmFseXNpc1ZpZXciKXJlbmRlckFuYWx5c2lzKCk7IH0sMTAwKTsgfQoKICBmdW5jdGlvbiBiaW5kKCl7CiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsZXZlbnQ9PnsKICAgICAgY29uc3QgbmF2PWV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1uYXZdIik7IGlmKG5hdil7c3dpdGNoVmlldyhuYXYuZGF0YXNldC5uYXYpO3JldHVybjt9CiAgICAgIGlmKGV2ZW50LnRhcmdldC5jbG9zZXN0KCJbZGF0YS1jbG9zZS1tZXRlci1tb2RhbF0iKSl7Y2xvc2VNZXRlck1vZGFsKCk7cmV0dXJuO30KICAgIH0pOwogICAgJCgiZGFzaGJvYXJkQWRkQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLG9wZW5NZXRlck1vZGFsKTsgJCgiYWRkUmVjb3JkQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLG9wZW5NZXRlck1vZGFsKTsgJCgiYWRkTWV0ZXJCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsb3Blbk1ldGVyTW9kYWwpOwogICAgJCgibWV0ZXJGb3JtIikuYWRkRXZlbnRMaXN0ZW5lcigic3VibWl0IixzYXZlTWV0ZXJSZWFkaW5nRnJvbUZvcm0pOyBbIm1ldGVyRGF0ZSIsIm1ldGVyVG90YWwiLCJtZXRlckFubmV4Il0uZm9yRWFjaChpZD0+JChpZCkuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLHVwZGF0ZU1ldGVyUHJldmlldykpOwogICAgJCgidW5kb0xhdGVzdE1ldGVyQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHVuZG9MYXRlc3RNZXRlclJlYWRpbmcpOwogICAgJCgicmVjb3JkWWVhckZpbHRlciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIscmVuZGVyUmVjb3Jkcyk7ICQoImFuYWx5c2lzWWVhciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsKCk9Pntjb25zdCB5PU51bWJlcigkKCJhbmFseXNpc1llYXIiKS52YWx1ZSk7JCgiYW5hbHlzaXNDb21wYXJlWWVhciIpLnZhbHVlPXllYXJzKCkuaW5jbHVkZXMoeS0xKT9TdHJpbmcoeS0xKToibm9uZSI7cmVuZGVyQW5hbHlzaXMoKTt9KTsgJCgiYW5hbHlzaXNDb21wYXJlWWVhciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIscmVuZGVyQW5hbHlzaXMpOwogICAgJCgicmVzdG9yZVNoYWRvd0J0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixyZXN0b3JlU2hhZG93KTsgJCgiZXhwb3J0QmFja3VwQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLGV4cG9ydEJhY2t1cCk7ICQoImV4cG9ydENzdkJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixleHBvcnRDc3YpOyAkKCJpbXBvcnRCYWNrdXBJbnB1dCIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsKCk9Pntjb25zdCBmPSQoImltcG9ydEJhY2t1cElucHV0IikuZmlsZXM/LlswXTtpZihmKWltcG9ydEJhY2t1cChmKTt9KTsKICAgICQoInZhaWxsYW50Q3N2RmlsZXNJbnB1dCIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsKCk9PmltcG9ydFZhaWxsYW50Q3N2RmlsZXMoJCgidmFpbGxhbnRDc3ZGaWxlc0lucHV0IikuZmlsZXMpKTsKICAgICQoInNhdmVPc3Ryb21CdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsc2F2ZUFuZENoZWNrT3N0cm9tKTsgJCgiZGlzY29ubmVjdE9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIixkaXNjb25uZWN0T3N0cm9tKTsgJCgicmVmcmVzaE9zdHJvbUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwoKT0+cmVmcmVzaE9zdHJvbSh0cnVlKSk7ICQoImdvT3N0cm9tU2V0dGluZ3NCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsKCk9Pntzd2l0Y2hWaWV3KCJkYXRhVmlldyIpO3NldFRpbWVvdXQoKCk9PiQoIm9zdHJvbVNldHRpbmdzUGFuZWwiKS5zY3JvbGxJbnRvVmlldyh7YmVoYXZpb3I6InNtb290aCIsYmxvY2s6InN0YXJ0In0pLDEwMCk7fSk7CiAgICAkKCJzYXZlQ29zdFNldHRpbmdzQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLHNhdmVDb3N0U2V0dGluZ3MpOwogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInJlc2l6ZSIscmVzaXplQ2hhcnRzKTsgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigidmlzaWJpbGl0eWNoYW5nZSIsKCk9PntpZighZG9jdW1lbnQuaGlkZGVuJiZzZXR0aW5ncy5vc3Ryb21BcHBLZXkpe2NvbnN0IGFnZT1EYXRlLm5vdygpLURhdGUucGFyc2Uob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKTtpZighTnVtYmVyLmlzRmluaXRlKGFnZSl8fGFnZT4xMCo2MGUzKXJlZnJlc2hPc3Ryb20oZmFsc2UpO319KTsKICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24iLGV2ZW50PT57aWYoZXZlbnQua2V5PT09IkVzY2FwZSImJiEkKCJtZXRlck1vZGFsIikuY2xhc3NMaXN0LmNvbnRhaW5zKCJoaWRkZW4iKSljbG9zZU1ldGVyTW9kYWwoKTt9KTsKICB9CgogIGZ1bmN0aW9uIGluaXQoKXsKICAgIGFwcGx5SGlzdG9yaWNhbFNlZWQoKTtlbnN1cmVNZXRlckJhc2VsaW5lKCk7CiAgICBiaW5kKCk7cmVuZGVyQWxsKCk7c2NoZWR1bGVPc3Ryb20oKTsKICAgIGlmKHNldHRpbmdzLm9zdHJvbUFwcEtleSl7IGNvbnN0IGFnZT1EYXRlLm5vdygpLURhdGUucGFyc2Uob3N0cm9tTGl2ZT8uZ2VuZXJhdGVkQXR8fCIiKTsgaWYoIW9zdHJvbUxpdmV8fCFOdW1iZXIuaXNGaW5pdGUoYWdlKXx8YWdlPjEwKjYwZTMpcmVmcmVzaE9zdHJvbShmYWxzZSk7IH0KICAgIGlmKCJzZXJ2aWNlV29ya2VyIiBpbiBuYXZpZ2F0b3Ipd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoImxvYWQiLCgpPT5uYXZpZ2F0b3Iuc2VydmljZVdvcmtlci5yZWdpc3Rlcigic3cuanM/dj02LjEuMCIpLmNhdGNoKCgpPT57fSkpOwogICAgY29uc29sZS5pbmZvKGBFbGRlaG9mICR7QVBQX0JVSUxEfWApOwogIH0KICBpbml0KCk7Cn0pKCk7Cg==","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/sw.js":{"body":"Y29uc3QgQ0FDSEU9ImVsZGVob2YtdjYtMS0wLW1ldGVyLXZhaWxsYW50LW9zdHJvbS0yMDI2MTAwNSI7CmNvbnN0IENPUkU9WyIuLyIsIi4vP3Y9Ni4xLjAiLCIuL2luZGV4Lmh0bWwiLCIuL3N0eWxlcy5jc3M/dj02LjEuMCIsIi4vYXBwLmpzP3Y9Ni4xLjAiLCIuL21hbmlmZXN0LndlYm1hbmlmZXN0IiwiLi9pY29uLTE5Mi5wbmciLCIuL2ljb24tNTEyLnBuZyJdOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImluc3RhbGwiLGV2ZW50PT57ZXZlbnQud2FpdFVudGlsKGNhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMuYWRkQWxsKENPUkUpKS50aGVuKCgpPT5zZWxmLnNraXBXYWl0aW5nKCkpKX0pOwpzZWxmLmFkZEV2ZW50TGlzdGVuZXIoImFjdGl2YXRlIixldmVudD0+e2V2ZW50LndhaXRVbnRpbChjYWNoZXMua2V5cygpLnRoZW4oa2V5cz0+UHJvbWlzZS5hbGwoa2V5cy5maWx0ZXIoaz0+ayE9PUNBQ0hFKS5tYXAoaz0+Y2FjaGVzLmRlbGV0ZShrKSkpKS50aGVuKCgpPT5zZWxmLmNsaWVudHMuY2xhaW0oKSkpfSk7CnNlbGYuYWRkRXZlbnRMaXN0ZW5lcigiZmV0Y2giLGV2ZW50PT57CiAgY29uc3QgdXJsPW5ldyBVUkwoZXZlbnQucmVxdWVzdC51cmwpOwogIGlmKGV2ZW50LnJlcXVlc3QubWV0aG9kIT09IkdFVCJ8fHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCIvYXBpLyIpKXJldHVybjsKICBldmVudC5yZXNwb25kV2l0aChmZXRjaChldmVudC5yZXF1ZXN0KS50aGVuKHJlc3BvbnNlPT57Y29uc3QgY29weT1yZXNwb25zZS5jbG9uZSgpO2NhY2hlcy5vcGVuKENBQ0hFKS50aGVuKGM9PmMucHV0KGV2ZW50LnJlcXVlc3QsY29weSkpO3JldHVybiByZXNwb25zZTt9KS5jYXRjaCgoKT0+Y2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4oY2FjaGVkPT5jYWNoZWR8fGNhY2hlcy5tYXRjaCgiLi9pbmRleC5odG1sIikpKSk7Cn0pOwo=","type":"text/javascript; charset=utf-8","cache":"no-cache"},"/manifest.webmanifest":{"body":"ewogICJuYW1lIjogIkVsZGVob2YgNi4xIOKAkyBWZXJicmF1Y2hzYnVjaCIsCiAgInNob3J0X25hbWUiOiAiRWxkZWhvZiIsCiAgImRlc2NyaXB0aW9uIjogIlN0cm9tdmVyYnLDpHVjaGUgZG9rdW1lbnRpZXJlbiB1bmQgYXVzd2VydGVuIOKAkyBtaXQga29tcGFrdGVyIE9zdHJvbS1QcmVpc8O8YmVyc2ljaHQuIiwKICAic3RhcnRfdXJsIjogIi4vP3Y9Ni4xLjAiLAogICJzY29wZSI6ICIuLyIsCiAgImRpc3BsYXkiOiAic3RhbmRhbG9uZSIsCiAgIm9yaWVudGF0aW9uIjogInBvcnRyYWl0LXByaW1hcnkiLAogICJiYWNrZ3JvdW5kX2NvbG9yIjogIiMwNjEwMWMiLAogICJ0aGVtZV9jb2xvciI6ICIjMDcxMTFmIiwKICAiaWNvbnMiOiBbCiAgICB7InNyYyI6Imljb24tMTkyLnBuZyIsInNpemVzIjoiMTkyeDE5MiIsInR5cGUiOiJpbWFnZS9wbmciLCJwdXJwb3NlIjoiYW55IG1hc2thYmxlIn0sCiAgICB7InNyYyI6Imljb24tNTEyLnBuZyIsInNpemVzIjoiNTEyeDUxMiIsInR5cGUiOiJpbWFnZS9wbmciLCJwdXJwb3NlIjoiYW55IG1hc2thYmxlIn0KICBdCn0K","type":"application/manifest+json; charset=utf-8","cache":"no-cache"},"/icon-192.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFk0lEQVR42u3du24TQRiG4fVoBShpkKJ0hi6iTEqKKAURJbdASZcqN5AbSJWOkkuAEoUiSkFLSW/RWC6RKFxQWFrlZO96ZnbmP7xfGeWwh8ffzOx6ncnOwVFDbGU5XxT7W4HDbS/t/h6AiI4AiBICEKGBiNISAhCGAEQYwojSEgIQARCpV0IAIgAi9UoIQARApF4JAYgAiNQrIQARABEAEaWjGIAIgEi9EgIQSeOobotPLqe2T8nN+UzR1k7kPxdmXkwVTLmeHZMLaJ2b27OZYTHHV9MykiwDekzHNpqtPOWSZBPQXTpu0QyRlIVRFkNSAEEnQlIiIyOAoFOLkQVAnR7opDCKM6QbEHQkVFG6oTqA0COkitIBBfQYSHcky190Ld1Aqz2EzqhVNLyHlDUQespU0fAeSr8zH9Dj3JAOQOixaiigB0OiAaHHtqFQQA+pm81nIXEeHYq9FEitEtLaQAxeHgaygB4MKVjGE6sZBRD146eEaCAiDBD146qEaCCSdCkoMyDqx1sJ0UBEDCCT9fPp+g0lRAMl6TFmiEl0he7B0NoJeN7xy/Cwtfri59PfNvbx5HKa5fnozA1kYAK0uWwMVFHec8QQtrUPhjMApcrAEIBSTWAoJyDtV4DiNNz9qT9fD9VNg7Kse1rnL6DEIjG2NGMIK6pHaf0ASJYe5kDoScrF3xeeRQb00GoAqnaOu/pxa6iFzkh/yMnSLKAnY/04rKKAHhZ6KZ9TFtAzRv346aGAHnoIQKXP3MD68WCohQ5LMxqoqJ5t68d2FQX0sIUAKnduUurHpKGAHudbm/hh9QE9hevHWA+10GFp5reBSurJWz9mXgMBPeyLR0CFj/h49VPXUPq/e2rRUx3Zxe6/br/UzYcCeurWT6dH6VjWQqdmad3Xo3FpFtBTffaj+tUS0COqftTtdUBPlfrp1aPFUECPwO5RdAQCegrXz1Z65BtqoaNoFihwaRbQI7x+hL+uAnpkTn20HB9xQ9iQlpb8rudEPdzKIGN1D5Noy+d7Q2kZ1kMDiZ5xA4gYrx9rQ9jV2+/Dv/ns5/ux62fv9FuZbaCBSuuJ+P5t06unwDYASOvsZ4ge5kCEAIj6AZCouNIDoMz1400PgLKSsn7JB0Cjz34ARKif7cLN1HsZcmVvcf0BPTRQpJ4nJ84GLigDqJCeB/XTLbvcGgIQAVBUIu6Er6ufktsAIBEg0s/ck3oKbwOrsPqlElc/G7rHBguGsBHj8H4FgLLVD3oARABE/QCIqQ+AHNUPegBE9wCo3uyHAIj6AVDx+kEPgOgeABEAEQARAiACIAIgAiBCsgM6vppyQFVkdaZ+fPwlBdDN+azk/qv+R+vG9oshjLgEZK+ElO5R4Iivkvg4TuKP6309THYOjnL9rpPLadM0t2ezwvuQ8X+vxD3inqKnPJ2MM+jGxoOFGc/B893XjKfbDWHL+YKZIEmaAy3niyyMVot5rgZJTt7x694kmioiqaswDJHUZXzicMYo5mr8atZdB6KKSBKglCqihPzUT9N7JZoqIkmA4qqIEnJSP83we2FxVYQhOXqqNVBcFRV+hxDpzRj100TcjR/OiIHM9uAVCSiijTBkVU+T+H6gXkYMZFanPnkADWHEQGZy6pMTUC8jDJkcvFaZPHv5aozf2+7vPfhKrfcrokdHA/UWEj1kT8+IDbSukOihArPmYnrKAboraWUIRgb0NOUf61nOF90eMpxp11Ohgbq8+3JID6mmUxkQjAzoqQ/oriEYRdCpq0cEIBgppSMLEIyGuxFCRyKgx4ycY3q8UJVDRy6gdYw8YFp3aUOaGwWAeiV5iFg3mgC58iRfjHpARFT4jEQCIAIgAiACIEIARABEAEQARAiACIAIgAiACAEQARABEAEQIQAiACIAIgAibvMfGKe/xgpKwHYAAAAASUVORK5CYII=","type":"image/png","cache":"public, max-age=31536000, immutable"},"/icon-512.png":{"body":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAPpUlEQVR42u3dvW5UVxcG4OORFUWkiYToSIkooaRAFEEucwsp6VxxA9wAlTvKXEJSIlIgCtqU9CiN5TJSChcpiCw09gwz4/Oz93qfp8ynLzFnznnftc62zdGdB48HgIouzy9chC1WLgGAAgAo5fjeXRdBAQCgAABLAAoA0AEKAAAFAGAJUAAAOkABAKAAACwBCgAABQBgCVAAACgAAEuAAgDQAQoAAAUAYAlQAAAoAABLgAIAQAEAWAIUAAAKAMASoAAAUAAAlgAFAKADFAAACgAgfglQAAA2AABLgAIAQAEAoAAAqot6C6QAAGwAACQtAQoAwAYAQNISoAAAbAAAJC0BCgDABgBA0hKgAABsAAAoAACG6m+BFACADQCApCVAAQDYAABIWgIUAIANAAAFAMDXSr4FUgAANgAAFAAAa+q9BVIAADYAAJKWAAUAYAMAQAEAcKNKb4EUAEBqmbkEIZ69vu8isKP3Lz+7CAmO7jx47CrIelAMe7k8v1AAiHv0gQJQAAh9lIECUADIfZSBDlAACH00gQJQACyd+x9OneCxk6dnI99+JZtAAdBi9At6mm2FYk3QewcogAq5L/HprhJqNIECYJnoF/oUKIPea0ABMF/0C31KNkHXNdB1BygAuQ9NlEGnNaAAmCT65T5qQAEogLj0F/2EN0FfNdBvByiAhqJf7qMJeqwBBYDoh9AaUACIfpiqBhrvAAXA3ukv+qFMDXTaAQpA9IMaUABMn/6iH25fAw12gAIQ/aIfcmugxw5QAJOnv+iHhA5QANJf+sOsNdBOBygA0S/6IbQGeiyAlRtL+kP7tj9TLfzNqcf37toA0tNf9MNSq8Die0B3S4ACMPiDDlAASH/ovwMWrAEFkJj+oh+sAj12gENg6Q+92vL0tXAsrACkP6ADGuUV0IHpL/qhHe28C+rrFZACkP5QvAbm7ABnANIfWMCmZ3POd0F9/TiYApD+oANCKQDpDzpAASD9QQcoAOkv/UEHKADpL/1BB+yho3NgBSD9QQfYAKS/9IeYDkABuG8g9Fm2BCiAjfeB9AcdoACkP5CVALfXyznwymcPxC4B4TngFZDxHzzdCsD47/6AyA6IXQJCC0D6gw7QAYkF4NU/IBkGZwDGf/C8T6GLbwSKKwAvf4DBi6DAApD+gA7I3QAAiCsA4z9gCUgsAOkP6IDcDQCAuAIw/gPzLwHtfyfoyucNYAMIGv8BZlgCFIDxH5AMCsD4D8gQBbDUJ2f8BywBERsAgCUgrgCM/4AlwAYAsMwS0PiPAgQVgPEfkBX1C8A3/wBSxQZg/AckRkwBGP8B2WIDMP4DciOmAIz/gISxARj/AemRXQAA1C8A738AOWMDSNngABmiAIz/gLSxARj/gWaSpOVfB+QQmGgv3j10EYhVpAC8/+Hg9NcBxGZO2Q3A+x92n/11AJl5cuyjJTn61/7hm+efXB9yOANA+u/6v4ICaM71l3He/3BwvusAbnQ9VQocA9gAkP46ABsASH8dQJLuD4F9AygTRbljYXbJn/cvO37hXHADcADAiIO8VYDC2eIVENJfBxBKASD9dQAKoEMOAJgtr3UA9VKo2k8COwAQ/VP/yx0LJ/tw+vnpmb8QBsLS3ypAPQoA6a8DUAAg/XUACgCkvw6gvKM7Dx53+qX7HXA0EsGOhdNcPwfe/vPAl+cXNgCoOYBbBeiUAkD6z/H1/P37I58aCgBqTtz2ABQA5Obspq/N+E+b/J3AiP7xv0jHwtgAICv9b/xqjf8ogJH5NXDS39eMRLIB/M8PAUj/Br9y439JZdLGKyCkP4RSAEj/qbz653sfIi3zXUCIfrABgPSfcvzXaigAyJ39dQAKAIrn45a3/zoABQC5yagDojT7u6AHh8AIxDnH/7U/st8YgQ0A6e/PDgoACRgw/usAFADSX/a5DigApF7k+K8DWJZDYER/Q5fFsTA2AKR/0PivHVEASH9cJRQAci1y/NcBKACkP64Yc3AIjCBra/xfu3SOhbEBIP1dQ/rT8i8CUgBIrkbHfx2AAkD643qiAJBWkeO/DmA6DoERUp1dXsfC2ACQ/kHjv5ZFASD9cbVRAMijyPFfB6AAkP648q1r/IcABofACKAex/+1j8CxMDYApL/PAhQAEidg/PeJoACQNfhcUABImcjx36fDYRwCI1wKfkyOhbEBIP2Dxn+fV1Pa/x5QBYA08alhAwA5UmX899mhAJAg+ATZxiEwgqPm+L/2UToWxgaA9PeZggJAUgSM/z7ZRXTxLUAKABnh88UGANKh9PjvU+Y6h8AIhdCP27EwNgCkf9D473NHASAF8OlPpZcTYAXg+ff8h47/7gEUgPQHd0Iuh8AeeHLH/7VbwrGwDQDpj3sDBYAn3PjvDmEfHZ0AKwDPNrhPbAB4qokf/90taRwCe5hh423jWNgGgPQ3/rt/UAB4enEXsUFfJ8CDV0CeW2Yb/1teL1798O/2e8m7IBsA0p+Kzbc1/d1RCgDpb/zPTX/3VVVeAYl+2O8G8zroRt0dANgApD/Gf3daLgUg/UmtvYPS3/2mAJD+xv/c9HfXKQCkP7np796rwSGw6Df+S//b3oSOhW0ASH/cjSgAPG/G/4Dx3z2pAJD+pKe/O1MBIP2N/7np7/7skUNg0Y/0H/9GdSxsA0D6G/+z0t8dqwDwLIH7VgHgKTL+543/7l4FgOeH6PR3D7fPIbDoN/5L/zluZsfCNgCkP1np765WAHhOjP/R6e/eVgB4QnCHu8MVAJ4N43/Y+O8+b5BDYI8E0n+ZG96xsA0A6W/8z0p/d74CwDNAdPq7/1vgFdDCJt2CPV0h4//U6e9djQ0AAAUAxv+Y8R8FAEh/FAAY/6U/JTgExoDcZRVJf2wAkLiISH8UAAAKAIz/oACgcp1IfxQABI7/0h8FAGZ/UACQMf5LfxQAAAoAjP9wO34SmG87e/J2hv/K6ccTl/q6u8//cIWxAVA5/ef8D3U0/o+Y/sWuMAqAaqEsoaZLf1cYBUDrYVEgoUYZ/6dIfx2AAqD1mJBQrjAKAIz/oAAghvRHAUDi+C/9UQBg9gcFABnjv/RHAQCgAMD4DwoACpP+KABIHP+lPwoAzP6gACBj/Jf+KAAAFADEjP/+ki8UAETWhvRHAUDg+C/9UQBg9gcFADHjPygAMP6DAoCM8V/6owDA7A8KADLGf+lPs45dAoo5e/J22gJ494v0xwYAcel/sU/6z/D1gAKA4ezJ29bS9suve9MBKADo3l7j/9e/7FMHoABgwvG/wdm/5a8QFADSf/zxf9Mv+tcBKACozF/zggKAUvb95h9QAGD8BwUA1cd/6Y8CALM/KAA4yOnHk77G/+7Sv6krjAJARsTN/q4wCgAd0Pf47wqjANABidl0+5c/rjAKgPQOOP140lo2fXP8H+vVf+wVZnH+PgCMjcvM/q4wNgBo0fbx3zd9ogDA7A8KAGLGf1AAYPwHBQAZ47/0RwGA2R8UAGSM/9IfBQBmf1AAEDP+gwIA4z8oAMgY/6U/CgDM/qAAIGP8l/4oADD7gwKAmPEfFAAY/0EBQMb4L/1RAGD2BwUAGeO/9EcBgNkfFADEjP+gAMD4DwoAMsZ/6Y8CALM/KADIGP+lPygAzP6gACBm/AcUAMZ/UACQMf5Lf1AAmP1BAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAK45v3Lz2v/5OnZfR8nMIPrafPnr38pAAAUAAAKAAAFAIACAEABAKAAbsV3gq558/yTi4C7SM4ULIDrPwoAML9Ofwhg8AoIIJYCsL+D+0cBAKAAMMSBO0cBNM2vhPMk456ZU5lfA2cDAKS/DQCPdM9OP574Ot0qKAA82LhJ2NXRnQePe/8zPHu9/lbuw6mfEdvmxbuH9f5QZ0/eGv+l/6SKHQDYAEx5dbScsNIfBUBbT3u9B77NnG0//UveDOyi5iugwVugPVV6KdTOu6DGo1/o7+XGbzHv/RVQhQIYHAMAsxdA7+k/DMPq8vzCRwsQaDUMgw4ACC2AAh3gd0IA0yn5/mf4+ruA7AEAiRtAyQ6wBACSZNcC+NIBndaAvyESmEeN9z/Dph8E8zoIoLyNPwlcowO8BQJkyN4FMHT4OshbIGBqZd7/DLv8LiCvgwDjf9wGUKMDvAUCjP+HF8DQz+sgb4EARi6ArlcBSwAgN25bAF10gCUAmEKx9z/DYX8hTI8/LGYJACTGCAXQ/ipgCQCM/xMWQHergCUAkBWjFUDLq4AlADD+T14AHa0ClgBASoxcAG2uApYAwPg/UwF0sQpYAgD5MEkBtLYKWAIA4/+sBdD4KmAJACTDhAXQTg3cuAToAOCbmVB7/J+8AK5qwO0FkFgAi68ClgDA+L9YASxeA06DAem/ZAFc1UDLHzxAiNUi/9VFVgEvggDj//IFsGANAEj/5Qtg/hqwBAA0VAAz14AOAIz/bRXAVQ00dTcA0l8BlFoFfEsoSH9aLIB5asCLICB8/G+3AGaoAR0Axv/k9G+9AObZBnQASH8FEFcDmw4DdACEpH+4VV9f7ug14EAYktM/efwfhuHoux9/6verP753d5R/z7PXN9wcH051A0h/G0D1hcCBMKSR/t0XwLg1oAMgZPyX/nUKYJQacCAMIenPlb7PALY47HjgxsOAwXkAFEp/43/BDWCUhcAeANLfBhC9ENgDQPrbAEIXAnsASH8bQPRCYA+AGtEv/RXAIU2gA0D6K4DcJtjUAWoApH/vVi7BF5sOCbb8siBHAiD9bQD1dwJ7AEh/BZDbBDoAeol+6a8Axvfzb4+2/K9qAAz+CiC3BnQASH8FoAOAWaNf+iuAJjpADYD0VwA6ABD9CkANANJfAaR1gBqAKaJf+isAHQAGfxSAGgCDPwqg5Q5QAyD6FYAaUAOwa/RLfwVQrQPUAIh+BaAG1ACiX/orADUAcl/0K4DMGtAEiH7RrwDUgBogK/dFvwJQA5oA0Y8CUAOagNKhL/oVgBp4dMD/SxnQe+6LfgXArWpAGdBd6Mt9BcAkTaAPaDDuRb8CYO4aUAwsm/VyXwHQYhPAPOS+AkAZIPdRAGgChD4KAGWA0EcBoBKQ+CgAtAKCHgUAwKRWLgGAAgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgBAAQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAAoAAAUAgAIAQAEAoAAAUAAAKAAAFAAACgAABQCgAABQAAAoAAAUAAAKAAAFAIACAEABAKAAAFAAACgAABQAAEv6D8v4I+AK37xrAAAAAElFTkSuQmCC","type":"image/png","cache":"public, max-age=31536000, immutable"}};

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
