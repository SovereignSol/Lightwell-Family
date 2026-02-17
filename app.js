import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Supabase (browser-safe)
 */
const SUPABASE_URL = "https://kejsrvqvmgahttmrqgfh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8Z8ElJBdfA3PWCiyleODYw_0CaFRRw6";

/**
 * Web Push (VAPID)
 */
const VAPID_PUBLIC_KEY =
  "BNpaIsk86xSDCMq92NP2yhlKNcCOSKVUjyuFvsQaebJe3efOxR2AMXBvTZpDzAa4hE5QVaVYFNpubh7Sh4iFvY4";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// UI helpers
const $ = (id) => document.getElementById(id);

function safeText(id, text) {
  const el = $(id);
  if (el) el.textContent = text ?? "";
}

function show(id, yes) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("hidden", !yes);
}

let householdId = "";
let groceryChannel = null;

async function apiKeySanityCheck() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_ANON_KEY },
    });

    const body = await res.text();
    console.log("API key check status:", res.status);
    if (!res.ok) {
      safeText("authMsg", `API key check failed: ${res.status} ${body}`);
      return;
    }
    safeText("authMsg", "API key check: OK (auth endpoint reachable).");
  } catch (e) {
    safeText("authMsg", `API key check error: ${e?.message ?? String(e)}`);
  }
}

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

  if (error) {
    alert(error.message);
    return;
  }

  renderItems(data ?? []);
}

async function startRealtime() {
  if (!householdId) return;

  if (groceryChannel) {
    await supabase.removeChannel(groceryChannel);
    groceryChannel = null;
  }

  groceryChannel = supabase
    .channel(`grocery-${householdId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "grocery_items", filter: `household_id=eq.${householdId}` },
      async () => {
        await loadItems();
      }
    )
    .subscribe();
}

async function setAuthedUI() {
  const { data } = await supabase.auth.getSession();
  const isAuthed = !!data.session?.user;

  show("auth", !isAuthed);
  show("household", isAuthed);
  show("grocery", isAuthed && !!householdId);

  safeText("householdId", householdId || "(not set)");
  console.log("setAuthedUI isAuthed:", isAuthed);
}

async function signIn() {
  safeText("authMsg", "");
  const email = $("email")?.value?.trim() ?? "";
  const password = $("password")?.value ?? "";

  if (!email || !password) {
    safeText("authMsg", "Enter email and password.");
    return;
  }

  console.log("Attempting sign in...");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    console.error("Sign in error:", error);
    safeText("authMsg", `Sign in failed: ${error.message}`);
    alert(error.message);
    return;
  }

  console.log("Sign in success:", data?.session?.user?.id);
  safeText("authMsg", "Signed in.");
  await setAuthedUI();
}

async function signUp() {
  safeText("authMsg", "");
  const email = $("email")?.value?.trim() ?? "";
  const password = $("password")?.value ?? "";

  if (!email || !password) {
    safeText("authMsg", "Enter email and password.");
    return;
  }

  console.log("Attempting sign up...");
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    console.error("Sign up error:", error);
    safeText("authMsg", `Sign up failed: ${error.message}`);
    alert(error.message);
    return;
  }

  console.log("Sign up response:", data);
  safeText("authMsg", "Sign up submitted. If email confirmation is on, check your inbox.");
}

async function signOut() {
  householdId = "";
  if (groceryChannel) {
    await supabase.removeChannel(groceryChannel);
    groceryChannel = null;
  }
  await supabase.auth.signOut();
  await setAuthedUI();
}

async function createHousehold() {
  const name = $("householdName")?.value?.trim() ?? "";
  if (!name) return alert("Enter a household name.");

  const { data, error } = await supabase.rpc("create_household", { p_name: name });
  if (error) {
    alert(error.message);
    return;
  }

  householdId = data;
  await setAuthedUI();
  await loadItems();
  await startRealtime();
}

async function joinHousehold() {
  const code = $("joinCode")?.value?.trim() ?? "";
  if (!code) return alert("Enter the join code.");

  const { data, error } = await supabase.rpc("join_household", { p_join_code: code });
  if (error) {
    alert(error.message);
    return;
  }

  householdId = data;
  await setAuthedUI();
  await loadItems();
  await startRealtime();
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
  $("newItem").value = "";
}

// Push subscription helpers (kept, but not required for sign-in debugging)
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
  safeText("pushStatus", "");

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

  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) throw new Error("Not signed in.");

  const json = sub.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;

  if (!endpoint || !p256dh || !auth) throw new Error("Subscription keys missing.");

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      household_id: hhId,
      user_id: userId,
      endpoint,
      p256dh,
      auth,
      user_agent: navigator.userAgent,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id,endpoint" }
  );

  if (error) throw new Error(error.message);

  safeText("pushStatus", "Push enabled on this device.");
}

// Wire buttons
$("signIn")?.addEventListener("click", () => void signIn());
$("signUp")?.addEventListener("click", () => void signUp());
$("signOut")?.addEventListener("click", () => void signOut());
$("createHousehold")?.addEventListener("click", () => void createHousehold());
$("joinHousehold")?.addEventListener("click", () => void joinHousehold());
$("addItem")?.addEventListener("click", () => void addItem());

$("enablePush")?.addEventListener("click", async () => {
  try {
    if (!householdId) return alert("Join or create a household first.");
    await enablePushForHousehold(householdId);
  } catch (e) {
    alert(e?.message ?? String(e));
  }
});

// Service worker registration (PWA + push)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      // ignore
    }
  });
}

// Listen for auth changes
supabase.auth.onAuthStateChange((event, session) => {
  console.log("Auth state change:", event, session?.user?.id ?? null);
  void setAuthedUI();
});

// Initial checks
await apiKeySanityCheck();
await setAuthedUI();
