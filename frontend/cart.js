// ===================================================
// Electronics Square shopping cart
// Shared by the shop page and the product page. The cart drawer is
// built here (so its markup lives in one place) and the cart is kept in
// the browser's localStorage, so it survives moving between pages.
// ===================================================

const CART_KEY = "es_cart_v1";

document.body.insertAdjacentHTML("beforeend", `
<!-- ===== Cart Drawer ===== -->
<div class="cart-overlay" id="cartOverlay"></div>
<aside class="cart-drawer" id="cartDrawer" aria-label="Shopping cart">
  <div class="cart-header">
    <h3>Your cart</h3>
    <button class="icon-btn" id="cartClose" aria-label="Close cart">
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
  </div>
  <div class="cart-items" id="cartItems"></div>
  <div class="cart-footer">
    <fieldset class="fulfil-box" id="customerBox">
      <legend>Your details</legend>
      <input type="text" id="custName" class="cust-input" placeholder="Your name" maxlength="100" autocomplete="name">
      <input type="tel" id="custPhone" class="cust-input" placeholder="Phone / WhatsApp number" maxlength="30" autocomplete="tel">
    </fieldset>
    <fieldset class="fulfil-box" id="fulfilBox">
      <legend>How would you like to receive your order?</legend>
      <label class="fulfil-option">
        <input type="radio" name="fulfilment" value="pickup" checked>
        <span class="fulfil-label">
          <strong>Store pickup</strong>
          <small>Free collect from the store</small>
        </span>
      </label>
      <label class="fulfil-option">
        <input type="radio" name="fulfilment" value="delivery">
        <span class="fulfil-label">
          <strong>Delivery</strong>
          <small id="deliveryOptionNote">Rs 275 delivery charge</small>
        </span>
      </label>
      <textarea id="deliveryAddress" class="fulfil-address" rows="2" maxlength="300" placeholder="Delivery address (street, village/town) optional, you can also send it in the chat" hidden></textarea>
    </fieldset>
    <div class="cart-summary">
      <div class="cart-summary-row"><span>Subtotal</span><span id="cartSubtotal">Rs 0</span></div>
      <div class="cart-summary-row" id="deliveryRow" hidden><span>Delivery</span><span id="cartDelivery">Rs 275</span></div>
    </div>
    <div class="cart-total-row">
      <span>Total</span>
      <span id="cartTotal">Rs 0</span>
    </div>
    <p class="checkout-error" id="checkoutError" hidden></p>
    <button class="btn btn-whatsapp btn-block" id="checkoutBtn">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 00-8.6 15.1L2 22l5.06-1.33A10 10 0 1012 2zm0 18.2a8.16 8.16 0 01-4.16-1.14l-.3-.18-3 .79.8-2.92-.2-.3A8.2 8.2 0 1120.2 12 8.21 8.21 0 0112 20.2zm4.5-6.14c-.24-.12-1.44-.71-1.67-.79s-.38-.12-.55.12-.64.79-.78.95-.29.18-.53.06a6.7 6.7 0 01-1.97-1.22 7.4 7.4 0 01-1.36-1.7c-.14-.24 0-.37.11-.49s.24-.29.36-.43a1.6 1.6 0 00.24-.4.44.44 0 000-.42c-.06-.12-.55-1.33-.76-1.82s-.4-.42-.55-.42h-.47a.9.9 0 00-.65.3 2.75 2.75 0 00-.86 2 4.8 4.8 0 00.1 2.6 10.8 10.8 0 004.4 4.5 12.1 12.1 0 001.62.6 3.9 3.9 0 001.79.11 2.9 2.9 0 001.92-1.35 2.4 2.4 0 00.17-1.35c-.07-.12-.24-.18-.48-.3z"/></svg>
      <span id="checkoutLabel">Order via WhatsApp</span>
    </button>
    <p class="cart-note">We save your order first, then WhatsApp opens with the details filled in just hit send.</p>
  </div>
  <div class="order-done" id="orderDone"></div>
</aside>
`);

function readStoredCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || "{}");
    const clean = {};
    for (const [id, qty] of Object.entries(raw || {})) {
      const n = Math.floor(Number(qty));
      if (n > 0) clean[id] = n;
    }
    return clean;
  } catch (e) {
    return {};
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch (e) {
    /* storage unavailable (private mode) the cart just won't persist */
  }
}

const cart = readStoredCart(); // { productId: quantity }
let fulfilment = "pickup"; // "pickup" or "delivery"

