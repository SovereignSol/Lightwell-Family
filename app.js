import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://kejsrvqvmgahttmrqgfh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8Z8ElJBdfA3PWCiyleODYw_0CaFRRw6";

const VAPID_PUBLIC_KEY =
  "BNpaIsk86xSDCMq92NP2yhlKNcCOSKVUjyuFvsQaebJe3efOxR2AMXBvTZpDzAa4hE5QVaVYFNpubh7Sh4iFvY4";

const STICKER_BUCKET = "stickers";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => Number(n || 0).toLocaleString(undefined, { style: "currency", currency: "USD" });

let householdId = "";
let isOwner = false;

let groceryChannel = null;
let prChannel = null;
let ledgerChannel = null;

function show(el, yes) {
  el.classList.toggle("hidden", !yes);
}
function setText(id, v) {
  const el = $(id);
  if (el) el.textContent = v ?? "";
}
function setTab(tab) {
  show($("grocery"), tab === "grocery");
  show($("purchasing"), tab === "purchasing");
}
function parseNum(v) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? n : 0;
}
function clampInt(v, min, max, fallback) {
  const n = parseInt(String(v || "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function getUid() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

// ---------------------------
// AUTH + BASE UI
// ---------------------------
async function setAuthedUI() {
  const { data } = await supabase.auth.getSession();
  const authed = !!data.session?.user;

  show($("auth"), !authed);
  show($("app"), authed);

  if (!authed) return;

  setText("householdId", householdId || "(not set)");
  setText("roleText", isOwner ? "owner" : "member");
  show($("awardBox"), !!householdId && isOwner);
}

$("signIn").addEventListener("click", async () => {
  setText("authMsg", "");
  const email = $("email").value.trim();
  const password = $("password").value;

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) setText("authMsg", error.message);

  await refreshAll();
});

$("signUp").addEventListener("click", async () => {
  setText("authMsg", "");
  const email = $("email").value.trim();
  const password = $("password").value;

  const { error } = await supabase.auth.signUp({ email, password });
  if (error) setText("authMsg", error.message);
  else setText("authMsg", "Account created. If confirmations are enabled, check email.");
});

$("signOut").addEventListener("click", async () => {
  householdId = "";
  isOwner = false;
  await stopRealtime();
  await supabase.auth.signOut();
  await setAuthedUI();
});

// ---------------------------
// HOUSEHOLD RPC
// ---------------------------
$("createHousehold").addEventListener("click", async () => {
  const name = $("householdName").value.trim();
  if (!name) return;

  const { data, error } = await supabase.rpc("create_household", { p_name: name });
  if (error) return alert(error.message);

  householdId = data;
  await refreshAll();
});

$("joinHousehold").addEventListener("click", async () => {
  const code = $("joinCode").value.trim();
  if (!code) return;

  const { data, error } = await supabase.rpc("join_household", { p_join_code: code });
  if (error) return alert(error.message);

  householdId = data;
  await refreshAll();
});

async function refreshRole() {
  isOwner = false;
  if (!householdId) return;

  const uid = await getUid();
  if (!uid) return;

  const { data, error } = await supabase.from("households").select("id, created_by").eq("id", householdId).maybeSingle();
  if (error) return;

  isOwner = data?.created_by === uid;
}

// ---------------------------
// GROCERY (unchanged)
// ---------------------------
function renderItems(items) {
  const itemsEl = $("items");
  itemsEl.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = it.checked;
    cb.addEventListener("change", async () => {
      const { error } = await supabase.from("grocery_items").update({ checked: !it.checked }).eq("id", it.id);
      if (error) alert(error.message);
    });

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = it.name;
    if (it.checked) name.style.textDecoration = "line-through";

    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      const { error } = await supabase.from("grocery_items").delete().eq("id", it.id);
      if (error) alert(error.message);
    });

    li.appendChild(cb);
    li.appendChild(name);
    li.appendChild(del);
    itemsEl.appendChild(li);
  }
}

