// server.js
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const cors = require("cors");
const basicAuth = require("express-basic-auth");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());

// ===== Database =====
const db = new sqlite3.Database("./bookings.db");

db.run(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    slot INTEGER NOT NULL,
    name TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    status TEXT DEFAULT 'booked',
    UNIQUE(date, slot)
  )
`);

// ===== Slots =====
const slots = {
  1: "9:00 AM - 12:00 PM",
  2: "12:00 PM - 3:00 PM",
  3: "3:00 PM - 6:00 PM",
};

// ===== Admin Auth =====
const ADMIN_USER = process.env.ADMIN_USER || "allkeys";
const ADMIN_PASS = process.env.ADMIN_PASS || "seadog";

const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
});

// ===== Email (Resend) - optional =====
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "";
const OWNER_NOTIFY_EMAIL = process.env.OWNER_NOTIFY_EMAIL || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !FROM_EMAIL || !to) return;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to,
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn("Resend email failed", resp.status, text);
    }
  } catch (e) {
    console.warn("Resend email error", e.message || e);
  }
}

function esc(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;");
}

function slotLabel(slot) {
  return slots[String(slot)] || `Slot ${slot}`;
}

// ===== Debug ping =====
app.get("/__ping", (req, res) => {
  res.type("text").send("PING-123");
});

// ===== ADMIN ROUTES (MUST BE BEFORE static) =====
app.get("/admin", adminAuth, (req, res) => {
  res.redirect("/admin.html");
});

app.get("/admin.html", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ===== Availability =====
app.get("/availability", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "Missing date" });

  db.all(
    "SELECT slot FROM bookings WHERE date = ? AND status = 'booked'",
    [date],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });

      const booked = rows.map((r) => r.slot);
      const availability = Object.keys(slots).map((s) => ({
        slot: Number(s),
        label: slots[s],
        available: !booked.includes(Number(s)),
      }));

      res.json(availability);
    },
  );
});

// ===== Book Slot =====
app.post("/book", (req, res) => {
  const { date, slot, name, phone, email, address, notes } = req.body;

  db.run(
    `
    INSERT INTO bookings (date, slot, name, phone, email, address, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [date, slot, name, phone, email, address, notes],
    async function (err) {
      if (err) return res.status(400).json({ error: "Slot already booked" });

      const bookingId = this.lastID;

      // Email owner
      if (OWNER_NOTIFY_EMAIL) {
        const ownerHtml = `
          <h3>New Booking</h3>
          <p><b>ID:</b> ${esc(bookingId)}</p>
          <p><b>Date:</b> ${esc(date)}</p>
          <p><b>Slot:</b> ${esc(slotLabel(slot))}</p>
          <p><b>Name:</b> ${esc(name)}</p>
          <p><b>Phone:</b> ${esc(phone)}</p>
          <p><b>Address:</b> ${esc(address)}</p>
          <p><b>Notes:</b> ${esc(notes)}</p>
          <p><a href="${esc(PUBLIC_BASE_URL)}/admin">Open Admin</a></p>
        `;
        await sendEmail({
          to: OWNER_NOTIFY_EMAIL,
          subject: `New Booking: ${date} • ${slotLabel(slot)} • ${name || "No Name"}`,
          html: ownerHtml,
        });
      }

      // Customer email (if provided)
      if (email) {
        const custHtml = `
          <h3>Booking Confirmed</h3>
          <p><b>Date:</b> ${esc(date)}</p>
          <p><b>Slot:</b> ${esc(slotLabel(slot))}</p>
          <p>If you need to change this booking, call/text us.</p>
        `;
        await sendEmail({
          to: email,
          subject: "Your trailer repair booking is confirmed",
          html: custHtml,
        });
      }

      res.json({ success: true, id: bookingId });
    },
  );
});

// ===== Admin APIs (ROUTE-LEVEL PROTECTED) =====
app.get("/admin/bookings", adminAuth, (req, res) => {
  const { date } = req.query;

  const sql = date
    ? "SELECT * FROM bookings WHERE date = ? ORDER BY date, slot"
    : "SELECT * FROM bookings ORDER BY date, slot";

  const params = date ? [date] : [];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json(rows);
  });
});

app.post("/admin/cancel", adminAuth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });

  db.get("SELECT * FROM bookings WHERE id = ?", [id], async (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Not found" });

    db.run(
      "UPDATE bookings SET status = 'canceled' WHERE id = ?",
      [id],
      async (uErr) => {
        if (uErr) return res.status(500).json({ error: "DB error" });

        // emails
        if (OWNER_NOTIFY_EMAIL) {
          const ownerHtml = `
          <h3>Booking Canceled</h3>
          <p><b>ID:</b> ${esc(row.id)}</p>
          <p><b>Date:</b> ${esc(row.date)}</p>
          <p><b>Slot:</b> ${esc(slotLabel(row.slot))}</p>
          <p><b>Name:</b> ${esc(row.name)}</p>
        `;
          await sendEmail({
            to: OWNER_NOTIFY_EMAIL,
            subject: `Canceled: ${row.date} • ${slotLabel(row.slot)} • ${row.name || "No Name"}`,
            html: ownerHtml,
          });
        }

        if (row.email) {
          const custHtml = `
          <h3>Your booking was canceled</h3>
          <p><b>Date:</b> ${esc(row.date)}</p>
          <p><b>Slot:</b> ${esc(slotLabel(row.slot))}</p>
        `;
          await sendEmail({
            to: row.email,
            subject: "Your booking was canceled",
            html: custHtml,
          });
        }

        res.json({ success: true });
      },
    );
  });
});

// ===== Admin: Complete booking =====
app.post("/admin/complete", adminAuth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });

  db.get("SELECT * FROM bookings WHERE id = ?", [id], async (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Not found" });

    db.run(
      "UPDATE bookings SET status = 'completed' WHERE id = ?",
      [id],
      async (uErr) => {
        if (uErr) return res.status(500).json({ error: "DB error" });

        // owner email
        if (OWNER_NOTIFY_EMAIL) {
          const ownerHtml = `
          <h3>Booking Completed</h3>
          <p><b>ID:</b> ${esc(row.id)}</p>
          <p><b>Date:</b> ${esc(row.date)}</p>
          <p><b>Slot:</b> ${esc(slotLabel(row.slot))}</p>
          <p><b>Name:</b> ${esc(row.name)}</p>
        `;
          await sendEmail({
            to: OWNER_NOTIFY_EMAIL,
            subject: `Completed: ${row.date} • ${slotLabel(row.slot)} • ${row.name || "No Name"}`,
            html: ownerHtml,
          });
        }

        // optionally email customer that job marked complete
        if (row.email) {
          const custHtml = `
          <h3>Your booking was completed</h3>
          <p><b>Date:</b> ${esc(row.date)}</p>
          <p><b>Slot:</b> ${esc(slotLabel(row.slot))}</p>
        `;
          await sendEmail({
            to: row.email,
            subject: "Your booking was completed",
            html: custHtml,
          });
        }

        res.json({ success: true });
      },
    );
  });
});

// ===== Static Files (ABSOLUTELY LAST) =====
app.use(express.static("public"));

// ===== Start =====
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
