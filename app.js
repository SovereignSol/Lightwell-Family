import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://kejsrvqvmgahttmrqgfh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8Z8ElJBdfA3PWCiyleODYw_0CaFRRw6";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// UI helpers
const $ = (id) => document.getElementById(id);
const authSection = $("auth");
const householdSection = $("household");
const grocerySection = $("grocery");
const authMsg = $("authMsg");
const itemsEl = $("items");

let householdId = "";
let groceryChannel = null;

function show(el, yes) {
  el.classList.toggle("hidden", !yes);
}

function renderItems(items) {
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

async function startRealtime() {
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
  show(authSection, !isAuthed);
  show(householdSection, isAuthed);
  show(grocerySection, isAuthed && !!householdId);

  $("householdId").textContent = householdId || "(not set)";
}

// Auth handlers
$("signIn").addEventListener("click", async () => {
  authMsg.textContent = "";
  const email = $("email").value.trim();
  const password = $("password").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) authMsg.textContent = error.message;
  await setAuthedUI();
});

$("signUp").addEventListener("click", async () => {
  authMsg.textContent = "";
  const email = $("email").value.trim();
  const password = $("password").value;
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) authMsg.textContent = error.message;
  else authMsg.textContent = "Account created. Check email if confirmations are enabled.";
});

$("signOut").addEventListener("click", async () => {
  householdId = "";
  await supabase.auth.signOut();
  await setAuthedUI();
});

// Household RPC (these require you created create_household/join_household earlier)
$("createHousehold").addEventListener("click", async () => {
  const name = $("householdName").value.trim();
  if (!name) return;
  const { data, error } = await supabase.rpc("create_household", { p_name: name });
  if (error) return alert(error.message);
  householdId = data;
  await setAuthedUI();
  await loadItems();
  await startRealtime();
});

$("joinHousehold").addEventListener("click", async () => {
  const code = $("joinCode").value.trim();
  if (!code) return;
  const { data, error } = await supabase.rpc("join_household", { p_join_code: code });
  if (error) return alert(error.message);
  householdId = data;
  await setAuthedUI();
  await loadItems();
  await startRealtime();
});

// Grocery add
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
    sort_order: nextSort
  });

  if (error) alert(error.message);
  $("newItem").value = "";
});

// Register service worker (PWA)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    await navigator.serviceWorker.register("./sw.js");
  });
}

// Keep UI synced with auth
supabase.auth.onAuthStateChange(async () => {
  await setAuthedUI();
});

// Initial
await setAuthedUI();
