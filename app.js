import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Sol: Full app.js rewrite (no "snips")
 * Includes:
 * - Auth (email/password)
 * - Household create/join + persistence via user_settings.current_household_id
 * - Join code display when locked-in
 * - "Forget household" to switch (does not delete anything)
 * - Owner role based on household_members.role = 'owner'
 * - Owner panel to promote/demote member roles (RPC set_member_role)
 * - Grocery list (live)
 * - Purchase Requests (live), approvals (owner-only), wishlist/deny
 * - Allowance ledger balance (live)
 * - Stickerbook awards (owner-only) with custom message required
 * - Sticker manager: create sticker + upload sticker photo to Storage bucket "stickers"
 * - Push subscribe registration (stores subscription in push_subscriptions)
 *
 * Assumptions (DB already set up):
 * - Tables: households, household_members, user_settings, grocery_items,
 *           purchase_requests, allowance_ledger, stickers, push_subscriptions
 * - RPCs: create_household(p_name), join_household(p_join_code),
 *         set_current_household(p_household_id), set_member_role(p_household_id,p_user_id,p_role)
 * - Helpers: is_household_member(uuid), is_household_owner(uuid) for RLS (security definer, row_security=off)
 * - Storage bucket: stickers (public recommended)
 */

const SUPABASE_URL = "https://kejsrvqvmgahttmrqgfh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8Z8ElJBdfA3PWCiyleODYw_0CaFRRw6";

const VAPID_PUBLIC_KEY =
  "BNpaIsk86xSDCMq92NP2yhlKNcCOSKVUjyuFvsQaebJe3efOxR2AMXBvTZpDzAa4hE5QVaVYFNpubh7Sh4iFvY4";

const STICKER_BUCKET = "stickers";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => Number(n || 0).toLocaleString(undefined, { style: "currency", currency: "USD" });

let householdId = "";
let joinCode = "";
let isOwner = false;

let groceryChannel = null;
let prChannel = null;
let ledgerChannel = null;
let memberChannel = null;
let stickerChannel = null;

// ---------------------------
// Small helpers
// ---------------------------
function show(el, yes) {
  if (!el) return;
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
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(String(v ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function getUid() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

function getPublicStickerUrl(path) {
  if (!path) return null;
  const { data } = supabase.storage.from(STICKER_BUCKET).getPublicUrl(path);
  return data?.publicUrl ?? null;
}

// ---------------------------
// Auth UI handlers
// ---------------------------
async function setAuthedUI() {
  const { data } = await supabase.auth.getSession();
  const authed = !!data.session?.user;

  show($("auth"), !authed);
  show($("app"), authed);

  if (!authed) return;

  const locked = !!householdId;

  setText("householdId", locked ? householdId : "(not set)");
  setText("joinCodeDisplay", locked ? joinCode || "-" : "-");
  setText("roleText", locked ? (isOwner ? "owner" : "member") : "member");

  show($("householdSetup"), !locked);
  show($("householdLocked"), locked);

  show($("ownerPanel"), locked && isOwner);
  show($("awardBox"), locked && isOwner);
}

async function signIn() {
  setText("authMsg", "");
  const email = $("email")?.value?.trim() ?? "";
  const password = $("password")?.value ?? "";

  if (!email || !password) {
    setText("authMsg", "Enter email and password.");
    return;
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    setText("authMsg", error.message);
    return;
  }

  await refreshAll();
}

async function signUp() {
  setText("authMsg", "");
  const email = $("email")?.value?.trim() ?? "";
  const password = $("password")?.value ?? "";

  if (!email || !password) {
    setText("authMsg", "Enter email and password.");
    return;
  }

  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    setText("authMsg", error.message);
    return;
  }

  setText("authMsg", "Account created. If confirmations are enabled, check email.");
}

async function signOut() {
  await stopRealtime();
  householdId = "";
  joinCode = "";
  isOwner = false;

  await supabase.auth.signOut();
  await setAuthedUI();
}

// ---------------------------
// Household persistence (user_settings)
// ---------------------------
async function loadCurrentHouseholdFromSettings() {
  const uid = await getUid();
  if (!uid) return;

  const { data, error } = await supabase
    .from("user_settings")
    .select("current_household_id")
    .eq("user_id", uid)
    .maybeSingle();

  if (error) return;

  householdId = data?.current_household_id || "";
}

async function setCurrentHousehold(id) {
  if (!id) return;
  const { error } = await supabase.rpc("set_current_household", { p_household_id: id });
  if (error) throw new Error(error.message);

  householdId = id;
}

async function forgetCurrentHousehold() {
  const uid = await getUid();
  if (!uid) return;

  // Clear pointer
  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: uid, current_household_id: null }, { onConflict: "user_id" });

  if (error) throw new Error(error.message);

  await stopRealtime();
  householdId = "";
  joinCode = "";
  isOwner = false;

  await setAuthedUI();
}

