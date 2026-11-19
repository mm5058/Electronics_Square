// Electronics Square shared code
// Loaded by BOTH the shop page (index.html) and the product page
// (product.html): data loading, price formatting and the product card.


let categories = [];
let products = [];
let WHATSAPP_NUMBER = "23052530649"; // fallback the real value comes from Store settings
let CURRENCY_SYMBOL = "Rs";
let DELIVERY_FEE = 275; // fallback the real value comes from Store settings

function formatPrice(n) {
  return `${CURRENCY_SYMBOL} ${Math.round(n).toLocaleString("en-US")}`;
}

// The price a customer pays right now (the sale price while a sale is on).
function unitPrice(p) {
  return p.current_price ?? p.price;
}

// Price for cards: the current price, with the regular price crossed out during a sale.
function priceHTML(p) {
  return p.on_sale
    ? `<span class="price-now">${formatPrice(p.current_price)}</span> <s class="price-was">${formatPrice(p.price)}</s>`
    : `<span class="price-now">${formatPrice(p.price)}</span>`;
}

// Makes text safe to put inside HTML (stops "<" or quotes in a product name
// from breaking the page).
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Fetches categories, products and settings. Returns true on success.
async function loadCatalog() {
  try {
    const [catRes, prodRes, settingsRes] = await Promise.all([
      fetch("/api/categories"),
      fetch("/api/products"),
      fetch("/api/settings"),
    ]);
    categories = await catRes.json();
    products = await prodRes.json();
    const settings = await settingsRes.json();
    if (settings.whatsapp_number) WHATSAPP_NUMBER = settings.whatsapp_number;
    if (settings.currency_symbol) CURRENCY_SYMBOL = settings.currency_symbol;
    if (settings.delivery_fee !== undefined && !isNaN(Number(settings.delivery_fee))) {
      DELIVERY_FEE = Number(settings.delivery_fee);
    }
    return true;
  } catch (err) {
    console.error("Could not reach the backend API. Is app.py running?", err);
    return false;
  }
}

function categoryName(slug) {
  const c = categories.find((cat) => cat.slug === slug);
  return c ? c.name : String(slug).replace("-", " ");
}

function productUrl(id) {
  return `/product/${encodeURIComponent(id)}`;
}

// One product card (used on the shop page and under "You may also like").
function productCardHTML(p) {
  const outOfStock = p.stock <= 0;
  const lowStock = !outOfStock && p.stock <= 3;
  const url = productUrl(p.id);
  return `
    <article class="product-card ${outOfStock ? "is-out" : ""}" data-id="${escapeHtml(p.id)}">
      <a class="product-media" href="${url}" aria-label="View ${escapeHtml(p.name)}">
        ${p.badge && !outOfStock ? `<span class="product-badge">${escapeHtml(p.badge)}</span>` : ""}
        ${outOfStock ? `<span class="product-badge product-badge-out">Out of stock</span>` : ""}
        ${p.on_sale && !outOfStock ? `<span class="product-badge product-badge-sale">−${p.discount_percent}%</span>` : ""}
        ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" class="product-img" loading="lazy">` : `<span>${escapeHtml(p.icon)}</span>`}
      </a>
      <div class="product-body">
        <span class="product-cat">${escapeHtml(categoryName(p.cat))}</span>
        <h3 class="product-name"><a href="${url}">${escapeHtml(p.name)}</a></h3>
        <p class="product-desc">${escapeHtml(p.desc || "")}</p>
        ${lowStock ? `<p class="stock-note">Only ${p.stock} left</p>` : ""}
        <div class="product-footer">
          <span class="product-price">${priceHTML(p)}</span>
          <button class="add-btn" data-add="${escapeHtml(p.id)}" ${outOfStock ? "disabled" : ""} aria-label="Add ${escapeHtml(p.name)} to cart">+</button>
        </div>
      </div>
    </article>
  `;
}

// Clicking anywhere on a card (except its buttons/links) opens the product page.
document.addEventListener("click", (e) => {
  const card = e.target.closest(".product-card[data-id]");
  if (!card || e.target.closest("a, button")) return;
  window.location.href = productUrl(card.dataset.id);
});
