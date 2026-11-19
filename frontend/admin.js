// Electronics Square  admin panel logic
// Runs inside index.html as an overlay. All actions go through the
// Flask backend's API and require a signed-in session (see app.py).


const adminOverlay = document.getElementById("adminOverlay");
const adminGate = document.getElementById("adminGate");
const adminPanel = document.getElementById("adminPanel");
const gateForm = document.getElementById("gateForm");
const gateError = document.getElementById("gateError");
const gateUsername = document.getElementById("gateUsername");
const gatePassword = document.getElementById("gatePassword");

let adminCategories = [];
let adminProducts = [];

// ---- Open / close overlay ----
async function openAdminOverlay() {
  adminOverlay.hidden = false;
  document.body.style.overflow = "hidden";
  const res = await fetch("/api/session");
  const data = await res.json();
  if (data.logged_in) {
    showPanel(data.username);
  } else {
    showGate();
  }
}

function closeAdminOverlay() {
  adminOverlay.hidden = true;
  document.body.style.overflow = "";
}

function showGate() {
  adminGate.hidden = false;
  adminPanel.hidden = true;
  gateUsername.value = "";
  gatePassword.value = "";
  gateError.hidden = true;
  setTimeout(() => gateUsername.focus(), 50);
}

async function showPanel(username) {
  adminGate.hidden = true;
  adminPanel.hidden = false;
  document.getElementById("adminUserLabel").textContent = username ? `Signed in as ${username}` : "";
  await refreshCategories();
  await refreshProducts();
  await loadSettingsIntoForm();
  await Promise.all([refreshOrders(), refreshMessages(), refreshBackups()]);
}

document.getElementById("adminTrigger").addEventListener("click", (e) => {
  e.preventDefault();
  openAdminOverlay();
});
document.getElementById("adminHeaderTrigger").addEventListener("click", () => {
  openAdminOverlay();
});
document.getElementById("gateCloseBtn").addEventListener("click", closeAdminOverlay);
document.getElementById("adminCloseBtn").addEventListener("click", closeAdminOverlay);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || adminOverlay.hidden) return;
  if (!editModal.hidden) closeEditModal();
  else closeAdminOverlay();
});

gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  gateError.hidden = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: gateUsername.value.trim(), password: gatePassword.value }),
    });
    const data = await res.json();
    if (res.ok) {
      showPanel(data.username);
    } else {
      gateError.textContent = data.error || "Sign-in failed.";
      gateError.hidden = false;
    }
  } catch (err) {
    gateError.textContent = "Could not reach the backend. Is app.py running?";
    gateError.hidden = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  closeAdminOverlay();
});

document.getElementById("changePasswordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = document.getElementById("passwordNote");
  const current = document.getElementById("currentPasswordInput").value;
  const next = document.getElementById("newPasswordInput").value;
  try {
    const res = await fetch("/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    const data = await res.json();
    note.hidden = false;
    note.textContent = res.ok ? "Password updated." : data.error || "Could not update password.";
    note.style.color = res.ok ? "" : "#ff8a8a";
    if (res.ok) e.target.reset();
  } catch (err) {
    note.hidden = false;
    note.textContent = "Could not reach the backend.";
  }
});

// ---- Categories ----
async function refreshCategories() {
  const res = await fetch("/api/categories");
  adminCategories = await res.json();
  renderCategoryChips();
  renderCategorySelect();
}

function renderCategoryChips() {
  const list = document.getElementById("categoryChipList");
  list.innerHTML = adminCategories
    .map(
      (c) => `
    <span class="category-chip-item">
      ${escapeAttr(c.name)}
      <button type="button" data-remove-cat="${c.slug}" aria-label="Delete ${escapeAttr(c.name)}">×</button>
    </span>
  `
    )
    .join("");
}

function renderCategorySelect() {
  const select = document.getElementById("addCatSelect");
  const current = select.value;
  select.innerHTML = adminCategories.map((c) => `<option value="${c.slug}">${escapeAttr(c.name)}</option>`).join("");
  if (adminCategories.some((c) => c.slug === current)) select.value = current;
}

document.getElementById("addCategoryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("newCategoryName");
  const name = input.value.trim();
  if (!name) return;
  const res = await fetch("/api/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (res.ok) {
    input.value = "";
    await refreshCategories();
  } else {
    alert(data.error || "Could not add category.");
  }
});

