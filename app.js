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
let joinCode = "";
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
// Household persistence
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

  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: uid, current_household_id: null }, { onConflict: "user_id" });

  if (error) throw new Error(error.message);

  householdId = "";
  joinCode = "";
  isOwner = false;
  await stopRealtime();
}

// ---------------------------
// Role + Join code
// ---------------------------
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
// Base UI
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

// ---------------------------
// Auth
// ---------------------------
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
  await stopRealtime();
  householdId = "";
  joinCode = "";
  isOwner = false;
  await supabase.auth.signOut();
  await setAuthedUI();
});

// ---------------------------
// Household create/join
// ---------------------------
$("createHousehold").addEventListener("click", async () => {
  const name = $("householdName").value.trim();
  if (!name) return;

  const { data, error } = await supabase.rpc("create_household", { p_name: name });
  if (error) return alert(error.message);

  await setCurrentHousehold(data);
  await refreshAll();
});

$("joinHousehold").addEventListener("click", async () => {
  const code = $("joinCode").value.trim();
  if (!code) return;

  const { data, error } = await supabase.rpc("join_household", { p_join_code: code });
  if (error) return alert(error.message);

  await setCurrentHousehold(data);
  await refreshAll();
});

$("forgetHousehold").addEventListener("click", async () => {
  try {
    await forgetCurrentHousehold();
    await setAuthedUI();
  } catch (e) {
    alert(e?.message ?? String(e));
  }
});

// ---------------------------
// Owner panel, set member role
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

$("setRoleBtn").addEventListener("click", async () => {
  try {
    setText("ownerMsg", "");
    if (!householdId) return alert("No household set.");
    if (!isOwner) return alert("Owner only.");

    const userId = $("memberSelect").value;
    const role = $("roleSelect").value;

    const { error } = await supabase.rpc("set_member_role", {
      p_household_id: householdId,
      p_user_id: userId,
      p_role: role,
    });

    if (error) return alert(error.message);

    setText("ownerMsg", "Role updated.");
    await refreshAll();
  } catch (e) {
    alert(e?.message ?? String(e));
  }
});

// ---------------------------
// Grocery (unchanged)
-- SNIP: keep your existing grocery + purchasing + stickers code here if it already works --
-- To keep this response focused, I’m providing the minimal safe additions above. --

/*
IMPORTANT:
To avoid overwriting your working PR/PO + stickers code, do this:
1) Paste the "Household persistence", "Role + Join code", "Household create/join", and "Owner panel" sections into your current app.js.
2) Then update refreshAll() below.
If you want, reply "overwrite fully" and I’ll paste a full app.js including grocery + purchasing + stickers in one file.
*/

// ---------------------------
// Tabs
// ---------------------------
$("tabGrocery").addEventListener("click", () => setTab("grocery"));
$("tabPurchasing").addEventListener("click", () => setTab("purchasing"));

// ---------------------------
// Realtime placeholders (keep your existing ones if present)
async function stopRealtime() {
  if (groceryChannel) await supabase.removeChannel(groceryChannel);
  if (prChannel) await supabase.removeChannel(prChannel);
  if (ledgerChannel) await supabase.removeChannel(ledgerChannel);
  groceryChannel = null;
  prChannel = null;
  ledgerChannel = null;
}

// ---------------------------
// Refresh bootstrap
async function refreshAll() {
  await loadCurrentHouseholdFromSettings();
  await refreshRoleAndJoinCode();
  await setAuthedUI();

  if (householdId) {
    setTab("grocery");
    if (isOwner) await loadMembersForOwnerPanel();
    // Call your existing loaders here:
    // await loadItems();
    // await loadPRs();
    // await loadMyAllowance();
    // await loadLedgerRecent();
    // if (isOwner) await loadMembersIntoSelect(), await loadStickersIntoSelect();
    // await startRealtime();
  }
}

supabase.auth.onAuthStateChange(async () => {
  await refreshAll();
});

await refreshAll();