async function loadItems() {
  if (!householdId) return;

  const { data, error } = await supabase
    .from("grocery_items")
    .select("id, name, checked, sort_order, updated_at")
    .eq("household_id", householdId)
    .order("checked", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("updated_at", { ascending: false });

  if (error) return alert(error.message);
  renderItems(data ?? []);
}

$("addItem").addEventListener("click", async () => {
  const name = $("newItem").value.trim();
  if (!name || !householdId) return;

  const { data: maxRow } = await supabase
    .from("grocery_items")
    .select("sort_order")
    .eq("household_id", householdId)
    .order("sort_order", { ascending: false })
    .limit(1);

  const nextSort = (maxRow?.[0]?.sort_order ?? 0) + 1;

  const { error } = await supabase.from("grocery_items").insert({
    household_id: householdId,
    name,
    sort_order: nextSort,
  });

  if (error) alert(error.message);
  $("newItem").value = "";
});

// ---------------------------
// PURCHASING + STICKERS
// ---------------------------
function prStatusLabel(s) {
  return s === "requested" ? "Requested" : s === "approved" ? "Approved" : s === "denied" ? "Denied" : "Wishlist";
}

async function loadMembersIntoSelect() {
  const sel = $("awardUserSelect");
  sel.innerHTML = "";

  if (!householdId) return;

  const { data, error } = await supabase
    .from("household_members")
    .select("user_id, role, created_at")
    .eq("household_id", householdId)
    .order("created_at", { ascending: true });

  if (error) return;

  for (const m of data ?? []) {
    const opt = document.createElement("option");
    opt.value = m.user_id;
    opt.textContent = `${m.user_id.slice(0, 8)}… (${m.role})`;
    sel.appendChild(opt);
  }
}

function getPublicStickerUrl(path) {
  if (!path) return null;
  const { data } = supabase.storage.from(STICKER_BUCKET).getPublicUrl(path);
  return data?.publicUrl ?? null;
}

async function loadStickersIntoSelect() {
  const sel = $("stickerSelect");
  sel.innerHTML = "";

  const { data, error } = await supabase.from("stickers").select("id, label, emoji, image_path").order("label");
  if (error) return alert(error.message);

  for (const s of data ?? []) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.emoji || "⭐"} ${s.label}`;
    sel.appendChild(opt);
  }
}

function renderPRs(list) {
  const ul = $("prList");
  ul.innerHTML = "";

  for (const r of list) {
    const li = document.createElement("li");

    const total = Number(r.cost || 0) + Number(r.shipping_cost || 0);
    const left = document.createElement("div");
    left.className = "name";

    const parts = [];
    parts.push(`${r.title} (${prStatusLabel(r.status)})`);
    parts.push(`Total: ${fmtMoney(total)}`);
    parts.push(`Priority: ${r.priority}/10`);
    if (r.sale_end_date) parts.push(`Sale: ${r.sale_end_date}`);
    if (r.link) parts.push(`Link: ${r.link}`);
    if (r.notes) parts.push(`Notes: ${r.notes}`);

    left.textContent = parts.join(" | ");

    const actions = document.createElement("div");
    actions.className = "row";

    const mk = (label, disabled, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener("click", fn);
      return b;
    };

    const approve = mk("Approve", !isOwner || r.status === "approved", async () => {
      const uid = await getUid();
      const { error } = await supabase.from("purchase_requests").update({ status: "approved", approved_by: uid }).eq("id", r.id);
      if (error) alert(error.message);
    });

    const deny = mk("Deny", !isOwner || r.status === "denied", async () => {
      const uid = await getUid();
      const { error } = await supabase.from("purchase_requests").update({ status: "denied", approved_by: uid }).eq("id", r.id);
      if (error) alert(error.message);
    });

    const wish = mk("Wishlist", !isOwner || r.status === "wishlist", async () => {
      const uid = await getUid();
      const { error } = await supabase.from("purchase_requests").update({ status: "wishlist", approved_by: uid }).eq("id", r.id);
      if (error) alert(error.message);
    });

    const del = mk("Delete", false, async () => {
      const { error } = await supabase.from("purchase_requests").delete().eq("id", r.id);
      if (error) alert(error.message);
    });

    actions.appendChild(approve);
    actions.appendChild(deny);
    actions.appendChild(wish);
    actions.appendChild(del);

    li.appendChild(left);
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

async function loadPRs() {
  if (!householdId) return;

  const { data, error } = await supabase
    .from("purchase_requests")
    .select("id, household_id, title, link, cost, shipping_cost, sale_end_date, priority, notes, status, requested_by, approved_by, created_at, updated_at")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false });

  if (error) return alert(error.message);
  renderPRs(data ?? []);
}

async function loadMyAllowance() {
  if (!householdId) return;
  const uid = await getUid();
  if (!uid) return;

  const { data, error } = await supabase
    .from("allowance_ledger")
    .select("amount")
    .eq("household_id", householdId)
    .eq("user_id", uid);

  if (error) return alert(error.message);

  const sum = (data ?? []).reduce((acc, row) => acc + Number(row.amount || 0), 0);
  setText("myAllowance", fmtMoney(sum));
}

function renderLedger(rows) {
  const ul = $("ledgerList");
  ul.innerHTML = "";

  for (const r of rows) {
    const li = document.createElement("li");
    const amt = Number(r.amount || 0);
    const stickerLabel = r.stickers ? `${r.stickers.emoji || "⭐"} ${r.stickers.label}` : "";
    const msg = r.reason || "";

    li.textContent = `${r.created_at.slice(0, 19).replace("T", " ")} | ${amt >= 0 ? "+" : ""}${fmtMoney(amt)} | ${stickerLabel} | ${msg}`;

    // Show sticker image if present (bucket is assumed public)
    const url = r.stickers?.image_path ? getPublicStickerUrl(r.stickers.image_path) : null;
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "sticker";
      img.style.width = "44px";
      img.style.height = "44px";
      img.style.objectFit = "cover";
      img.style.borderRadius = "10px";
      img.style.marginLeft = "10px";
      li.appendChild(img);
    }

    ul.appendChild(li);
  }
}

async function loadLedgerRecent() {
  if (!householdId) return;

  const { data, error } = await supabase
    .from("allowance_ledger")
    .select("id, created_at, amount, reason, sticker_id, stickers(emoji,label,image_path)")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return alert(error.message);
  renderLedger(data ?? []);
}

$("prSubmit").addEventListener("click", async () => {
  setText("prMsg", "");
  if (!householdId) return alert("Create or join a household first.");

  const title = $("prTitle").value.trim();
  if (!title) return alert("Title is required.");

  const link = $("prLink").value.trim() || null;
  const cost = parseNum($("prCost").value);
  const ship = parseNum($("prShip").value);
  const saleEnd = $("prSaleEnd").value.trim() || null;
  const priority = clampInt($("prPriority").value, 1, 10, 5);
  const notes = $("prNotes").value.trim() || null;

  const uid = await getUid();
  if (!uid) return alert("Not signed in.");

  const { error } = await supabase.from("purchase_requests").insert({
    household_id: householdId,
    title,
    link,
    cost,
    shipping_cost: ship,
    sale_end_date: saleEnd,
    priority,
    notes,
    requested_by: uid,
    status: "requested",
  });

  if (error) return alert(error.message);

  $("prTitle").value = "";
  $("prLink").value = "";
  $("prCost").value = "";
  $("prShip").value = "";
  $("prSaleEnd").value = "";
  $("prPriority").value = "";
  $("prNotes").value = "";

  setText("prMsg", "Request submitted.");
});

$("refreshPR").addEventListener("click", async () => {
  await loadPRs();
  await loadMyAllowance();
  await loadLedgerRecent();
});

$("stickerManageToggle").addEventListener("click", () => {
  show($("stickerManager"), $("stickerManager").classList.contains("hidden"));
});

$("createSticker").addEventListener("click", async () => {
  setText("stickerMgrMsg", "");
  const label = $("newStickerLabel").value.trim();
  const emoji = $("newStickerEmoji").value.trim() || "⭐";
  if (!label) return alert("Enter a sticker label.");

  const code = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40) || `CUSTOM_${Date.now()}`;

  const { error } = await supabase.from("stickers").insert({ code, label, emoji });
  if (error) return alert(error.message);

  $("newStickerLabel").value = "";
  $("newStickerEmoji").value = "";
  setText("stickerMgrMsg", "Sticker created.");
  await loadStickersIntoSelect();
});

$("uploadStickerPhoto").addEventListener("click", async () => {
  setText("stickerMgrMsg", "");

  const stickerId = $("stickerSelect").value;
  if (!stickerId) return alert("Select a sticker first.");

  const file = $("stickerPhoto").files?.[0];
  if (!file) return alert("Choose an image file first.");

  // Use a stable path per sticker so replacing is easy
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `stickers/${stickerId}.${ext}`;

  // Upload (overwrite true)
  const { error: upErr } = await supabase.storage.from(STICKER_BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type || "image/png",
    cacheControl: "3600",
  });
  if (upErr) return alert(upErr.message);

  // Save path in DB so UI can show it
  const { error: dbErr } = await supabase.from("stickers").update({ image_path: path }).eq("id", stickerId);
  if (dbErr) return alert(dbErr.message);

  setText("stickerMgrMsg", "Photo uploaded and saved.");
  await loadLedgerRecent();
});

$("awardSubmit").addEventListener("click", async () => {
  setText("awardMsg", "");
  if (!householdId) return alert("Create or join a household first.");
  if (!isOwner) return alert("Owner only.");

  const userId = $("awardUserSelect").value;
  const amount = parseNum($("awardAmount").value);
  const stickerId = $("stickerSelect").value || null;

  const message = $("awardMessage").value.trim();
  if (!message) return alert("Message is required (your own words).");
  if (!userId) return alert("Pick a user.");
  if (!Number.isFinite(amount) || amount === 0) return alert("Amount must be non-zero.");

  const uid = await getUid();
  if (!uid) return alert("Not signed in.");

  const { error } = await supabase.from("allowance_ledger").insert({
    household_id: householdId,
    user_id: userId,
    amount,
    reason: message,          // ✅ always your own message
    sticker_id: stickerId,
    created_by: uid,
  });

  if (error) return alert(error.message);

  $("awardAmount").value = "";
  $("awardMessage").value = "";
  setText("awardMsg", "Awarded.");
});

// ---------------------------
// REALTIME
// ---------------------------
async function stopRealtime() {
  if (groceryChannel) await supabase.removeChannel(groceryChannel);
  if (prChannel) await supabase.removeChannel(prChannel);
  if (ledgerChannel) await supabase.removeChannel(ledgerChannel);

  groceryChannel = null;
  prChannel = null;
  ledgerChannel = null;
}

async function startRealtime() {
  await stopRealtime();
  if (!householdId) return;

  groceryChannel = supabase
    .channel(`grocery-${householdId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "grocery_items", filter: `household_id=eq.${householdId}` },
      async () => await loadItems()
    )
    .subscribe();

  prChannel = supabase
    .channel(`pr-${householdId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "purchase_requests", filter: `household_id=eq.${householdId}` },
      async () => {
        await loadPRs();
        await loadMyAllowance();
      }
    )
    .subscribe();

  ledgerChannel = supabase
    .channel(`ledger-${householdId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "allowance_ledger", filter: `household_id=eq.${householdId}` },
      async () => {
        await loadMyAllowance();
        await loadLedgerRecent();
      }
    )
    .subscribe();
}