document.getElementById("categoryChipList").addEventListener("click", async (e) => {
  const slug = e.target.closest("[data-remove-cat]")?.dataset.removeCat;
  if (!slug) return;
  const res = await fetch(`/api/categories/${slug}`, { method: "DELETE" });
  const data = await res.json();
  if (res.ok) {
    await refreshCategories();
  } else {
    alert(data.error || "Could not delete category.");
  }
});

// ---- Products table ----
const tbody = document.getElementById("productsTableBody");
const saveNote = document.getElementById("saveNote");

async function refreshProducts() {
  const res = await fetch("/api/products");
  adminProducts = await res.json();
  renderTable();
}

function renderTable() {
  tbody.innerHTML = adminProducts
    .map(
      (p) => `
    <tr data-id="${escapeAttr(p.id)}" class="${p.stock <= 0 ? "row-out" : ""}">
      <td>
        <div class="admin-thumb">
          ${p.image ? `<img src="${escapeAttr(p.image)}" alt="">` : `<span class="admin-thumb-icon">${escapeAttr(p.icon)}</span>`}
          <span class="admin-photo-count">${p.images.length} ${p.images.length === 1 ? "photo" : "photos"}</span>
          ${p.on_sale ? `<span class="admin-sale-chip">SALE ${p.discount_percent}%</span>` : ""}
        </div>
      </td>
      <td>
        <div class="admin-table-name">
          <input type="text" value="${escapeAttr(p.name)}" data-field="name" data-id="${escapeAttr(p.id)}">
        </div>
      </td>
      <td>
        <select data-field="cat" data-id="${escapeAttr(p.id)}">
          ${adminCategories.map((c) => `<option value="${escapeAttr(c.slug)}" ${c.slug === p.cat ? "selected" : ""}>${escapeAttr(c.name)}</option>`).join("")}
        </select>
      </td>
      <td><input type="number" min="0" step="1" value="${p.price}" data-field="price" data-id="${escapeAttr(p.id)}"></td>
      <td><input type="number" min="0" step="1" value="${p.stock}" data-field="stock" data-id="${escapeAttr(p.id)}"></td>
      <td class="admin-row-actions">
        <button class="row-edit" data-edit="${escapeAttr(p.id)}">Edit</button>
        <button class="row-delete" data-delete="${escapeAttr(p.id)}">Delete</button>
      </td>
    </tr>
  `
    )
    .join("");
}

function escapeAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function showSaveNote(text, isError) {
  saveNote.hidden = false;
  saveNote.textContent = text;
  saveNote.style.color = isError ? "#ff8a8a" : "";
  setTimeout(() => (saveNote.hidden = true), 3000);
}

