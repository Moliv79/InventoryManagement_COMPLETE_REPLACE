async function api(url, options = {}) {
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options
    });

    const text = await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Server returned an invalid response.");
    }

    if (!response.ok) {
        throw new Error(
            data.error ||
            data.message ||
            "Something went wrong"
        );
    }

    return data;
}

function money(value) {
    return "₹" + Number(value || 0).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function dateToday() {
    const d = new Date();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
}

function showMessage(id, text, type = "success") {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = `message show ${type}`;
    setTimeout(() => {
        el.className = "message";
    }, 3500);
}

function setupMenu() {
    const button = document.getElementById("menuButton");
    const sidebar = document.getElementById("sidebar");
    if (button && sidebar) {
        button.addEventListener("click", () => sidebar.classList.toggle("open"));
    }
}

function setActiveNav() {
    const current = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".sidebar a").forEach(link => {
        const href = link.getAttribute("href");
        if (href === current || (current === "" && href === "index.html")) {
            link.classList.add("active");
        }
    });
}

async function loadDashboard() {
    const data = await api("/api/dashboard");

    const values = {
        totalProducts: data.total_products,
        totalCategories: data.total_categories,
        totalSuppliers: data.total_suppliers,
        totalCustomers: data.total_customers,
        totalStock: data.total_stock,
        lowStock: data.low_stock,
        totalOrders: data.total_orders,
        orderValue: money(data.order_value),
        purchasedUnits: data.purchased_units,
        soldUnits: data.sold_units,
        purchaseValue: money(data.purchase_value),
        salesValue: money(data.sales_value)
    };

    Object.entries(values).forEach(([key, value]) => {
        const el = document.getElementById(key);
        if (el) el.textContent = value;
    });

    const low = await api("/api/low-stock");
    const lowTable = document.getElementById("dashboardLowStock");

    if (lowTable) {
        if (!low.length) {
            lowTable.innerHTML = `<tr><td colspan="5" class="empty">No low stock products.</td></tr>`;
        } else {
            lowTable.innerHTML = low.map(item => `
                <tr>
                    <td>${item.product_id}</td>
                    <td>${escapeHtml(item.product_name)}</td>
                    <td>${escapeHtml(item.category_name || "-")}</td>
                    <td>${item.quantity}</td>
                    <td>${item.reorder_level}</td>
                </tr>
            `).join("");
        }
    }

    const categories = await api("/api/category-stock");
    const categoryBox = document.getElementById("categoryBars");

    if (categoryBox) {
        const max = Math.max(...categories.map(x => Number(x.total_stock)), 1);

        categoryBox.innerHTML = categories.length
            ? categories.map(item => `
                <div class="bar-row">
                    <div class="bar-label">
                        <span>${escapeHtml(item.category_name)}</span>
                        <strong>${item.total_stock}</strong>
                    </div>
                    <div class="bar-track">
                        <div class="bar-fill" style="width:${(Number(item.total_stock) / max) * 100}%"></div>
                    </div>
                </div>
            `).join("")
            : `<div class="empty">No category data.</div>`;
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

document.addEventListener("DOMContentLoaded", () => {
    setupMenu();
    setActiveNav();

    if (document.getElementById("totalProducts")) {
        loadDashboard().catch(error => {
            console.error(error);
        });

        setInterval(() => {
            loadDashboard().catch(() => {});
        }, 3000);
    }
});
async function logout() {
    try {
        await api("/api/logout", {
            method: "POST"
        });

        localStorage.removeItem("inventoryUser");

        window.location.href = "login.html";
    } catch (error) {
        alert(error.message);
    }
}
