// Electronics Square product page (product.html)
// URL looks like /product/<product-id>. Loads that product (photo
// gallery, price, stock, description, specifications) plus the catalog
// (for the cart and the "You may also like" row).

const root = document.getElementById("productRoot");
document.getElementById("year").textContent = new Date().getFullYear();

const productId = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");

let product = null;
let photos = []; // array of image URLs
let photoIndex = 0;
let qty = 1;

async function init() {
  const [, res] = await Promise.all([loadCatalog(), fetch(`/api/products/${encodeURIComponent(productId)}`)]);
  if (!res.ok) {
    renderNotFound();
    return;
  }
  product = await res.json();
  photos = (product.images || []).map((i) => i.url);
  render();
  renderCart();
}

function renderNotFound() {
  root.innerHTML = `
    <div class="pd-missing">
      <h1>We couldn't find that product</h1>
      <p>It may have been removed or the link may be wrong.</p>
      <a class="btn btn-primary" href="/#shop">Back to the shop</a>
    </div>`;
}

// "2026-12-31" -> "31 December"
function formatSaleDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

// ---- Text helpers ----
function paragraphsHTML(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function specsHTML(text) {
  const rows = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(":");
      if (i === -1) return `<tr><td colspan="2">${escapeHtml(line)}</td></tr>`;
      return `<tr><th>${escapeHtml(line.slice(0, i).trim())}</th><td>${escapeHtml(line.slice(i + 1).trim())}</td></tr>`;
    });
  return rows.length ? `<table class="pd-specs"><tbody>${rows.join("")}</tbody></table>` : "";
}

// ---- Page ----
function render() {
  const p = product;
  const out = p.stock <= 0;
  const low = !out && p.stock <= 3;
  const stockText = out ? "Out of stock" : low ? `Only ${p.stock} left` : "In stock";
  const stockClass = out ? "out" : low ? "low" : "in";
  const waText = encodeURIComponent(
    `Hi Electronics Square! I have a question about "${p.name}" (${location.origin}${productUrl(p.id)})`
  );

  const aboutHTML = paragraphsHTML(p.details) || "";
  const specs = specsHTML(p.specs);

  const related = products
    .filter((x) => x.cat === p.cat && x.id !== p.id)
    .sort((a, b) => (b.stock > 0) - (a.stock > 0))
    .slice(0, 4);

  document.title = `${p.name} Electronics Square`;

  root.innerHTML = `
    <nav class="pd-crumbs" aria-label="Breadcrumb">
      <a href="/">Home</a><span>/</span>
      <a href="/#shop">Shop</a><span>/</span>
      <span>${escapeHtml(categoryName(p.cat))}</span><span>/</span>
      <span class="pd-crumb-current">${escapeHtml(p.name)}</span>
    </nav>

    <div class="pd-grid">
      <div class="pd-gallery">
        <div class="pd-main" id="pdMain">
          ${
            photos.length
              ? `<img id="pdMainImg" src="${escapeHtml(photos[0])}" alt="${escapeHtml(p.name)}">`
              : `<span class="pd-placeholder">${escapeHtml(p.icon)}</span>`
          }
          ${
            photos.length > 1
              ? `<button class="pd-arrow pd-prev" id="pdPrev" aria-label="Previous photo">‹</button>
                 <button class="pd-arrow pd-next" id="pdNext" aria-label="Next photo">›</button>
                 <span class="pd-counter" id="pdCounter"></span>`
              : ""
          }
        </div>
        ${
          photos.length > 1
            ? `<div class="pd-thumbs" id="pdThumbs">
                ${photos
                  .map(
                    (url, i) =>
                      `<button class="pd-thumb" data-i="${i}" aria-label="Show photo ${i + 1}"><img src="${escapeHtml(url)}" alt="" loading="lazy"></button>`
                  )
                  .join("")}
              </div>`
            : ""
        }
      </div>

      <div class="pd-info">
        <span class="product-cat">${escapeHtml(categoryName(p.cat))}</span>
        <h1 class="pd-title">${escapeHtml(p.name)}</h1>
        ${p.badge && !out ? `<span class="pd-badge">${escapeHtml(p.badge)}</span>` : ""}
        <div class="pd-price">
          <span class="pd-price-now">${formatPrice(p.current_price)}</span>
          ${p.on_sale ? `<s class="pd-price-was">${formatPrice(p.price)}</s><span class="pd-save">Save ${formatPrice(p.price - p.current_price)} (${p.discount_percent}%)</span>` : ""}
        </div>
        ${p.on_sale && p.sale_ends ? `<p class="pd-sale-ends">Sale ends ${escapeHtml(formatSaleDate(p.sale_ends))}</p>` : ""}
        <div class="pd-stock ${stockClass}"><span class="pd-dot"></span>${stockText}</div>
        ${p.desc ? `<p class="pd-short">${escapeHtml(p.desc)}</p>` : ""}

        ${
          out
            ? `<button class="btn btn-primary pd-add" disabled>Out of stock</button>`
            : `<div class="pd-buy">
                 <div class="pd-qty" aria-label="Quantity">
                   <button id="qMinus" aria-label="Decrease quantity">−</button>
                   <span id="qVal">1</span>
                   <button id="qPlus" aria-label="Increase quantity">+</button>
                 </div>
                 <button class="btn btn-primary pd-add" id="addBtn">Add to cart</button>
               </div>`
        }
        <p class="pd-msg" id="pdMsg" hidden></p>

        <a class="btn btn-whatsapp-outline" target="_blank" rel="noopener" href="https://wa.me/${WHATSAPP_NUMBER}?text=${waText}">
          Ask about this product on WhatsApp
        </a>

        <ul class="pd-perks">
          <li><strong>Store pickup</strong> free</li>
          <li><strong>Delivery</strong> ${formatPrice(DELIVERY_FEE)} per order</li>
        </ul>
      </div>
    </div>

    ${aboutHTML ? `<section class="pd-section"><h2>About this product</h2><div class="pd-prose">${aboutHTML}</div></section>` : ""}
    ${specs ? `<section class="pd-section"><h2>Specifications</h2>${specs}</section>` : ""}
    ${
      related.length
        ? `<section class="pd-section"><h2>You may also like</h2><div class="product-grid">${related.map(productCardHTML).join("")}</div></section>`
        : ""
    }
  `;

  wireGallery();
  wireBuyBox();
  showPhoto(0);
}