// Quick edits in the table (name, category, price, stock) save as soon as
// you click away or press Enter not on every keystroke.
tbody.addEventListener("change", async (e) => {
  const field = e.target.dataset.field;
  const id = e.target.dataset.id;
  if (!field || !id) return;
  const value = field === "price" || field === "stock" ? Number(e.target.value) || 0 : e.target.value;
  const res = await fetch(`/api/products/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: value }),
  });
  if (res.ok) {
    showSaveNote("Saved.");
    await refreshProducts();
  } else {
    const data = await res.json();
    showSaveNote(data.error || "Could not save.", true);
    await refreshProducts();
  }
});

tbody.addEventListener("click", async (e) => {
  const editId = e.target.closest("[data-edit]")?.dataset.edit;
  if (editId) {
    openEditModal(editId);
    return;
  }
  const delId = e.target.closest("[data-delete]")?.dataset.delete;
  if (delId) {
    const p = adminProducts.find((prod) => prod.id === delId);
    if (!confirm(`Remove "${p ? p.name : "this product"}" and all its photos from the store?`)) return;
    const res = await fetch(`/api/products/${encodeURIComponent(delId)}`, { method: "DELETE" });
    if (res.ok) await refreshProducts();
  }
});

// ---- Add product form: photo previews ----
const addImageInput = document.getElementById("addImageInput");
const addImagePreview = document.getElementById("addImagePreview");
const addImagePreviewGrid = document.getElementById("addImagePreviewGrid");

function clearAddPreview() {
  addImageInput.value = "";
  addImagePreviewGrid.innerHTML = "";
  addImagePreview.hidden = true;
}

addImageInput.addEventListener("change", () => {
  const files = Array.from(addImageInput.files);
  if (!files.length) return clearAddPreview();
  addImagePreviewGrid.innerHTML = "";
  files.forEach((file, i) => {
    const reader = new FileReader();
    reader.onload = () => {
      const wrap = document.createElement("div");
      wrap.className = "admin-preview-item";
      wrap.innerHTML = `<img src="${reader.result}" alt="">${i === 0 ? '<span class="gal-badge">Main</span>' : ""}`;
      addImagePreviewGrid.appendChild(wrap);
    };
    reader.readAsDataURL(file);
  });
  addImagePreview.hidden = false;
});

document.getElementById("addImageClear").addEventListener("click", clearAddPreview);

// Uploads photos (a list of File objects) to a product. Returns the updated product or null.
async function uploadPhotos(productId, files) {
  const formData = new FormData();
  files.forEach((f) => formData.append("images", f));
  const res = await fetch(`/api/products/${encodeURIComponent(productId)}/images`, { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Could not upload photos.");
    return null;
  }
  return data;
}

document.getElementById("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = new FormData(form);
  const name = data.get("name").trim();
  if (!name) return;

  const payload = {
    name,
    cat: data.get("cat"),
    price: Number(data.get("price")) || 0,
    stock: Number(data.get("stock")) || 0,
    icon: data.get("icon") || "📦",
    desc: data.get("desc") || "",
    badge: data.get("badge") || null,
  };

  const res = await fetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const created = await res.json();

  if (!res.ok) {
    alert(created.error || "Could not add product.");
    return;
  }

  const files = Array.from(addImageInput.files);
  if (files.length) await uploadPhotos(created.id, files);

  form.reset();
  form.icon.value = "📦";
  clearAddPreview();
  await refreshProducts();
  showSaveNote("Product added. Use Edit to add a full description and specifications.");
});

// ---- Edit window (details, specifications, photo gallery) ----
const editModal = document.getElementById("editModal");
const editForm = document.getElementById("editForm");
const editGallery = document.getElementById("editGallery");
const editNote = document.getElementById("editNote");
const editImageInput = document.getElementById("editImageInput");
let editingId = null;

async function openEditModal(id) {
  const res = await fetch(`/api/products/${encodeURIComponent(id)}`);
  if (!res.ok) {
    alert("Could not load that product.");
    return;
  }
  const p = await res.json();
  editingId = id;

  document.getElementById("editTitle").textContent = `Edit: ${p.name}`;
  document.getElementById("editCatSelect").innerHTML = adminCategories
    .map((c) => `<option value="${escapeAttr(c.slug)}">${escapeAttr(c.name)}</option>`)
    .join("");

  const f = editForm.elements;
  f["name"].value = p.name;
  f["cat"].value = p.cat;
  f["price"].value = p.price;
  f["stock"].value = p.stock;
  f["icon"].value = p.icon || "";
  f["badge"].value = p.badge || "";
  f["desc"].value = p.desc || "";
  f["details"].value = p.details || "";
  f["specs"].value = p.specs || "";
  f["sale_price"].value = p.sale_price ?? "";
  f["sale_ends"].value = p.sale_ends || "";

  editNote.hidden = true;
  renderEditGallery(p);
  editModal.hidden = false;
  editModal.scrollTop = 0;
}

function closeEditModal() {
  editModal.hidden = true;
  editingId = null;
}

document.getElementById("editCloseBtn").addEventListener("click", closeEditModal);
editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeEditModal();
});

function renderEditGallery(p) {
  editGallery.innerHTML = p.images.length
    ? p.images
        .map(
          (img, i) => `
      <div class="gal-item">
        <img src="${escapeAttr(img.url)}" alt="">
        ${i === 0 ? '<span class="gal-badge">Main</span>' : `<button type="button" class="gal-btn gal-main" data-make-main="${img.id}">Make main</button>`}
        <button type="button" class="gal-btn gal-del" data-del-img="${img.id}">Delete</button>
      </div>`
        )
        .join("")
    : '<p class="admin-hint">No photos yet add some below.</p>';
}

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = editForm.elements;
  const payload = {
    name: f["name"].value.trim(),
    cat: f["cat"].value,
    price: Number(f["price"].value) || 0,
    stock: Number(f["stock"].value) || 0,
    icon: f["icon"].value.trim() || "📦",
    badge: f["badge"].value.trim() || null,
    desc: f["desc"].value,
    details: f["details"].value,
    specs: f["specs"].value,
    sale_price: f["sale_price"].value === "" ? null : Number(f["sale_price"].value),
    sale_ends: f["sale_ends"].value || null,
  };
  const res = await fetch(`/api/products/${encodeURIComponent(editingId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  editNote.hidden = false;
  editNote.style.color = res.ok ? "" : "#ff8a8a";
  editNote.textContent = res.ok ? "Saved the product page is updated." : data.error || "Could not save.";
  if (res.ok) {
    document.getElementById("editTitle").textContent = `Edit: ${data.name}`;
    await refreshProducts();
  }
});

editGallery.addEventListener("click", async (e) => {
  const mainId = e.target.closest("[data-make-main]")?.dataset.makeMain;
  const delId = e.target.closest("[data-del-img]")?.dataset.delImg;
  if (!mainId && !delId) return;

  let res;
  if (mainId) {
    res = await fetch(`/api/products/${encodeURIComponent(editingId)}/images/${mainId}/main`, { method: "PUT" });
  } else {
    if (!confirm("Delete this photo?")) return;
    res = await fetch(`/api/products/${encodeURIComponent(editingId)}/images/${delId}`, { method: "DELETE" });
  }
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Could not update photos.");
    return;
  }
  renderEditGallery(data);
  await refreshProducts();
});

editImageInput.addEventListener("change", async () => {
  const files = Array.from(editImageInput.files);
  if (!files.length) return;
  const updated = await uploadPhotos(editingId, files);
  editImageInput.value = "";
  if (updated) {
    renderEditGallery(updated);
    await refreshProducts();
  }
});

// ---- Settings ----
async function loadSettingsIntoForm() {
  const res = await fetch("/api/settings");
  const settings = await res.json();
  document.getElementById("whatsappInput").value = settings.whatsapp_number || "";
  document.getElementById("deliveryFeeInput").value = settings.delivery_fee ?? "";
}

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const whatsapp = document.getElementById("whatsappInput").value.trim();
  const deliveryFee = document.getElementById("deliveryFeeInput").value.trim() || "0";
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ whatsapp_number: whatsapp, delivery_fee: deliveryFee }),
  });
  showSaveNote(res.ok ? "Settings saved." : "Could not save settings.", !res.ok);
});

