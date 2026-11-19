// Electronics Square shop page (index.html)
// Shared helpers live in common.js, the cart in cart.js.
// Categories and products are fetched from the Flask API on load.


const categoryGrid = document.getElementById("categoryGrid");
const productGrid = document.getElementById("productGrid");
const emptyState = document.getElementById("emptyState");
const filterChips = document.getElementById("filterChips");
const searchInput = document.getElementById("searchInput");
const searchToggle = document.getElementById("searchToggle");
const searchBar = document.getElementById("searchBar");

let activeFilter = "all";
let activeQuery = "";

async function loadStorefront() {
  await loadCatalog();
  renderCategoryGrid();
  renderFilterChips();
  renderProducts();
  renderCart();
}

// ---- Categories (dynamic) ----
const CATEGORY_ICONS = {
  drones: "🛸",
  gaming: "🎮",
  audio: "🎧",
  "smart-home": "💡",
};

function renderCategoryGrid() {
  categoryGrid.innerHTML = categories
    .map(
      (c) => `
    <button class="category-card" data-filter="${escapeHtml(c.slug)}">
      <span class="category-icon">${CATEGORY_ICONS[c.slug] || "🔌"}</span>
      <span class="category-name">${escapeHtml(c.name)}</span>
    </button>
  `
    )
    .join("");

  categoryGrid.querySelectorAll(".category-card").forEach((card) => {
    card.addEventListener("click", () => setFilter(card.dataset.filter));
  });
}

function renderFilterChips() {
  // The "On sale" filter disappears when nothing is on sale any more.
  if (activeFilter === "__sale" && !products.some((p) => p.on_sale)) activeFilter = "all";
  filterChips.innerHTML =
    `<button class="chip ${activeFilter === "all" ? "is-active" : ""}" data-filter="all">All</button>` +
    (products.some((p) => p.on_sale)
      ? `<button class="chip chip-sale ${activeFilter === "__sale" ? "is-active" : ""}" data-filter="__sale">On sale</button>`
      : "") +
    categories
      .map(
        (c) =>
          `<button class="chip ${activeFilter === c.slug ? "is-active" : ""}" data-filter="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</button>`
      )
      .join("");

  filterChips.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => setFilter(chip.dataset.filter));
  });
}

function setFilter(filter) {
  activeFilter = filter;
  filterChips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-active", c.dataset.filter === filter));
  renderProducts();
  document.getElementById("shop").scrollIntoView({ behavior: "smooth" });
}

// ---- Products ----
function renderProducts() {
  const filtered = products.filter((p) => {
    const matchesFilter =
      activeFilter === "all" || (activeFilter === "__sale" ? p.on_sale : p.cat === activeFilter);
    const q = activeQuery;
    const matchesQuery =
      !q || p.name.toLowerCase().includes(q) || (p.desc || "").toLowerCase().includes(q);
    return matchesFilter && matchesQuery;
  });

  productGrid.innerHTML = filtered.map(productCardHTML).join("");
  emptyState.hidden = filtered.length !== 0;
}

// ---- Search ----
searchToggle.addEventListener("click", () => {
  const isOpen = searchBar.classList.toggle("is-open");
  searchToggle.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) searchInput.focus();
});

searchInput.addEventListener("input", (e) => {
  activeQuery = e.target.value.trim().toLowerCase();
  renderProducts();
});

// ---- Contact details (edit them in contact-info.js) ----
(function applyContactInfo() {
  if (typeof CONTACT_INFO === "undefined") return;
  const { email, phone, hours } = CONTACT_INFO;
  const emailEl = document.getElementById("contactEmail");
  const phoneEl = document.getElementById("contactPhone");
  const hoursEl = document.getElementById("contactHours");
  if (emailEl && email) {
    emailEl.textContent = email;
    emailEl.href = `mailto:${email}`;
  }
  if (phoneEl && phone) {
    phoneEl.textContent = phone;
    phoneEl.href = `tel:${phone.replace(/[^\d+]/g, "")}`;
  }
  if (hoursEl && hours) hoursEl.textContent = hours;
})();

// ---- Contact form: messages arrive in the admin panel's Messages inbox ----
document.getElementById("contactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const note = document.getElementById("formNote");
  const button = form.querySelector("button[type=submit]");
  const data = Object.fromEntries(new FormData(form).entries());

  button.disabled = true;
  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    note.hidden = false;
    note.classList.toggle("is-error", !res.ok);
    note.textContent = res.ok
      ? "Thanks we've got your message and will get back to you soon."
      : result.error || "Sorry, your message couldn't be sent. Please try again.";
    if (res.ok) form.reset();
  } catch (err) {
    note.hidden = false;
    note.classList.add("is-error");
    note.textContent = "Could not reach the shop. Check your connection and try again.";
  } finally {
    button.disabled = false;
  }
});

// The cart refreshed the catalog (e.g. an item sold out): redraw the shop.
document.addEventListener("catalog:refreshed", () => {
  renderFilterChips();
  renderProducts();
});

// ---- Footer year ----
document.getElementById("year").textContent = new Date().getFullYear();

// ---- Init ----
loadStorefront();

// Lightweight polling so changes made in the admin panel (on this device
// or another one) show up here without a manual refresh.
setInterval(async () => {
  try {
    const [prodRes, catRes] = await Promise.all([fetch("/api/products"), fetch("/api/categories")]);
    products = await prodRes.json();
    categories = await catRes.json();
    renderCategoryGrid();
    renderFilterChips();
    renderProducts();
    renderCart();
  } catch (err) {
    // Silent the next poll will retry.
  }
}, 15000);
