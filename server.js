const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");

const app = express();
const PORT = 3000;

const pool = mysql.createPool({
    host: "localhost",
    user: "root",
    password: "Inventory@123",
    database: "inventory_managment_newww",
    waitForConnections: true,
    connectionLimit: 10
});

app.use(express.json());
app.use(session({
    secret: "inventory-management-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 2 * 60 * 60 * 1000
    }
}));
function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({
            error: "Please login first."
        });
    }

    next();
}
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

async function query(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
}

async function transaction(work) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

app.get("/api/dashboard", async (req, res) => {
    try {
        const [result] = await Promise.all([
            query(`
                SELECT
                    (SELECT COUNT(*) FROM Product) AS total_products,
                    (SELECT COUNT(*) FROM Category) AS total_categories,
                    (SELECT COUNT(*) FROM Supplier) AS total_suppliers,
                    (SELECT COUNT(*) FROM Customer) AS total_customers,
                    (SELECT COUNT(*) FROM Orders) AS total_orders,
                    (SELECT COALESCE(SUM(quantity), 0) FROM Stock) AS total_stock,
                    (SELECT COUNT(*) FROM Stock WHERE quantity <= reorder_level) AS low_stock,
                    (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM Order_Details) AS order_value,
                    (SELECT COALESCE(SUM(quantity), 0) FROM Purchase) AS purchased_units,
                    (SELECT COALESCE(SUM(quantity), 0) FROM Sale) AS sold_units,
                    (SELECT COALESCE(SUM(quantity * purchase_price), 0) FROM Purchase) AS purchase_value,
                    (SELECT COALESCE(SUM(quantity * sale_price), 0) FROM Sale) AS sales_value
            `)
        ]);
        res.json(result[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/products", async (req, res) => {
    try {
        const search = (req.query.search || "").trim();
        const category = (req.query.category || "").trim();

        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
        const offset = (page - 1) * limit;

        const params = [];
        const countParams = [];
        let where = "WHERE 1=1";

        if (search) {
            where += " AND (p.product_name LIKE ? OR p.brand LIKE ? OR p.sub_category LIKE ?)";
            const value = `%${search}%`;
            params.push(value, value, value);
            countParams.push(value, value, value);
        }

        if (category) {
            where += " AND p.category_id = ?";
            params.push(category);
            countParams.push(category);
        }

        const countRows = await query(`
            SELECT COUNT(*) AS total
            FROM Product p
            ${where}
        `, countParams);

        const rows = await query(`
            SELECT
                p.product_id,
                p.product_name,
                p.category_id,
                c.category_name,
                p.sub_category,
                p.brand,
                p.sale_price,
                p.market_price,
                p.product_type,
                p.rating,
                p.description,
                COALESCE(s.quantity, 0) AS quantity,
                COALESCE(s.reorder_level, 10) AS reorder_level
            FROM Product p
            LEFT JOIN Category c ON p.category_id = c.category_id
            LEFT JOIN Stock s ON p.product_id = s.product_id
            ${where}
            ORDER BY p.product_id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        res.json({
            products: rows,
            total: Number(countRows[0].total),
            page,
            limit,
            totalPages: Math.ceil(Number(countRows[0].total) / limit)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/products/:id", async (req, res) => {
    try {
        const rows = await query(`
           SELECT
    p.*,
    c.category_name,
    COALESCE(s.quantity, 0) AS quantity,
    COALESCE(s.reorder_level, 10) AS reorder_level,
    g.godown_id,
    g.godown_name,
    g.location AS godown_location
FROM Product p
LEFT JOIN Category c ON p.category_id = c.category_id
LEFT JOIN Stock s ON p.product_id = s.product_id
LEFT JOIN Godown g ON s.godown_id = g.godown_id
WHERE p.product_id = ?
        `, [req.params.id]);

        if (!rows.length) {
            return res.status(404).json({
                error: "Product not found"
            });
        }

        res.json(rows[0]);

    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});
app.post("/api/products", async (req, res) => {
    try {
        const {
            product_name,
            category_id,
            sub_category,
            brand,
            sale_price,
            market_price,
            product_type,
            rating,
            description,
            quantity,
            reorder_level
        } = req.body;

        if (!product_name) return res.status(400).json({ error: "Product name is required" });

        const result = await transaction(async (connection) => {
            const [product] = await connection.query(`
                INSERT INTO Product
                (product_name, category_id, sub_category, brand, sale_price, market_price, product_type, rating, description)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                product_name,
                category_id || null,
                sub_category || null,
                brand || null,
                sale_price || 0,
                market_price || 0,
                product_type || null,
                rating || null,
                description || null
            ]);

           await connection.query(`
    INSERT INTO Stock
    (product_id, godown_id, quantity, reorder_level)
    VALUES (?, ?, ?, ?)
`, [
    product.insertId,
    Number(quantity || 0),
    Number(reorder_level || 10)
]);

            return product.insertId;
        });

        res.json({ message: "Product added", product_id: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put("/api/products/:id", async (req, res) => {
    try {
        const {
            product_name,
            category_id,
            sub_category,
            brand,
            sale_price,
            market_price,
            product_type,
            rating,
            description,
            quantity,
            reorder_level
        } = req.body;

        await transaction(async (connection) => {
            await connection.query(`
                UPDATE Product
                SET product_name = ?, category_id = ?, sub_category = ?, brand = ?,
                    sale_price = ?, market_price = ?, product_type = ?, rating = ?, description = ?
                WHERE product_id = ?
            `, [
                product_name,
                category_id || null,
                sub_category || null,
                brand || null,
                sale_price || 0,
                market_price || 0,
                product_type || null,
                rating || null,
                description || null,
                req.params.id
            ]);

            await connection.query(`
                INSERT INTO Stock (product_id, quantity, reorder_level)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    quantity = VALUES(quantity),
                    reorder_level = VALUES(reorder_level)
            `, [
                req.params.id,
                Number(quantity || 0),
                Number(reorder_level || 10)
            ]);
        });

        res.json({ message: "Product updated" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete("/api/products/:id", async (req, res) => {
    try {
        await transaction(async (connection) => {
            const [refs] = await connection.query(`
                SELECT
                    (SELECT COUNT(*) FROM Purchase WHERE product_id = ?) +
                    (SELECT COUNT(*) FROM Sale WHERE product_id = ?) +
                    (SELECT COUNT(*) FROM Order_Details WHERE product_id = ?) AS total_refs
            `, [req.params.id, req.params.id, req.params.id]);

            if (refs[0].total_refs > 0) {
                throw new Error("This product is already used in purchase, sale or order records. Remove those records first.");
            }

            await connection.query("DELETE FROM Stock WHERE product_id = ?", [req.params.id]);
            await connection.query("DELETE FROM Product WHERE product_id = ?", [req.params.id]);
        });

        res.json({ message: "Product deleted" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/categories", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                c.category_id,
                c.category_name,
                c.description,
                COUNT(p.product_id) AS product_count
            FROM Category c
            LEFT JOIN Product p ON c.category_id = p.category_id
            GROUP BY c.category_id
            ORDER BY c.category_id DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/categories", async (req, res) => {
    try {
        const { category_name, description } = req.body;
        if (!category_name) return res.status(400).json({ error: "Category name is required" });
        const result = await query(
            "INSERT INTO Category (category_name, description) VALUES (?, ?)",
            [category_name, description || null]
        );
        res.json({ message: "Category added", category_id: result.insertId });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.put("/api/categories/:id", async (req, res) => {
    try {
        const { category_name, description } = req.body;
        await query(
            "UPDATE Category SET category_name = ?, description = ? WHERE category_id = ?",
            [category_name, description || null, req.params.id]
        );
        res.json({ message: "Category updated" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete("/api/categories/:id", async (req, res) => {
    try {
        const used = await query("SELECT COUNT(*) AS count FROM Product WHERE category_id = ?", [req.params.id]);
        if (used[0].count > 0) {
            return res.status(400).json({ error: "Category is used by products. Change the products first." });
        }
        await query("DELETE FROM Category WHERE category_id = ?", [req.params.id]);
        res.json({ message: "Category deleted" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/suppliers", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                s.supplier_id,
                s.supplier_name,
                s.email,
                s.phone,
                s.address,
                COUNT(DISTINCT p.product_id) AS product_count
            FROM Supplier s
            LEFT JOIN Purchase pu ON s.supplier_id = pu.supplier_id
            LEFT JOIN Product p ON pu.product_id = p.product_id
            GROUP BY
                s.supplier_id,
                s.supplier_name,
                s.email,
                s.phone,
                s.address
            ORDER BY s.supplier_id DESC
        `);

        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get("/api/suppliers/export", async (req, res) => {
    try {
        const suppliers = await query(`
            SELECT
                supplier_id,
                supplier_name,
                email,
                phone,
                address
            FROM Supplier
            ORDER BY supplier_id
        `);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Suppliers");

        worksheet.columns = [
            { header: "Supplier ID", key: "supplier_id", width: 15 },
            { header: "Supplier Name", key: "supplier_name", width: 30 },
            { header: "Email", key: "email", width: 30 },
            { header: "Phone", key: "phone", width: 18 },
            { header: "Address", key: "address", width: 25 }
        ];

        suppliers.forEach(supplier => {
            worksheet.addRow(supplier);
        });

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        res.setHeader(
            "Content-Disposition",
            'attachment; filename="Supplier_Information.xlsx"'
        );

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});
app.post("/api/suppliers", async (req, res) => {
    try {
        const {
            supplier_name,
            email,
            phone,
            address
        } = req.body;

        if (!supplier_name) {
            return res.status(400).json({
                error: "Supplier name is required"
            });
        }

        const result = await query(`
            INSERT INTO Supplier
            (supplier_name, email, phone, address)
            VALUES (?, ?, ?, ?)
        `, [
            supplier_name,
            email || null,
            phone || null,
            address || null
        ]);

        res.json({
            message: "Supplier added",
            supplier_id: result.insertId
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.put("/api/suppliers/:id", async (req, res) => {
    try {
        const { supplier_name, email, phone, address } = req.body;
        await query(`
            UPDATE Supplier
            SET supplier_name = ?, email = ?, phone = ?, address = ?
            WHERE supplier_id = ?
        `, [supplier_name, email || null, phone || null, address || null, req.params.id]);
        res.json({ message: "Supplier updated" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete("/api/suppliers/:id", async (req, res) => {
    try {
        const used = await query("SELECT COUNT(*) AS count FROM Product WHERE supplier_id = ?", [req.params.id]);
        if (used[0].count > 0) {
            return res.status(400).json({ error: "Supplier is linked to products. Change those products first." });
        }
        await query("DELETE FROM Supplier WHERE supplier_id = ?", [req.params.id]);
        res.json({ message: "Supplier deleted" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/customers", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                c.customer_id,
                c.customer_name,
                c.email,
                c.phone,
                c.address,
                COUNT(o.order_id) AS order_count
            FROM Customer c
            LEFT JOIN Orders o
                ON c.customer_id = o.customer_id
            GROUP BY
                c.customer_id,
                c.customer_name,
                c.email,
                c.phone,
                c.address
            ORDER BY c.customer_id DESC
        `);

        res.json(rows);
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.post("/api/customers", async (req, res) => {
    try {
        const {
            customer_name,
            email,
            phone,
            address
        } = req.body;

        if (!customer_name) {
            return res.status(400).json({
                error: "Customer name is required"
            });
        }

        const result = await query(`
            INSERT INTO Customer
            (customer_name, email, phone, address)
            VALUES (?, ?, ?, ?)
        `, [
            customer_name,
            email || null,
            phone || null,
            address || null
        ]);

        res.json({
            message: "Customer added",
            customer_id: result.insertId
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});
app.put("/api/customers/:id", async (req, res) => {
    try {
        const { customer_name, email, phone, address } = req.body;
        await query(`
            UPDATE Customer
            SET customer_name = ?, email = ?, phone = ?, address = ?
            WHERE customer_id = ?
        `, [customer_name, email || null, phone || null, address || null, req.params.id]);
        res.json({ message: "Customer updated" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete("/api/customers/:id", async (req, res) => {
    try {
        const used = await query(`
            SELECT
                (SELECT COUNT(*) FROM Orders WHERE customer_id = ?) +
                (SELECT COUNT(*) FROM Sale WHERE customer_id = ?) AS count
        `, [req.params.id, req.params.id]);

        if (used[0].count > 0) {
            return res.status(400).json({ error: "Customer is used in order or sale records." });
        }

        await query("DELETE FROM Customer WHERE customer_id = ?", [req.params.id]);
        res.json({ message: "Customer deleted" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/stock", async (req, res) => {
    try {
        const search = (req.query.search || "").trim();
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = 50;
        const offset = (page - 1) * limit;

        const params = [];
        let where = "";

        if (search) {
            where = "WHERE p.product_name LIKE ?";
            params.push(`%${search}%`);
        }

        const countRows = await query(`
            SELECT COUNT(*) AS total
            FROM Stock s
            JOIN Product p ON p.product_id = s.product_id
            ${where}
        `, params);

        const rows = await query(`
            SELECT
                s.stock_id,
                s.product_id,
                p.product_name,
                c.category_name,
                s.quantity,
                s.reorder_level,
                s.last_updated,
                CASE
                    WHEN s.quantity <= s.reorder_level THEN 'Low Stock'
                    ELSE 'In Stock'
                END AS stock_status
            FROM Stock s
            JOIN Product p ON p.product_id = s.product_id
            LEFT JOIN Category c ON c.category_id = p.category_id
            ${where}
            ORDER BY s.quantity ASC, p.product_name
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const total = Number(countRows[0].total);

        res.json({
            stock: rows,
            total: total,
            page: page,
            limit: limit,
            totalPages: Math.ceil(total / limit)
        });

    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.put("/api/stock/:product_id", async (req, res) => {
    try {
        const quantity = Number(req.body.quantity);
        const reorder_level = Number(req.body.reorder_level);

        if (quantity < 0 || reorder_level < 0) {
            return res.status(400).json({ error: "Quantity cannot be negative." });
        }

        await query(`
            UPDATE Stock
            SET quantity = ?, reorder_level = ?
            WHERE product_id = ?
        `, [quantity, reorder_level, req.params.product_id]);

        res.json({ message: "Stock updated" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/low-stock", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                s.product_id,
                p.product_name,
                c.category_name,
                s.quantity,
                s.reorder_level
            FROM Stock s
            JOIN Product p ON p.product_id = s.product_id
            LEFT JOIN Category c ON c.category_id = p.category_id
            WHERE s.quantity <= s.reorder_level
            ORDER BY s.quantity ASC, p.product_name
            LIMIT 20
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/category-stock", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                c.category_name,
                COALESCE(SUM(s.quantity), 0) AS total_stock
            FROM Category c
            LEFT JOIN Product p ON p.category_id = c.category_id
            LEFT JOIN Stock s ON s.product_id = p.product_id
            GROUP BY c.category_id, c.category_name
            ORDER BY total_stock DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/purchases", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                pu.purchase_id,
                pu.product_id,
                p.product_name,
                pu.supplier_id,
                s.supplier_name,
                pu.quantity,
                pu.purchase_price,
                pu.purchase_date
            FROM Purchase pu
            JOIN Product p ON pu.product_id = p.product_id
            JOIN Supplier s ON pu.supplier_id = s.supplier_id
            ORDER BY pu.purchase_id DESC
        `);

        res.json(rows);
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.post("/api/purchases", async (req, res) => {
    try {
        const {
            product_id,
            supplier_id,
            quantity,
            purchase_price,
            purchase_date
        } = req.body;

        if (!product_id || !supplier_id || !quantity || !purchase_price || !purchase_date) {
            return res.status(400).json({
                error: "All purchase fields are required"
            });
        }

        await query(`
            INSERT INTO Purchase
            (product_id, supplier_id, quantity, purchase_price, purchase_date)
            VALUES (?, ?, ?, ?, ?)
        `, [
            product_id,
            supplier_id,
            quantity,
            purchase_price,
            purchase_date
        ]);

        await query(`
            INSERT INTO Stock
            (product_id, quantity, reorder_level)
            VALUES (?, ?, 10)
            ON DUPLICATE KEY UPDATE
            quantity = quantity + ?
        `, [
            product_id,
            quantity,
            quantity
        ]);

        res.json({
            message: "Purchase added and stock updated"
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.delete("/api/purchases/:id", async (req, res) => {
    try {
        await transaction(async (connection) => {
            const [rows] = await connection.query(
                "SELECT product_id, quantity FROM Purchase WHERE purchase_id = ?",
                [req.params.id]
            );
            if (!rows.length) throw new Error("Purchase not found.");

            await connection.query(
                "UPDATE Stock SET quantity = quantity - ? WHERE product_id = ?",
                [rows[0].quantity, rows[0].product_id]
            );

            await connection.query(
                "DELETE FROM Purchase WHERE purchase_id = ?",
                [req.params.id]
            );
        });

        res.json({ message: "Purchase deleted" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/sales", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                sa.sale_id,
                sa.product_id,
                p.product_name,
                sa.customer_id,
                c.customer_name,
                sa.quantity,
                sa.sale_price,
                sa.sale_date,
                sa.quantity * sa.sale_price AS total_value
            FROM Sale sa
            JOIN Product p ON p.product_id = sa.product_id
            JOIN Customer c ON c.customer_id = sa.customer_id
            ORDER BY sa.sale_id DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/sales", async (req, res) => {
    try {
        const { product_id, customer_id, quantity, sale_price, sale_date } = req.body;
        const qty = Number(quantity);

        if (!product_id || !customer_id || qty <= 0 || sale_price === undefined || !sale_date) {
            return res.status(400).json({ error: "Enter all sale details correctly." });
        }

        await transaction(async (connection) => {
            const [stockRows] = await connection.query(
                "SELECT quantity FROM Stock WHERE product_id = ? FOR UPDATE",
                [product_id]
            );

            if (!stockRows.length) throw new Error("Stock record not found.");
            if (Number(stockRows[0].quantity) < qty) throw new Error("Not enough stock available.");

            await connection.query(`
                INSERT INTO Sale
                (product_id, customer_id, quantity, sale_price, sale_date)
                VALUES (?, ?, ?, ?, ?)
            `, [product_id, customer_id, qty, sale_price, sale_date]);

            await connection.query(`
                UPDATE Stock
                SET quantity = quantity - ?
                WHERE product_id = ?
            `, [qty, product_id]);
        });

        res.json({ message: "Sale added" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete("/api/sales/:id", async (req, res) => {
    try {
        await transaction(async (connection) => {
            const [rows] = await connection.query(
                "SELECT product_id, quantity FROM Sale WHERE sale_id = ?",
                [req.params.id]
            );
            if (!rows.length) throw new Error("Sale not found.");

            await connection.query(
                "UPDATE Stock SET quantity = quantity + ? WHERE product_id = ?",
                [rows[0].quantity, rows[0].product_id]
            );

            await connection.query(
                "DELETE FROM Sale WHERE sale_id = ?",
                [req.params.id]
            );
        });

        res.json({ message: "Sale deleted" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/orders", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                o.order_id,
                o.customer_id,
                c.customer_name,
                o.order_date,
                o.order_status,
                COUNT(od.order_detail_id) AS item_lines,
                COALESCE(SUM(od.quantity * od.unit_price), 0) AS total_value
            FROM Orders o
            JOIN Customer c ON c.customer_id = o.customer_id
            LEFT JOIN Order_Details od ON od.order_id = o.order_id
            GROUP BY o.order_id
            ORDER BY o.order_id DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/orders/:id", async (req, res) => {
    try {
        const orders = await query(`
            SELECT
                o.order_id,
                o.customer_id,
                o.order_date,
                o.order_status,
                c.customer_name,
                c.email,
                c.phone,
                c.address
            FROM Orders o
            JOIN Customer c ON c.customer_id = o.customer_id
            WHERE o.order_id = ?
        `, [req.params.id]);

        if (!orders.length) {
            return res.status(404).json({
                error: "Order not found"
            });
        }

        const details = await query(`
            SELECT
                od.order_detail_id,
                od.order_id,
                od.product_id,
                od.quantity,
                od.unit_price,
                p.product_name
            FROM Order_Details od
            JOIN Product p ON p.product_id = od.product_id
            WHERE od.order_id = ?
            ORDER BY od.order_detail_id
        `, [req.params.id]);

        res.json({
            order: orders[0],
            details
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.post("/api/orders", async (req, res) => {
    try {
        const {
            customer_id,
            order_date,
            order_status,
            items
        } = req.body;

        if (!customer_id || !order_date || !Array.isArray(items) || !items.length) {
            return res.status(400).json({
                error: "Customer, date and at least one product are required."
            });
        }

        const allowedStatuses = [
            "Pending",
            "Processing",
            "Completed",
            "Cancelled"
        ];

        const status = order_status || "Pending";

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                error: "Invalid order status."
            });
        }

        const orderId = await transaction(async (connection) => {
            const [customer] = await connection.query(
                "SELECT customer_id FROM Customer WHERE customer_id = ?",
                [customer_id]
            );

            if (!customer.length) {
                throw new Error("Customer not found.");
            }

            const [order] = await connection.query(`
                INSERT INTO Orders
                (customer_id, order_date, order_status)
                VALUES (?, ?, ?)
            `, [
                customer_id,
                order_date,
                status
            ]);

            for (const item of items) {
                const qty = Number(item.quantity);
                const price = Number(item.unit_price);

                if (!item.product_id || qty <= 0 || price < 0) {
                    throw new Error("Invalid order item.");
                }

                const [product] = await connection.query(
                    "SELECT product_id FROM Product WHERE product_id = ?",
                    [item.product_id]
                );

                if (!product.length) {
                    throw new Error("Product not found.");
                }

                await connection.query(`
                    INSERT INTO Order_Details
                    (order_id, product_id, quantity, unit_price)
                    VALUES (?, ?, ?, ?)
                `, [
                    order.insertId,
                    item.product_id,
                    qty,
                    price
                ]);
            }

            return order.insertId;
        });

        res.json({
            message: "Order added",
            order_id: orderId
        });
    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

app.put("/api/orders/:id", async (req, res) => {
    try {
        const { order_status } = req.body;

        const allowedStatuses = [
            "Pending",
            "Processing",
            "Completed",
            "Cancelled"
        ];

        if (!allowedStatuses.includes(order_status)) {
            return res.status(400).json({
                error: "Invalid order status."
            });
        }

        const result = await query(`
            UPDATE Orders
            SET order_status = ?
            WHERE order_id = ?
        `, [
            order_status,
            req.params.id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                error: "Order not found."
            });
        }

        res.json({
            message: "Order status updated"
        });
    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

app.delete("/api/orders/:id", async (req, res) => {
    try {
        await transaction(async (connection) => {
            const [order] = await connection.query(
                "SELECT order_id FROM Orders WHERE order_id = ?",
                [req.params.id]
            );

            if (!order.length) {
                throw new Error("Order not found.");
            }

            await connection.query(
                "DELETE FROM Order_Details WHERE order_id = ?",
                [req.params.id]
            );

            await connection.query(
                "DELETE FROM Orders WHERE order_id = ?",
                [req.params.id]
            );
        });

        res.json({
            message: "Order deleted"
        });
    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

app.get("/api/deliveries", async (req, res) => {
    try {
        const rows = await query(`
            SELECT
                d.delivery_id,
                d.sale_id,
                d.delivery_date,
                d.delivery_address,
                d.delivery_status,
                p.product_name,
                c.customer_name
            FROM Delivery d
            JOIN Sale sa ON sa.sale_id = d.sale_id
            JOIN Product p ON p.product_id = sa.product_id
            JOIN Customer c ON c.customer_id = sa.customer_id
            ORDER BY d.delivery_id DESC
        `);

        res.json(rows);
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.post("/api/deliveries", async (req, res) => {
    try {
        const {
            sale_id,
            delivery_date,
            delivery_address,
            delivery_status
        } = req.body;

        if (!sale_id) {
            return res.status(400).json({
                error: "Sale is required."
            });
        }

        const allowedStatuses = [
            "Pending",
            "Dispatched",
            "Delivered",
            "Cancelled"
        ];

        const status = delivery_status || "Pending";

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                error: "Invalid delivery status."
            });
        }

        const sales = await query(
            "SELECT sale_id FROM Sale WHERE sale_id = ?",
            [sale_id]
        );

        if (!sales.length) {
            return res.status(404).json({
                error: "Sale not found."
            });
        }

        await query(`
            INSERT INTO Delivery
            (sale_id, delivery_date, delivery_address, delivery_status)
            VALUES (?, ?, ?, ?)
        `, [
            sale_id,
            delivery_date || null,
            delivery_address || null,
            status
        ]);

        res.json({
            message: "Delivery added"
        });

    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

app.put("/api/deliveries/:id", async (req, res) => {
    try {
        const { delivery_status } = req.body;

        const allowedStatuses = [
            "Pending",
            "Dispatched",
            "Delivered",
            "Cancelled"
        ];

        if (!allowedStatuses.includes(delivery_status)) {
            return res.status(400).json({
                error: "Invalid delivery status."
            });
        }

        const result = await query(`
            UPDATE Delivery
            SET delivery_status = ?
            WHERE delivery_id = ?
        `, [
            delivery_status,
            req.params.id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                error: "Delivery not found."
            });
        }

        res.json({
            message: "Delivery status updated"
        });

    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

app.delete("/api/deliveries/:id", async (req, res) => {
    try {
        const result = await query(
            "DELETE FROM Delivery WHERE delivery_id = ?",
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                error: "Delivery not found."
            });
        }

        res.json({
            message: "Delivery deleted"
        });

    } catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});
app.get("/api/reports", async (req, res) => {
    try {
        const [summary] = await query(`
            SELECT
                (SELECT COALESCE(SUM(quantity), 0) FROM Purchase) AS purchased_units,
                (SELECT COALESCE(SUM(quantity), 0) FROM Sale) AS sold_units,
                (SELECT COALESCE(SUM(quantity * purchase_price), 0) FROM Purchase) AS purchase_value,
                (SELECT COALESCE(SUM(quantity * sale_price), 0) FROM Sale) AS sales_value,
                (SELECT COALESCE(SUM(quantity), 0) FROM Stock) AS current_stock
        `);

        const monthly = await query(`
            SELECT
                month_name,
                SUM(purchased) AS purchased,
                SUM(sold) AS sold
            FROM (
                SELECT
                    DATE_FORMAT(purchase_date, '%Y-%m') AS month_name,
                    SUM(quantity) AS purchased,
                    0 AS sold
                FROM Purchase
                GROUP BY DATE_FORMAT(purchase_date, '%Y-%m')
                UNION ALL
                SELECT
                    DATE_FORMAT(sale_date, '%Y-%m') AS month_name,
                    0 AS purchased,
                    SUM(quantity) AS sold
                FROM Sale
                GROUP BY DATE_FORMAT(sale_date, '%Y-%m')
            ) x
            GROUP BY month_name
            ORDER BY month_name
        `);

        res.json({ summary, monthly });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/health", async (req, res) => {
    try {
        await query("SELECT 1");
        res.json({ connected: true });
    } catch (error) {
        res.status(500).json({ connected: false, error: error.message });
    }
});

app.get("/{*splat}", (req, res) => {
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({ error: "API endpoint not found" });
    }
    res.sendFile(path.join(__dirname, "index.html"));
});
app.post("/api/signup", async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const usernamePattern = /^[A-Za-z0-9]+$/;

if (!usernamePattern.test(username)) {
    return res.status(400).json({
        error: "Username can contain only letters and numbers."
    });
}

        if (!username || !email || !password) {
            return res.status(400).json({
                error: "Username, email and password are required."
            });
        }

        const existing = await query(`
            SELECT user_id
            FROM Users
            WHERE username = ? OR email = ?
        `, [username, email]);

        if (existing.length) {
            return res.status(400).json({
                error: "Username or email already exists."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await query(`
            INSERT INTO Users
            (username, email, password)
            VALUES (?, ?, ?)
        `, [
            username,
            email,
            hashedPassword
        ]);

        res.json({
            message: "User created successfully."
        });

    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                error: "Username and password are required."
            });
        }

        const users = await query(`
            SELECT user_id, username, email, password
            FROM Users
            WHERE username = ?
        `, [username]);

        if (!users.length) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        const validPassword = await bcrypt.compare(
            password,
            users[0].password
        );

        if (!validPassword) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        req.session.user = {
            user_id: users[0].user_id,
            username: users[0].username,
            email: users[0].email
        };

        res.json({
            message: "Login successful.",
            user: req.session.user
        });

    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});
app.post("/api/register", async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                error: "Username, email and password are required."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "Password must be at least 6 characters."
            });
        }

        const existingUser = await query(`
            SELECT user_id
            FROM Users
            WHERE username = ? OR email = ?
        `, [username, email]);

        if (existingUser.length) {
            return res.status(409).json({
                error: "Username or email already exists."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await query(`
            INSERT INTO Users (username, email, password)
            VALUES (?, ?, ?)
        `, [username, email, hashedPassword]);

        res.status(201).json({
            message: "Account created successfully."
        });

    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});
app.post("/api/logout", (req, res) => {
    req.session.destroy(error => {
        if (error) {
            return res.status(500).json({
                error: "Logout failed."
            });
        }

        res.json({
            message: "Logged out successfully."
        });
    });
});
app.listen(PORT, async () => {
    try {
        await query("SELECT 1");
        console.log(`Server running at http://localhost:${PORT}`);
        console.log("MySQL connected successfully!");
    } catch (error) {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log("MySQL connection failed:", error.message);
    }
});