const cartDrawer = document.getElementById("cartDrawer");
const cartOverlay = document.getElementById("cartOverlay");
const cartItemsEl = document.getElementById("cartItems");
const cartTotalEl = document.getElementById("cartTotal");
const cartCountEl = document.getElementById("cartCount");
const cartSubtotalEl = document.getElementById("cartSubtotal");
const cartDeliveryEl = document.getElementById("cartDelivery");
const deliveryRowEl = document.getElementById("deliveryRow");
const deliveryAddressEl = document.getElementById("deliveryAddress");
const deliveryOptionNoteEl = document.getElementById("deliveryOptionNote");
const custNameEl = document.getElementById("custName");
const custPhoneEl = document.getElementById("custPhone");
const checkoutBtn = document.getElementById("checkoutBtn");
const checkoutLabelEl = document.getElementById("checkoutLabel");
const checkoutErrorEl = document.getElementById("checkoutError");
const orderDoneEl = document.getElementById("orderDone");

// Remember the customer's name and phone on this device for next time.
const CUSTOMER_KEY = "es_customer_v1";
try {
  const saved = JSON.parse(localStorage.getItem(CUSTOMER_KEY) || "{}");
  custNameEl.value = saved.name || "";
  custPhoneEl.value = saved.phone || "";
} catch (e) {
  /* nothing saved yet */
}

function openCart() {
  cartDrawer.classList.add("is-open");
  cartOverlay.classList.add("is-open");
}
function closeCart() {
  cartDrawer.classList.remove("is-open");
  cartOverlay.classList.remove("is-open");
}

document.getElementById("cartToggle").addEventListener("click", openCart);
document.getElementById("cartClose").addEventListener("click", closeCart);
cartOverlay.addEventListener("click", closeCart);

// Adds `qty` of a product (never more than is in stock).
// Returns how many were actually added.
function addToCart(id, qty = 1) {
  const p = products.find((prod) => prod.id === id);
  if (!p || p.stock <= 0) return 0;
  const current = cart[id] || 0;
  const added = Math.max(0, Math.min(qty, p.stock - current));
  if (added === 0) return 0;
  cart[id] = current + added;
  saveCart();
  renderCart();
  openCart();
  return added;
}

function changeQty(id, delta) {
  if (!cart[id]) return;
  const p = products.find((prod) => prod.id === id);
  const next = cart[id] + delta;
  if (p && next > p.stock) return;
  cart[id] = next;
  if (cart[id] <= 0) delete cart[id];
  saveCart();
  renderCart();
}

// Drops items that were deleted or sold out since they were added.
function pruneCart() {
  if (!products.length) return;
  let changed = false;
  for (const id of Object.keys(cart)) {
    const p = products.find((prod) => prod.id === id);
    if (!p || p.stock <= 0) {
      delete cart[id];
      changed = true;
    } else if (cart[id] > p.stock) {
      cart[id] = p.stock;
      changed = true;
    }
  }
  if (changed) saveCart();
}

