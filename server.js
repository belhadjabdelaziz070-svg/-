const express = require("express");
const session = require("express-session");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const XLSX = require("xlsx");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const rootDir = __dirname;
const uploadDir = path.join(rootDir, "uploads");
const downloadsDir = path.join(rootDir, "downloads");
const dbDir = path.join(rootDir, "db");
const dbFile = path.join(dbDir, "aadl.db");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(downloadsDir, { recursive: true });
fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(dbFile);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, file, callback) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const time = Date.now();
      callback(null, `${time}_${safeName}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadDir));
app.use(express.static(path.join(rootDir, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "aadl3-platform-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function buildTrackingNumber() {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `AADL3-${Date.now().toString().slice(-6)}-${suffix}`;
}

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS applicants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_number TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      date_of_birth TEXT,
      national_id_number TEXT,
      phone_number TEXT,
      secondary_phone TEXT,
      email_address TEXT,
      wilaya TEXT,
      municipality TEXT,
      aadl_registration_number TEXT,
      housing_type TEXT,
      application_status TEXT DEFAULT 'New application',
      registration_date TEXT,
      current_application_problem TEXT,
      employment_status TEXT,
      monthly_income TEXT,
      marital_status TEXT,
      spouse_information TEXT,
      notes TEXT,
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_id INTEGER,
      document_name TEXT,
      original_name TEXT,
      file_path TEXT,
      uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(applicant_id) REFERENCES applicants(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_id INTEGER,
      event_type TEXT,
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(applicant_id) REFERENCES applicants(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const adminUser = await get("SELECT id FROM admin_users WHERE username = ?", ["admin"]);
  if (!adminUser) {
    const hash = await bcrypt.hash("Admin@123", 10);
    await run("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)", ["admin", hash]);
  }
}

async function logNotification(applicantId, eventType, message) {
  await run(
    "INSERT INTO notifications (applicant_id, event_type, message) VALUES (?, ?, ?)",
    [applicantId, eventType, message]
  );
}

async function sendStatusEmail(emailAddress, status, trackingNumber) {
  if (!emailAddress) {
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "localhost",
      port: Number(process.env.SMTP_PORT || 1025),
      secure: false,
      ignoreTLS: true
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || "noreply@aadl3-algeria.local",
      to: emailAddress,
      subject: "Mise à jour de votre dossier AADL 3",
      text: `Bonjour,\n\nLe statut de votre dossier AADL 3 a été mis à jour.\nNuméro de suivi: ${trackingNumber}\nNouveau statut: ${status}\nMerci de suivre votre dossier sur la plateforme AADL 3.`
    });
  } catch (error) {
    console.warn("Email notification failed:", error.message);
  }
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ error: "Unauthorized access to admin dashboard." });
  }
  return next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "AADL 3 housing platform" });
});

app.get("/api/admin/session", (req, res) => {
  if (!req.session || !req.session.admin) {
    return res.json({ authenticated: false });
  }

  return res.json({
    authenticated: true,
    user: {
      username: req.session.admin.username
    }
  });
});

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const adminUser = await get("SELECT * FROM admin_users WHERE username = ?", [username]);
  if (!adminUser) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const passwordMatches = await bcrypt.compare(password, adminUser.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  req.session.admin = {
    id: adminUser.id,
    username: adminUser.username
  };

  return res.json({ success: true, message: "Admin access granted." });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true, message: "Logged out successfully." });
  });
});

app.post("/api/register", upload.array("documents", 10), async (req, res) => {
  try {
    const body = req.body || {};
    const requiredFields = [
      "first_name",
      "last_name",
      "date_of_birth",
      "national_id_number",
      "phone_number",
      "email_address",
      "wilaya",
      "municipality",
      "aadl_registration_number",
      "housing_type",
      "registration_date",
      "employment_status",
      "monthly_income",
      "marital_status"
    ];

    const missing = requiredFields.filter((field) => !body[field] || String(body[field]).trim() === "");
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Please complete all required fields.",
        missing
      });
    }

    const duplicate = await get(
      "SELECT id FROM applicants WHERE national_id_number = ? OR phone_number = ?",
      [body.national_id_number, body.phone_number]
    );

    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: "A submission already exists for this national ID or phone number."
      });
    }

    const trackingNumber = buildTrackingNumber();
    const applicationStatus = body.application_status || "New application";
    const createdAt = new Date().toISOString();

    const insertResult = await run(
      `INSERT INTO applicants (
        tracking_number,
        first_name,
        last_name,
        date_of_birth,
        national_id_number,
        phone_number,
        secondary_phone,
        email_address,
        wilaya,
        municipality,
        aadl_registration_number,
        housing_type,
        application_status,
        registration_date,
        current_application_problem,
        employment_status,
        monthly_income,
        marital_status,
        spouse_information,
        notes,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trackingNumber,
        body.first_name,
        body.last_name,
        body.date_of_birth,
        body.national_id_number,
        body.phone_number,
        body.secondary_phone || "",
        body.email_address,
        body.wilaya,
        body.municipality,
        body.aadl_registration_number,
        body.housing_type,
        applicationStatus,
        body.registration_date,
        body.current_application_problem || "",
        body.employment_status,
        body.monthly_income,
        body.marital_status,
        body.spouse_information || "",
        "",
        createdAt,
        createdAt
      ]
    );

    const applicantId = insertResult.id;
    const uploadedFiles = req.files || [];

    for (const file of uploadedFiles) {
      const documentName = file.fieldname || "document";
      const storedPath = `/uploads/${file.filename}`;
      await run(
        "INSERT INTO documents (applicant_id, document_name, original_name, file_path) VALUES (?, ?, ?, ?)",
        [applicantId, documentName, file.originalname, storedPath]
      );
    }

    await logNotification(
      applicantId,
      "application_created",
      `Application created successfully. Tracking number: ${trackingNumber}.`
    );

    return res.status(201).json({
      success: true,
      message: "Votre demande a été enregistrée avec succès.",
      tracking_number: trackingNumber,
      applicant_id: applicantId
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ success: false, error: "Unable to process the registration." });
  }
});