// ---------------------------
// PUSH REGISTRATION (device subscribe only)
// ---------------------------
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function ensureServiceWorkerReady() {
  const reg = await navigator.serviceWorker.register("./sw.js");
  await navigator.serviceWorker.ready;
  return reg;
}

async function enablePushForHousehold(hhId) {
  setText("pushStatus", "");

  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push is not supported in this browser.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications permission not granted.");

  const reg = await ensureServiceWorkerReady();

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const uid = await getUid();
  if (!uid) throw new Error("Not signed in.");

  const json = sub.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;

  if (!endpoint || !p256dh || !auth) throw new Error("Subscription keys missing.");

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      household_id: hhId,
      user_id: uid,
      endpoint,
      p256dh,
      auth,
      user_agent: navigator.userAgent,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id,endpoint" }
  );

  if (error) throw new Error(error.message);

  setText("pushStatus", "Push enabled on this device.");
}

$("enablePush").addEventListener("click", async () => {
  try {
    if (!householdId) return alert("Join or create a household first.");
    await enablePushForHousehold(householdId);
  } catch (e) {
    alert(e?.message ?? String(e));
  }
});

// Service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      // ignore
    }
  });
}

// Tabs
$("tabGrocery").addEventListener("click", () => setTab("grocery"));
$("tabPurchasing").addEventListener("click", () => setTab("purchasing"));

// Main refresh
async function refreshAll() {
  await refreshRole();
  await setAuthedUI();

  if (householdId) {
    setTab("grocery");

    await loadItems();
    await loadPRs();
    await loadMyAllowance();
    await loadLedgerRecent();

    if (isOwner) {
      await loadMembersIntoSelect();
      await loadStickersIntoSelect();
    }

    await startRealtime();
  }
}

supabase.auth.onAuthStateChange(async () => {
  await refreshAll();
});

// Initial
await refreshAll();