function renderCart() {
  // Products not loaded yet: just show the stored item count.
  if (!products.length) {
    cartCountEl.textContent = Object.values(cart).reduce((a, b) => a + b, 0);
    return;
  }
  pruneCart();

  const entries = Object.entries(cart);
  let total = 0;
  let count = 0;

  if (entries.length === 0) {
    cartItemsEl.innerHTML = `<p class="cart-empty">Your cart is empty add something from the shop.</p>`;
  } else {
    cartItemsEl.innerHTML = entries
      .map(([id, qty]) => {
        const p = products.find((prod) => prod.id === id);
        if (!p) return "";
        const lineTotal = unitPrice(p) * qty;
        total += lineTotal;
        count += qty;
        return `
        <div class="cart-item">
          <a class="cart-item-icon" href="${productUrl(p.id)}" aria-label="View ${escapeHtml(p.name)}">${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}">` : escapeHtml(p.icon)}</a>
          <div class="cart-item-info">
            <div class="cart-item-name">${escapeHtml(p.name)}</div>
            <div class="cart-item-price">${formatPrice(unitPrice(p))} each${p.on_sale ? " (sale)" : ""}</div>
          </div>
          <div class="cart-qty">
            <button data-qty-minus="${escapeHtml(id)}" aria-label="Decrease quantity">−</button>
            <span>${qty}</span>
            <button data-qty-plus="${escapeHtml(id)}" aria-label="Increase quantity">+</button>
          </div>
        </div>
      `;
      })
      .join("");
  }

  if (count > 0) cartDrawer.classList.remove("is-done"); // shopping again after an order

  // Delivery charge only applies when delivery is chosen AND the cart has items.
  const deliveryCharge = fulfilment === "delivery" && count > 0 ? DELIVERY_FEE : 0;

  cartSubtotalEl.textContent = formatPrice(total);
  deliveryRowEl.hidden = fulfilment !== "delivery";
  cartDeliveryEl.textContent = formatPrice(deliveryCharge);
  deliveryAddressEl.hidden = fulfilment !== "delivery";
  deliveryOptionNoteEl.textContent = `${formatPrice(DELIVERY_FEE)} delivery charge`;
  cartTotalEl.textContent = formatPrice(total + deliveryCharge);
  cartCountEl.textContent = count;
}

// Pickup / delivery choice
document.querySelectorAll('input[name="fulfilment"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    fulfilment = radio.value;
    renderCart();
  });
});

// "+" buttons on product cards and the +/- buttons inside the cart
document.addEventListener("click", (e) => {
  const addId = e.target.closest("[data-add]")?.dataset.add;
  if (addId) addToCart(addId);

  const plusId = e.target.closest("[data-qty-plus]")?.dataset.qtyPlus;
  if (plusId) changeQty(plusId, 1);

  const minusId = e.target.closest("[data-qty-minus]")?.dataset.qtyMinus;
  if (minusId) changeQty(minusId, -1);
});

function showCheckoutError(text, fieldToFocus) {
  checkoutErrorEl.textContent = text;
  checkoutErrorEl.hidden = false;
  if (fieldToFocus) fieldToFocus.focus();
}

// The WhatsApp message is built from the order the server recorded, so it
// always matches what is in the shop's orders list.
function buildWhatsAppText(order) {
  const delivery = order.fulfilment === "delivery";
  let m = `Hi Electronics Square! I'd like to place order ${order.number}:\n\n`;
  order.items.forEach((it) => {
    m += `• ${it.name} x${it.qty}: ${formatPrice(it.line_total)}\n`;
  });
  m += `\nSubtotal: ${formatPrice(order.subtotal)}`;
  if (delivery) m += `\nDelivery charge: ${formatPrice(order.delivery_fee)}`;
  m += `\nTotal: ${formatPrice(order.total)}`;
  m += `\n\nReceive order by: ${delivery ? "Delivery" : "Store pickup"}`;
  if (delivery) m += `\nAddress: ${order.address || "(I will send my address in this chat)"}`;
  m += `\n\nName: ${order.customer_name}\nPhone: ${order.customer_phone}`;
  return m;
}

function showOrderDone(order, waUrl) {
  const delivery = order.fulfilment === "delivery";
  orderDoneEl.innerHTML = `
    <div class="order-done-icon">✓</div>
    <h3>Order ${escapeHtml(order.number)} received</h3>
    <p class="order-done-total">${formatPrice(order.total)} · ${delivery ? "Delivery" : "Store pickup"}</p>
    <p class="order-done-note">One last step: send your order to us on WhatsApp so we can confirm it.</p>
    <a class="btn btn-whatsapp btn-block" href="${escapeHtml(waUrl)}" target="_blank" rel="noopener">Open WhatsApp</a>
    <button type="button" class="btn btn-ghost btn-block" id="orderDoneClose">Continue shopping</button>
  `;
  cartDrawer.classList.add("is-done");
  document.getElementById("orderDoneClose").addEventListener("click", () => {
    cartDrawer.classList.remove("is-done");
    closeCart();
  });
}

checkoutBtn.addEventListener("click", async () => {
  const entries = Object.entries(cart);
  if (entries.length === 0) return;
  checkoutErrorEl.hidden = true;

  const name = custNameEl.value.trim();
  const phone = custPhoneEl.value.trim();
  if (name.length < 2) return showCheckoutError("Please enter your name.", custNameEl);
  if (phone.replace(/\D/g, "").length < 7) {
    return showCheckoutError("Please enter a phone number we can reach you on.", custPhoneEl);
  }
  try {
    localStorage.setItem(CUSTOMER_KEY, JSON.stringify({ name, phone }));
  } catch (e) {
    /* private mode fine */
  }

  checkoutBtn.disabled = true;
  checkoutLabelEl.textContent = "Placing your order…";
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        phone,
        fulfilment,
        address: deliveryAddressEl.value.trim(),
        items: entries.map(([id, qty]) => ({ id, qty })),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showCheckoutError(data.error || "Something went wrong. Please try again.");
      if (data.refresh) {
        // Stock or products changed: reload them and fix the cart.
        await loadCatalog();
        renderCart();
        document.dispatchEvent(new Event("catalog:refreshed"));
      }
      return;
    }

    const waUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(buildWhatsAppText(data))}`;
    for (const id of Object.keys(cart)) delete cart[id];
    saveCart();
    renderCart();
    showOrderDone(data, waUrl);
    window.open(waUrl, "_blank"); // some browsers block this; the "Open WhatsApp" button always works
  } catch (err) {
    showCheckoutError("Could not reach the shop. Check your connection and try again.");
  } finally {
    checkoutBtn.disabled = false;
    checkoutLabelEl.textContent = "Order via WhatsApp";
  }
});

// Keep the cart in sync if it changes in another browser tab.
window.addEventListener("storage", (e) => {
  if (e.key !== CART_KEY) return;
  for (const id of Object.keys(cart)) delete cart[id];
  Object.assign(cart, readStoredCart());
  renderCart();
});

renderCart();