app.get("/api/tracking/:trackingNumber", async (req, res) => {
  try {
    const applicant = await get(
      "SELECT * FROM applicants WHERE tracking_number = ? AND archived = 0",
      [req.params.trackingNumber]
    );

    if (!applicant) {
      return res.status(404).json({
        success: false,
        error: "Tracking number not found."
      });
    }

    const notifications = await all(
      "SELECT * FROM notifications WHERE applicant_id = ? ORDER BY created_at DESC",
      [applicant.id]
    );

    const documents = await all(
      "SELECT * FROM documents WHERE applicant_id = ? ORDER BY uploaded_at DESC",
      [applicant.id]
    );

    return res.json({
      success: true,
      data: {
        ...applicant,
        documents,
        notifications
      }
    });
  } catch (error) {
    console.error("Tracking error:", error);
    return res.status(500).json({ success: false, error: "Unable to retrieve tracking details." });
  }
});

app.get("/api/admin/applications", requireAdmin, async (req, res) => {
  try {
    const { search, wilaya, housingType, status } = req.query || {};
    let sql = "SELECT * FROM applicants WHERE archived = 0";
    const params = [];

    if (search && String(search).trim()) {
      sql += " AND (first_name LIKE ? OR last_name LIKE ? OR phone_number LIKE ? OR tracking_number LIKE ?)";
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    if (wilaya && String(wilaya).trim()) {
      sql += " AND wilaya = ?";
      params.push(wilaya);
    }

    if (housingType && String(housingType).trim()) {
      sql += " AND housing_type = ?";
      params.push(housingType);
    }

    if (status && String(status).trim()) {
      sql += " AND application_status = ?";
      params.push(status);
    }

    sql += " ORDER BY created_at DESC";

    const applications = await all(sql, params);

    const results = await Promise.all(
      applications.map(async (item) => {
        const documents = await all("SELECT * FROM documents WHERE applicant_id = ?", [item.id]);
        return {
          ...item,
          documents_count: documents.length
        };
      })
    );

    return res.json({ success: true, data: results });
  } catch (error) {
    console.error("List applications error:", error);
    return res.status(500).json({ success: false, error: "Unable to list applications." });
  }
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const totalRegistrations = await get("SELECT COUNT(*) AS total FROM applicants WHERE archived = 0");
    const pending = await get("SELECT COUNT(*) AS total FROM applicants WHERE archived = 0 AND application_status IN ('New application', 'Under review', 'Processing', 'Documents required')");
    const accepted = await get("SELECT COUNT(*) AS total FROM applicants WHERE archived = 0 AND application_status = 'Accepted'");
    const rejected = await get("SELECT COUNT(*) AS total FROM applicants WHERE archived = 0 AND application_status = 'Rejected'");

    const byWilaya = await all(
      "SELECT wilaya, COUNT(*) AS total FROM applicants WHERE archived = 0 GROUP BY wilaya ORDER BY total DESC LIMIT 10"
    );

    const dailyRegistrations = await all(
      "SELECT date(created_at) AS label, COUNT(*) AS total FROM applicants WHERE archived = 0 GROUP BY date(created_at) ORDER BY created_at DESC LIMIT 7"
    );

    const monthlyRegistrations = await all(
      "SELECT strftime('%Y-%m', created_at) AS label, COUNT(*) AS total FROM applicants WHERE archived = 0 GROUP BY strftime('%Y-%m', created_at) ORDER BY label DESC LIMIT 12"
    );

    const statusBreakdown = await all(
      "SELECT application_status AS label, COUNT(*) AS total FROM applicants WHERE archived = 0 GROUP BY application_status ORDER BY total DESC"
    );

    return res.json({
      success: true,
      data: {
        total_registrations: totalRegistrations.total,
        pending_applications: pending.total,
        accepted_applications: accepted.total,
        rejected_applications: rejected.total,
        by_wilaya: byWilaya,
        daily_registrations: dailyRegistrations,
        monthly_registrations: monthlyRegistrations,
        status_breakdown: statusBreakdown
      }
    });
  } catch (error) {
    console.error("Stats error:", error);
    return res.status(500).json({ success: false, error: "Unable to calculate statistics." });
  }
});