// ---------------------------
// Household create/join
// ---------------------------
async function createHousehold() {
  const name = $("householdName")?.value?.trim() ?? "";
  if (!name) return alert("Enter a household name.");

  const { data, error } = await supabase.rpc("create_household", { p_name: name });
  if (error) return alert(error.message);

  await setCurrentHousehold(data);
  await refreshAll();
}

async function joinHousehold() {
  const code = $("joinCode")?.value?.trim() ?? "";
  if (!code) return alert("Enter the join code.");

  const { data, error } = await supabase.rpc("join_household", { p_join_code: code });
  if (error) return alert(error.message);

  await setCurrentHousehold(data);
  await refreshAll();
}

async function refreshRoleAndJoinCode() {
  isOwner = false;
  joinCode = "";
  if (!householdId) return;

  const uid = await getUid();
  if (!uid) return;

  const { data: m, error: mErr } = await supabase
    .from("household_members")
    .select("role")
    .eq("household_id", householdId)
    .eq("user_id", uid)
    .maybeSingle();

  if (!mErr) isOwner = m?.role === "owner";

  const { data: h, error: hErr } = await supabase
    .from("households")
    .select("join_code")
    .eq("id", householdId)
    .maybeSingle();

  if (!hErr) joinCode = h?.join_code || "";
}