// ---- Small formatting helpers ----
function fmtDateTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Turns a phone number into a WhatsApp link (adds Mauritius' 230 to 8-digit local numbers).
function whatsappLink(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 8) digits = "230" + digits;
  return digits ? `https://wa.me/${digits}` : "";
}

function fmtSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---- Orders ----
const ordersList = document.getElementById("ordersList");
const ordersFilter = document.getElementById("ordersFilter");
const ordersBadge = document.getElementById("ordersBadge");
const ordersNote = document.getElementById("ordersNote");
let adminOrders = [];

async function refreshOrders() {
  const res = await fetch("/api/orders");
  if (!res.ok) return;
  adminOrders = await res.json();
  renderOrders();
}

function orderActionsHTML(o) {
  const btn = (action, label, cls = "") =>
    `<button type="button" class="order-btn ${cls}" data-order-action="${action}" data-order-id="${o.id}">${label}</button>`;
  if (o.status === "new") return btn("confirm", "Confirm order", "is-primary") + btn("cancel", "Cancel");
  if (o.status === "confirmed") return btn("complete", "Mark completed", "is-primary") + btn("cancel", "Cancel");
  if (o.status === "cancelled") return btn("reopen", "Reopen") + btn("delete", "Delete", "is-danger");
  return "";
}