app.get("/api/admin/export", requireAdmin, async (_req, res) => {
  try {
    const applications = await all(
      "SELECT * FROM applicants WHERE archived = 0 ORDER BY created_at DESC"
    );

    const rows = applications.map((app) => ({
      tracking_number: app.tracking_number,
      first_name: app.first_name,
      last_name: app.last_name,
      date_of_birth: app.date_of_birth,
      national_id_number: app.national_id_number,
      phone_number: app.phone_number,
      secondary_phone: app.secondary_phone,
      email_address: app.email_address,
      wilaya: app.wilaya,
      municipality: app.municipality,
      aadl_registration_number: app.aadl_registration_number,
      housing_type: app.housing_type,
      application_status: app.application_status,
      registration_date: app.registration_date,
      monthly_income: app.monthly_income,
      marital_status: app.marital_status,
      created_at: app.created_at
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "AADL_Clients");

    const filePath = path.join(downloadsDir, `aadl_export_${Date.now()}.xlsx`);
    XLSX.writeFile(workbook, filePath);

    return res.download(filePath, "aadl_clients_export.xlsx", (error) => {
      if (error) {
        console.error("Excel export failed:", error);
      }
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (error) {
    console.error("Export error:", error);
    return res.status(500).json({ success: false, error: "Unable to export applicant data." });
  }
});

app.put("/api/admin/applications/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const fields = [];
    const values = [];

    [
      "first_name",
      "last_name",
      "date_of_birth",
      "national_id_number",
      "phone_number",
      "secondary_phone",
      "email_address",
      "wilaya",
      "municipality",
      "aadl_registration_number",
      "housing_type",
      "application_status",
      "registration_date",
      "current_application_problem",
      "employment_status",
      "monthly_income",
      "marital_status",
      "spouse_information",
      "notes"
    ].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(payload[field]);
      }
    });

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: "No valid application fields supplied." });
    }

    values.push(new Date().toISOString());
    values.push(id);

    const result = await run(
      `UPDATE applicants SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`,
      values
    );

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: "Application not found." });
    }

    const applicant = await get("SELECT * FROM applicants WHERE id = ?", [id]);
    if (applicant && payload.application_status) {
      await logNotification(
        applicant.id,
        "status_update",
        `Application status changed to ${payload.application_status}.`
      );
      await sendStatusEmail(applicant.email_address, payload.application_status, applicant.tracking_number);
    }

    return res.json({ success: true, message: "Application updated successfully." });
  } catch (error) {
    console.error("Update application error:", error);
    return res.status(500).json({ success: false, error: "Unable to update the application." });
  }
});

app.delete("/api/admin/applications/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { archive } = req.query;

    if (archive === "true") {
      await run("UPDATE applicants SET archived = 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), id]);
      return res.json({ success: true, message: "Application archived successfully." });
    }

    await run("DELETE FROM documents WHERE applicant_id = ?", [id]);
    await run("DELETE FROM notifications WHERE applicant_id = ?", [id]);
    await run("DELETE FROM applicants WHERE id = ?", [id]);

    return res.json({ success: true, message: "Application deleted successfully." });
  } catch (error) {
    console.error("Delete application error:", error);
    return res.status(500).json({ success: false, error: "Unable to delete or archive the application." });
  }
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(rootDir, "public", "admin.html"));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(rootDir, "public", "index.html"));
});

async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`AADL 3 platform listening on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