// ---------------------------
// Owner panel: promote/demote member roles
// ---------------------------
async function loadMembersForOwnerPanel() {
  const sel = $("memberSelect");
  if (!sel) return;

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

async function setMemberRole() {
  setText("ownerMsg", "");
  if (!householdId) return alert("No household set.");
  if (!isOwner) return alert("Owner only.");

  const userId = $("memberSelect")?.value ?? "";
  const role = $("roleSelect")?.value ?? "member";
  if (!userId) return alert("Select a member.");

  const { error } = await supabase.rpc("set_member_role", {
    p_household_id: householdId,
    p_user_id: userId,
    p_role: role,
  });

  if (error) return alert(error.message);

  setText("ownerMsg", "Role updated.");
  await refreshAll();
}

// ---------------------------
// Grocery (live)
// ---------------------------
function renderItems(items) {
  const itemsEl = $("items");
  if (!itemsEl) return;

  itemsEl.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!it.checked;
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

async function addItem() {
  const name = $("newItem")?.value?.trim() ?? "";
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
  if ($("newItem")) $("newItem").value = "";
}

// ---------------------------
// Purchasing + Allowance + Stickers
// ---------------------------
function prStatusLabel(s) {
  return s === "requested" ? "Requested" : s === "approved" ? "Approved" : s === "denied" ? "Denied" : "Wishlist";
}

async function loadMembersIntoAwardSelect() {
  const sel = $("awardUserSelect");
  if (!sel) return;
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

async function loadStickersIntoSelect() {
  const sel = $("stickerSelect");
  if (!sel) return;
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
  if (!ul) return;
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
    .select(
      "id, household_id, title, link, cost, shipping_cost, sale_end_date, priority, notes, status, requested_by, approved_by, created_at, updated_at"
    )
    .eq("household_id", householdId)
    .order("created_at", { ascending: false });

  if (error) return alert(error.message);
  renderPRs(data ?? []);
}

async function submitPR() {
  setText("prMsg", "");
  if (!householdId) return alert("Create or join a household first.");

  const title = $("prTitle")?.value?.trim() ?? "";
  if (!title) return alert("Title is required.");

  const link = $("prLink")?.value?.trim() || null;
  const cost = parseNum($("prCost")?.value);
  const ship = parseNum($("prShip")?.value);
  const saleEnd = $("prSaleEnd")?.value?.trim() || null;
  const priority = clampInt($("prPriority")?.value, 1, 10, 5);
  const notes = $("prNotes")?.value?.trim() || null;

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

  if ($("prTitle")) $("prTitle").value = "";
  if ($("prLink")) $("prLink").value = "";
  if ($("prCost")) $("prCost").value = "";
  if ($("prShip")) $("prShip").value = "";
  if ($("prSaleEnd")) $("prSaleEnd").value = "";
  if ($("prPriority")) $("prPriority").value = "";
  if ($("prNotes")) $("prNotes").value = "";

  setText("prMsg", "Request submitted.");
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
  if (!ul) return;
  ul.innerHTML = "";

  for (const r of rows) {
    const li = document.createElement("li");
    const amt = Number(r.amount || 0);
    const stickerLabel = r.stickers ? `${r.stickers.emoji || "⭐"} ${r.stickers.label}` : "";
    const msg = r.reason || "";

    li.textContent = `${r.created_at.slice(0, 19).replace("T", " ")} | ${amt >= 0 ? "+" : ""}${fmtMoney(amt)} | ${stickerLabel} | ${msg}`;

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

async function awardAllowanceWithSticker() {
  setText("awardMsg", "");
  if (!householdId) return alert("No household set.");
  if (!isOwner) return alert("Owner only.");

  const userId = $("awardUserSelect")?.value ?? "";
  const amount = parseNum($("awardAmount")?.value);
  const stickerId = $("stickerSelect")?.value || null;
  const message = $("awardMessage")?.value?.trim() ?? "";

  if (!userId) return alert("Pick a user.");
  if (!Number.isFinite(amount) || amount === 0) return alert("Amount must be non-zero.");
  if (!message) return alert("Message is required (your own words).");

  const uid = await getUid();
  if (!uid) return alert("Not signed in.");

  const { error } = await supabase.from("allowance_ledger").insert({
    household_id: householdId,
    user_id: userId,
    amount,
    reason: message,
    sticker_id: stickerId,
    created_by: uid,
  });

  if (error) return alert(error.message);

  if ($("awardAmount")) $("awardAmount").value = "";
  if ($("awardMessage")) $("awardMessage").value = "";

  setText("awardMsg", "Awarded.");
}

// Sticker manager
async function toggleStickerManager() {
  const mgr = $("stickerManager");
  if (!mgr) return;
  show(mgr, mgr.classList.contains("hidden"));
}

async function createSticker() {
  setText("stickerMgrMsg", "");
  if (!isOwner) return alert("Owner only.");

  const label = $("newStickerLabel")?.value?.trim() ?? "";
  const emoji = $("newStickerEmoji")?.value?.trim() || "⭐";
  if (!label) return alert("Enter a sticker label.");

  const code = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40) || `CUSTOM_${Date.now()}`;

  const { error } = await supabase.from("stickers").insert({ code, label, emoji });
  if (error) return alert(error.message);

  if ($("newStickerLabel")) $("newStickerLabel").value = "";
  if ($("newStickerEmoji")) $("newStickerEmoji").value = "";

  setText("stickerMgrMsg", "Sticker created.");
  await loadStickersIntoSelect();
}

async function uploadStickerPhoto() {
  setText("stickerMgrMsg", "");
  if (!isOwner) return alert("Owner only.");

  const stickerId = $("stickerSelect")?.value ?? "";
  if (!stickerId) return alert("Select a sticker first.");

  const file = $("stickerPhoto")?.files?.[0];
  if (!file) return alert("Choose an image file first.");

  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `stickers/${stickerId}.${ext}`;

  const { error: upErr } = await supabase.storage.from(STICKER_BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type || "image/png",
    cacheControl: "3600",
  });
  if (upErr) return alert(upErr.message);

  const { error: dbErr } = await supabase.from("stickers").update({ image_path: path }).eq("id", stickerId);
  if (dbErr) return alert(dbErr.message);

  setText("stickerMgrMsg", "Photo uploaded and saved.");
  await loadLedgerRecent();
}

// ---------------------------
// Push subscribe (registration only)
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

async function enablePushForHousehold() {
  setText("pushStatus", "");
  if (!householdId) return alert("Join or create a household first.");

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
      household_id: householdId,
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

// ---------------------------
// Realtime
// ---------------------------
async function stopRealtime() {
  const chans = [groceryChannel, prChannel, ledgerChannel, memberChannel, stickerChannel].filter(Boolean);
  for (const ch of chans) {
    try {
      await supabase.removeChannel(ch);
    } catch {
      // ignore
    }
  }
  groceryChannel = null;
  prChannel = null;
  ledgerChannel = null;
  memberChannel = null;
  stickerChannel = null;
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

  // If membership changes, refresh role/owner and selectors
  memberChannel = supabase
    .channel(`members-${householdId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "household_members", filter: `household_id=eq.${householdId}` },
      async () => {
        await refreshRoleAndJoinCode();
        await setAuthedUI();
        if (isOwner) {
          await loadMembersForOwnerPanel();
          await loadMembersIntoAwardSelect();
          await loadStickersIntoSelect();
        }
      }
    )
    .subscribe();

  stickerChannel = supabase
    .channel(`stickers`)
    .on("postgres_changes", { event: "*", schema: "public", table: "stickers" }, async () => {
      if (isOwner) await loadStickersIntoSelect();
      await loadLedgerRecent();
    })
    .subscribe();
}

// ---------------------------
// Refresh boot
// ---------------------------
async function refreshAll() {
  // Load household pointer
  await loadCurrentHouseholdFromSettings();

  // Load role + join code (if household set)
  await refreshRoleAndJoinCode();

  // Update UI
  await setAuthedUI();

  if (!householdId) return;

  // Default to grocery tab
  setTab("grocery");

  // Load data
  await loadItems();
  await loadPRs();
  await loadMyAllowance();
  await loadLedgerRecent();

  // Owner-only panels
  if (isOwner) {
    await loadMembersForOwnerPanel();
    await loadMembersIntoAwardSelect();
    await loadStickersIntoSelect();
  }

  // Start live updates
  await startRealtime();
}

// ---------------------------
// Wire events
// ---------------------------
$("signIn")?.addEventListener("click", () => void signIn());
$("signUp")?.addEventListener("click", () => void signUp());
$("signOut")?.addEventListener("click", () => void signOut());

$("createHousehold")?.addEventListener("click", () => void createHousehold());
$("joinHousehold")?.addEventListener("click", () => void joinHousehold());
$("forgetHousehold")?.addEventListener("click", () => void forgetCurrentHousehold());

$("setRoleBtn")?.addEventListener("click", () => void setMemberRole());

$("addItem")?.addEventListener("click", () => void addItem());

$("prSubmit")?.addEventListener("click", () => void submitPR());
$("refreshPR")?.addEventListener("click", async () => {
  await loadPRs();
  await loadMyAllowance();
  await loadLedgerRecent();
});

$("awardSubmit")?.addEventListener("click", () => void awardAllowanceWithSticker());
$("stickerManageToggle")?.addEventListener("click", () => void toggleStickerManager());
$("createSticker")?.addEventListener("click", () => void createSticker());
$("uploadStickerPhoto")?.addEventListener("click", () => void uploadStickerPhoto());

$("enablePush")?.addEventListener("click", async () => {
  try {
    await enablePushForHousehold();
  } catch (e) {
    alert(e?.message ?? String(e));
  }
});

$("tabGrocery")?.addEventListener("click", () => setTab("grocery"));
$("tabPurchasing")?.addEventListener("click", () => setTab("purchasing"));

// Service worker registration (for push)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      // ignore
    }
  });
}

// React to auth changes
supabase.auth.onAuthStateChange(async () => {
  await refreshAll();
});

// Initial load
await refreshAll();