function orderCardHTML(o) {
  const delivery = o.fulfilment === "delivery";
  const wa = whatsappLink(o.customer_phone);
  return `
    <article class="order-card is-${o.status}">
      <div class="order-head">
        <strong>${escapeAttr(o.number || "#" + o.id)}</strong>
        <span class="order-status ${o.status}">${o.status}</span>
        <span class="order-date">${fmtDateTime(o.created_at)}</span>
        <span class="order-total">${formatPrice(o.total)}</span>
      </div>
      <div class="order-meta">
        ${escapeAttr(o.customer_name)} ·
        ${wa ? `<a href="${wa}" target="_blank" rel="noopener">${escapeAttr(o.customer_phone)}</a>` : escapeAttr(o.customer_phone)} ·
        <strong>${delivery ? "Delivery" : "Store pickup"}</strong>
      </div>
      <ul class="order-items">
        ${o.items.map((it) => `<li>${it.qty} × ${escapeAttr(it.name)} <span>${formatPrice(it.line_total)}</span></li>`).join("")}
        ${delivery ? `<li class="order-fee">Delivery charge <span>${formatPrice(o.delivery_fee)}</span></li>` : ""}
      </ul>
      ${delivery ? `<div class="order-address"><strong>Address:</strong> ${o.address ? escapeAttr(o.address) : "<em>not given customer will send it on WhatsApp</em>"}</div>` : ""}
      <div class="order-actions">${orderActionsHTML(o)}</div>
    </article>`;
}

function renderOrders() {
  const newCount = adminOrders.filter((o) => o.status === "new").length;
  ordersBadge.hidden = newCount === 0;
  ordersBadge.textContent = `${newCount} new`;
  const filter = ordersFilter.value;
  const shown = adminOrders.filter((o) => filter === "all" || o.status === filter);
  ordersList.innerHTML = shown.length
    ? shown.map(orderCardHTML).join("")
    : `<p class="admin-empty">No ${filter === "all" ? "" : filter + " "}orders.</p>`;
}

function showOrdersNote(text, isError) {
  ordersNote.hidden = false;
  ordersNote.textContent = text;
  ordersNote.style.color = isError ? "#ff8a8a" : "";
  setTimeout(() => (ordersNote.hidden = true), 5000);
}

const ORDER_ACTIONS = { confirm: "confirmed", complete: "completed", cancel: "cancelled", reopen: "new" };

ordersFilter.addEventListener("change", renderOrders);
document.getElementById("ordersRefresh").addEventListener("click", refreshOrders);

ordersList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-order-action]");
  if (!btn) return;
  const id = btn.dataset.orderId;
  const action = btn.dataset.orderAction;
  const order = adminOrders.find((o) => String(o.id) === id);
  if (!order) return;

  let res;
  if (action === "delete") {
    if (!confirm(`Permanently delete ${order.number}?`)) return;
    res = await fetch(`/api/orders/${id}`, { method: "DELETE" });
  } else {
    if (action === "cancel" && !confirm(`Cancel ${order.number}?${order.stock_deducted ? " The stock will be given back." : ""}`)) return;
    res = await fetch(`/api/orders/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: ORDER_ACTIONS[action] }),
    });
  }
  const data = await res.json();
  if (!res.ok) {
    showOrdersNote(data.error || "Could not update the order.", true);
    return;
  }
  if (action === "confirm") showOrdersNote(`${order.number} confirmed stock updated.`);
  if (action === "cancel" && order.stock_deducted) showOrdersNote(`${order.number} cancelled stock given back.`);
  await refreshOrders();
  await refreshProducts(); // stock numbers may have changed
});

// ---- Messages (contact form inbox) ----
const messagesList = document.getElementById("messagesList");
const messagesBadge = document.getElementById("messagesBadge");
let adminMessages = [];

async function refreshMessages() {
  const res = await fetch("/api/messages");
  if (!res.ok) return;
  adminMessages = await res.json();
  renderMessages();
}

function renderMessages() {
  const unread = adminMessages.filter((m) => m.status === "new").length;
  messagesBadge.hidden = unread === 0;
  messagesBadge.textContent = `${unread} new`;
  messagesList.innerHTML = adminMessages.length
    ? adminMessages
        .map((m) => {
          const wa = whatsappLink(m.phone);
          return `
      <article class="msg-card ${m.status === "new" ? "is-unread" : ""}">
        <div class="order-head">
          <strong>${escapeAttr(m.name)}</strong>
          <span class="order-date">${fmtDateTime(m.created_at)}</span>
        </div>
        <div class="order-meta">
          <a href="mailto:${escapeAttr(m.email)}?subject=${encodeURIComponent("Your message to Electronics Square")}">${escapeAttr(m.email)}</a>
          ${wa ? ` · <a href="${wa}" target="_blank" rel="noopener">${escapeAttr(m.phone)} (WhatsApp)</a>` : ""}
        </div>
        <p class="msg-body">${escapeAttr(m.message)}</p>
        <div class="order-actions">
          <button type="button" class="order-btn" data-msg-toggle="${m.id}" data-msg-status="${m.status === "new" ? "read" : "new"}">${m.status === "new" ? "Mark as read" : "Mark as unread"}</button>
          <button type="button" class="order-btn is-danger" data-msg-delete="${m.id}">Delete</button>
        </div>
      </article>`;
        })
        .join("")
    : '<p class="admin-empty">No messages yet.</p>';
}

document.getElementById("messagesRefresh").addEventListener("click", refreshMessages);

messagesList.addEventListener("click", async (e) => {
  const toggle = e.target.closest("[data-msg-toggle]");
  const del = e.target.closest("[data-msg-delete]");
  if (toggle) {
    await fetch(`/api/messages/${toggle.dataset.msgToggle}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: toggle.dataset.msgStatus }),
    });
    await refreshMessages();
  } else if (del) {
    if (!confirm("Delete this message?")) return;
    await fetch(`/api/messages/${del.dataset.msgDelete}`, { method: "DELETE" });
    await refreshMessages();
  }
});