// ---- Gallery ----
function showPhoto(i) {
  if (!photos.length) return;
  photoIndex = (i + photos.length) % photos.length;
  const img = document.getElementById("pdMainImg");
  img.src = photos[photoIndex];
  const counter = document.getElementById("pdCounter");
  if (counter) counter.textContent = `${photoIndex + 1} / ${photos.length}`;
  document.querySelectorAll(".pd-thumb").forEach((t, n) => t.classList.toggle("is-active", n === photoIndex));
  const active = document.querySelector(".pd-thumb.is-active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
}

function wireGallery() {
  const main = document.getElementById("pdMain");
  document.getElementById("pdPrev")?.addEventListener("click", (e) => { e.stopPropagation(); showPhoto(photoIndex - 1); });
  document.getElementById("pdNext")?.addEventListener("click", (e) => { e.stopPropagation(); showPhoto(photoIndex + 1); });
  document.querySelectorAll(".pd-thumb").forEach((t) => t.addEventListener("click", () => showPhoto(Number(t.dataset.i))));

  // Swipe on phones
  let startX = null;
  main.addEventListener("touchstart", (e) => { startX = e.touches[0].clientX; }, { passive: true });
  main.addEventListener("touchend", (e) => {
    if (startX === null || photos.length < 2) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) showPhoto(photoIndex + (dx < 0 ? 1 : -1));
    startX = null;
  });

  // Click the main photo to view it full screen
  main.addEventListener("click", (e) => {
    if (photos.length && !e.target.closest(".pd-arrow")) openLightbox();
  });
}

// ---- Full-screen viewer ----
const lightbox = document.getElementById("lightbox");
const lbImg = document.getElementById("lbImg");
const lbCount = document.getElementById("lbCount");

function lbShow() {
  lbImg.src = photos[photoIndex];
  lbCount.textContent = photos.length > 1 ? `${photoIndex + 1} / ${photos.length}` : "";
  document.getElementById("lbPrev").hidden = document.getElementById("lbNext").hidden = photos.length < 2;
}
function openLightbox() {
  lightbox.hidden = false;
  document.body.style.overflow = "hidden";
  lbShow();
}
function closeLightbox() {
  lightbox.hidden = true;
  document.body.style.overflow = "";
}
function lbStep(d) {
  showPhoto(photoIndex + d);
  lbShow();
}
document.getElementById("lbClose").addEventListener("click", closeLightbox);
document.getElementById("lbPrev").addEventListener("click", () => lbStep(-1));
document.getElementById("lbNext").addEventListener("click", () => lbStep(1));
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !lightbox.hidden) closeLightbox();
  if (photos.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const step = e.key === "ArrowLeft" ? -1 : 1;
    lightbox.hidden ? showPhoto(photoIndex + step) : lbStep(step);
  }
});

// ---- Quantity + add to cart ----
function wireBuyBox() {
  const addBtn = document.getElementById("addBtn");
  if (!addBtn) return;
  const qVal = document.getElementById("qVal");
  const msg = document.getElementById("pdMsg");

  function setQty(n) {
    qty = Math.min(Math.max(1, n), product.stock);
    qVal.textContent = qty;
  }
  qty = 1;
  document.getElementById("qMinus").addEventListener("click", () => setQty(qty - 1));
  document.getElementById("qPlus").addEventListener("click", () => setQty(qty + 1));

  addBtn.addEventListener("click", () => {
    const added = addToCart(product.id, qty);
    msg.hidden = false;
    msg.classList.toggle("is-warn", added < qty);
    if (added === 0) {
      msg.textContent = `You already have all ${product.stock} available in your cart.`;
    } else if (added < qty) {
      msg.textContent = `Only ${added} more ${added === 1 ? "was" : "were"} available, so ${added} ${added === 1 ? "was" : "were"} added.`;
    } else {
      msg.textContent = `Added ${added} to your cart.`;
    }
  });
}

init();