// ---- Backups ----
const backupsList = document.getElementById("backupsList");
const backupNote = document.getElementById("backupNote");
const BACKUP_KIND_LABELS = { auto: "Automatic (daily)", manual: "Manual", "pre-restore": "Safety copy before a restore" };

function showBackupNote(text, isError) {
  backupNote.hidden = false;
  backupNote.textContent = text;
  backupNote.style.color = isError ? "#ff8a8a" : "";
  setTimeout(() => (backupNote.hidden = true), 6000);
}

async function refreshBackups() {
  const res = await fetch("/api/backups");
  if (!res.ok) return;
  const items = await res.json();
  backupsList.innerHTML = items.length
    ? items
        .map(
          (b) => `
      <div class="backup-row">
        <div>
          <strong>${BACKUP_KIND_LABELS[b.kind] || b.kind}</strong>
          <span class="order-date">${fmtDateTime(b.created)} · ${fmtSize(b.size)}</span>
        </div>
        <div class="order-actions">
          <a class="order-btn" href="/api/backups/${encodeURIComponent(b.name)}" download>Download</a>
          <button type="button" class="order-btn is-danger" data-restore="${escapeAttr(b.name)}">Restore</button>
        </div>
      </div>`
        )
        .join("")
    : '<p class="admin-empty">No backups saved yet the first automatic one is made when the shop starts.</p>';
}

const RESTORE_WARNING =
  "Restoring replaces ALL current products, photos, orders and messages with what is in the backup.\n\nA safety copy of the current data is saved first. Continue?";

async function finishRestore(res) {
  const data = await res.json();
  if (!res.ok) {
    showBackupNote(data.error || "Could not restore that backup.", true);
    return;
  }
  alert(`Backup restored (${data.photos} photos). The page will now reload.`);
  location.reload();
}

document.getElementById("backupNowBtn").addEventListener("click", async () => {
  const res = await fetch("/api/backups", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    showBackupNote(data.error || "Could not create the backup.", true);
    return;
  }
  const a = document.createElement("a");
  a.href = `/api/backups/${encodeURIComponent(data.name)}`;
  a.download = data.name;
  a.click();
  showBackupNote("Backup created and downloading.");
  refreshBackups();
});

document.getElementById("restoreFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !confirm(RESTORE_WARNING)) return;
  const formData = new FormData();
  formData.append("backup", file);
  showBackupNote("Restoring… this can take a moment.");
  await finishRestore(await fetch("/api/backups/restore", { method: "POST", body: formData }));
});

backupsList.addEventListener("click", async (e) => {
  const name = e.target.closest("[data-restore]")?.dataset.restore;
  if (!name || !confirm(RESTORE_WARNING)) return;
  showBackupNote("Restoring… this can take a moment.");
  await finishRestore(await fetch(`/api/backups/${encodeURIComponent(name)}/restore`, { method: "POST" }));
});
