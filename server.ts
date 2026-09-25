import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

const PORT = 3000;
const DATA_DIR = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const AUDIT_LOGS_FILE = path.join(DATA_DIR, "audit_logs.json");
const EMPLOYEES_FILE = path.join(DATA_DIR, "employees.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error("Failed to create data directory:", err);
  }
}

/**
 * Primary User Schema adhering strictly to specifications:
 * - id: Primary Key
 * - name: String (User's full name from Google OAuth)
 * - email: String (Unique)
 * - status: Enum ['PENDING', 'APPROVED', 'REJECTED'] (Default: 'PENDING')
 * - role: Enum ['SUPER_ADMIN', 'HR_ADMIN', 'HR_MANAGER', 'EMPLOYEE'] (Default: NULL for new requests)
 * - requestDate: Timestamp (Auto-set on creation)
 * - statusUpdatedAt: Timestamp
 * - actionByUserId: Foreign Key (Tracks HR/Super Admin who approved or rejected)
 * - notificationUnread: Boolean (Default: true on status change)
 */
export interface StoredUser {
  id: string;
  uid?: string; // alias for backwards compatibility
  name: string;
  email: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "Pending" | "Approved" | "Rejected";
  role:
    | "SUPER_ADMIN"
    | "HR_ADMIN"
    | "HR_MANAGER"
    | "EMPLOYEE"
    | "Super Admin"
    | "HR Admin"
    | "HR Manager"
    | "Employee"
    | null
    | string;
  requestDate: string;
  requestedAt?: string; // alias
  statusUpdatedAt?: string;
  reviewedAt?: string; // alias
  actionByUserId?: string | null;
  reviewedBy?: string; // alias
  notificationUnread: boolean;
  employeeId?: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  action:
    | "Login Attempt"
    | "New Access Request Created"
    | "Request Approved"
    | "Request Rejected"
    | "Role Assigned"
    | "Role Changed"
    | "Logout"
    | string;
  targetUser: string;
  executedBy: string;
  details?: string;
}

// Initial default user store: Sushoovan Das as Approved Super Admin
const DEFAULT_USERS: StoredUser[] = [
  {
    id: "USR-Q94BIIQ5",
    uid: "USR-Q94BIIQ5",
    name: "Sushoovan Das",
    email: "sushoovandas@gmail.com",
    status: "APPROVED",
    role: "SUPER_ADMIN",
    requestDate: "2026-09-20T08:44:15.481Z",
    requestedAt: "2026-09-20T08:44:15.481Z",
    statusUpdatedAt: "2026-09-20T08:44:35.660Z",
    reviewedAt: "2026-09-20T08:44:35.660Z",
    actionByUserId: "SYS-ROOT",
    reviewedBy: "System Root",
    notificationUnread: false,
    employeeId: "MOD001",
  },
];

// Helper to normalize user status
function normalizeStatus(
  status?: string | null
): "PENDING" | "APPROVED" | "REJECTED" {
  if (!status) return "PENDING";
  const s = String(status).trim().toUpperCase();
  if (s === "APPROVED") return "APPROVED";
  if (s === "REJECTED") return "REJECTED";
  return "PENDING";
}

// Helper to normalize user role to standard uppercase or display
function normalizeRole(
  role?: string | null
): "SUPER_ADMIN" | "HR_ADMIN" | "HR_MANAGER" | "EMPLOYEE" | null {
  if (!role) return null;
  const upper = String(role).trim().toUpperCase();
  if (upper === "SUPER_ADMIN" || upper === "SUPER ADMIN" || upper === "SUPERADMIN") {
    return "SUPER_ADMIN";
  }
  if (upper === "HR_ADMIN" || upper === "HR ADMIN") {
    return "HR_ADMIN";
  }
  if (upper === "HR_MANAGER" || upper === "HR MANAGER") {
    return "HR_MANAGER";
  }
  if (upper === "EMPLOYEE") {
    return "EMPLOYEE";
  }
  return null;
}

// Helper to load users
function loadUsers(): StoredUser[] {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, "utf-8");
      const parsed: StoredUser[] = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((u) => {
          const id = u.id || u.uid || "USR-" + Math.random().toString(36).substring(2, 9);
          const reqDate = u.requestDate || u.requestedAt || new Date().toISOString();
          return {
            ...u,
            id,
            uid: u.uid || id,
            status: normalizeStatus(u.status),
            requestDate: reqDate,
            requestedAt: u.requestedAt || reqDate,
            statusUpdatedAt: u.statusUpdatedAt || u.reviewedAt,
            reviewedAt: u.reviewedAt || u.statusUpdatedAt,
            actionByUserId: u.actionByUserId || u.reviewedBy || null,
            reviewedBy: u.reviewedBy || u.actionByUserId,
            notificationUnread: u.notificationUnread ?? true,
          };
        });
      }
    }
  } catch (err) {
    console.error("Error reading users file, using defaults:", err);
  }
  saveUsers(DEFAULT_USERS);
  return DEFAULT_USERS;
}

// Helper to save users
function saveUsers(users: StoredUser[]) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing users file:", err);
  }
}

// Helper to load audit logs
function loadAuditLogs(): AuditLogEntry[] {
  try {
    if (fs.existsSync(AUDIT_LOGS_FILE)) {
      const raw = fs.readFileSync(AUDIT_LOGS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error("Error reading audit logs file:", err);
  }
  return [];
}

// Helper to save audit logs
function saveAuditLogs(logs: AuditLogEntry[]) {
  try {
    fs.writeFileSync(AUDIT_LOGS_FILE, JSON.stringify(logs, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing audit logs file:", err);
  }
}

// Helper to load employees
function loadEmployees(): any[] {
  try {
    if (fs.existsSync(EMPLOYEES_FILE)) {
      const raw = fs.readFileSync(EMPLOYEES_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error("Error reading employees file:", err);
  }
  return [];
}

// Helper to save employees
function saveEmployees(employees: any[]) {
  try {
    fs.writeFileSync(EMPLOYEES_FILE, JSON.stringify(employees, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing employees file:", err);
  }
}

// Log a key security event
function appendAuditLog(entry: {
  action: AuditLogEntry["action"];
  targetUser: string;
  executedBy: string;
  details?: string;
}): AuditLogEntry {
  const newEntry: AuditLogEntry = {
    id: "AUD-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6).toUpperCase(),
    timestamp: new Date().toISOString(),
    action: entry.action,
    targetUser: entry.targetUser,
    executedBy: entry.executedBy,
    details: entry.details || "",
  };

  const currentLogs = loadAuditLogs();
  currentLogs.unshift(newEntry);
  saveAuditLogs(currentLogs.slice(0, 500));
  return newEntry;
}

// Hierarchy helper functions
function isSuperAdminRole(role?: string | null): boolean {
  if (!role) return false;
  const upper = String(role).trim().toUpperCase();
  return upper === "SUPER_ADMIN" || upper === "SUPER ADMIN" || upper === "SUPERADMIN";
}

function isHRAdminRole(role?: string | null): boolean {
  if (!role) return false;
  const upper = String(role).trim().toUpperCase();
  return upper === "HR_ADMIN" || upper === "HR ADMIN" || upper === "ADMIN";
}

function isHRManagerRole(role?: string | null): boolean {
  if (!role) return false;
  const upper = String(role).trim().toUpperCase();
  return upper === "HR_MANAGER" || upper === "HR MANAGER";
}

function isAnyAdminRole(role?: string | null): boolean {
  return isSuperAdminRole(role) || isHRAdminRole(role) || isHRManagerRole(role);
}

// -------------------------------------------------------------
// JWT SESSION ENGINE (RFC 7519 Compliant HMAC-SHA256)
// -------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "modela-connect-jwt-secret-key-2026-strict-rbac";

interface JwtSessionClaims {
  sub: string;
  email: string;
  name: string;
  role: string | null;
  status: string;
  iat: number;
  exp: number;
}

function createJwtToken(payload: {
  sub: string;
  email: string;
  name: string;
  role: string | null;
  status: string;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7-day session validity
    })
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${claims}`)
    .digest("base64url");
  return `${header}.${claims}.${signature}`;
}

function verifyJwtToken(token: string): JwtSessionClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, claims, signature] = parts;
    const expectedSig = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${header}.${claims}`)
      .digest("base64url");
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf-8")) as JwtSessionClaims;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Extended Request with Authenticated User & Claims
interface AuthenticatedRequest extends Request {
  currentUser?: StoredUser;
  jwtClaims?: JwtSessionClaims;
}

// Server-side Authentication Middleware: validates JWT session state, user status ('APPROVED'), and role claims
function authenticateUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  let userEmail: string = "";
  let resolvedClaims: JwtSessionClaims | null = null;

  const authHeader = (req.headers["authorization"] as string) || "";
  const tokenHeader = (req.headers["x-user-token"] as string) || "";
  let bearerToken = "";

  if (authHeader.startsWith("Bearer ")) {
    bearerToken = authHeader.substring(7).trim();
  } else if (tokenHeader) {
    bearerToken = tokenHeader.trim();
  }

  // 1. Verify JWT session token if provided
  if (bearerToken) {
    resolvedClaims = verifyJwtToken(bearerToken);
    if (resolvedClaims && resolvedClaims.email) {
      userEmail = resolvedClaims.email;
    }
  }

  // 2. Fallback to verified x-user-email identity
  if (!userEmail) {
    userEmail = ((req.headers["x-user-email"] as string) || "").trim();
  }

  if (!userEmail) {
    return res.status(401).json({
      error: "Authentication Required",
      message: "No valid JWT session token or user identity provided in Authorization header.",
    });
  }

  const cleanEmail = userEmail.toLowerCase();
  const users = loadUsers();
  const matched = users.find((u) => u.email.toLowerCase() === cleanEmail);

  if (!matched) {
    return res.status(401).json({
      error: "User Not Found",
      message: `No user account found for ${cleanEmail}. Please sign in with Google.`,
    });
  }

  // 3. Enforce user status must strictly be 'APPROVED'
  const normStatus = normalizeStatus(matched.status);
  if (normStatus !== "APPROVED") {
    return res.status(403).json({
      error: "Access Denied",
      status: normStatus,
      message:
        normStatus === "PENDING"
          ? "Your request has been sent to the HR Admin. Please wait for approval."
          : "Your access request has been rejected by the HR Admin.",
    });
  }

  req.currentUser = matched;
  if (resolvedClaims) {
    req.jwtClaims = resolvedClaims;
  }
  next();
}

// Server-side Admin Authorization Middleware: prevents non-admin users from accessing admin routes
function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  authenticateUser(req, res, () => {
    if (!req.currentUser || !isAnyAdminRole(req.currentUser.role)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Administrative privileges (Super Admin / HR Admin) are required to access this endpoint.",
      });
    }
    next();
  });
}

// Server-side Super Admin Authorization Middleware: restricts sensitive actions exclusively to Super Admins
function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  authenticateUser(req, res, () => {
    if (!req.currentUser || !isSuperAdminRole(req.currentUser.role)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Super Admin authority is required for this action.",
      });
    }
    next();
  });
}

// Lazy Gemini SDK initialization
let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "modela-connect-build",
        },
      },
    });
  }
  return geminiClient;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // ---------------------------------------------
  // API Routes (mounted BEFORE Vite middleware)
  // ---------------------------------------------

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // -------------------------------------------------------------
  // 2. GOOGLE OAUTH & PENDING APPROVAL WORKFLOW
  // -------------------------------------------------------------
  app.post(["/api/auth/google", "/api/auth/login"], (req, res) => {
    const { email, name } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }

    // 1. Extract 'Name' and 'Email' ONLY from payload. Avatar URLs discarded.
    const cleanEmail = email.trim().toLowerCase();
    const cleanName =
      typeof name === "string" && name.trim() ? name.trim() : cleanEmail.split("@")[0];

    const users = loadUsers();
    const existingIndex = users.findIndex((u) => u.email.toLowerCase() === cleanEmail);

    // Case A: User does NOT exist in the database -> Create record with status = 'PENDING', role = NULL, requestDate = Current Time
    if (existingIndex === -1) {
      const nowIso = new Date().toISOString();
      const newId = "USR-" + Math.random().toString(36).substring(2, 10).toUpperCase();

      const newUser: StoredUser = {
        id: newId,
        uid: newId,
        name: cleanName,
        email: cleanEmail,
        status: "PENDING",
        role: null,
        requestDate: nowIso,
        requestedAt: nowIso,
        statusUpdatedAt: nowIso,
        actionByUserId: null,
        notificationUnread: true,
      };

      users.push(newUser);
      saveUsers(users);

      // Audit Log: New Access Request Created
      appendAuditLog({
        action: "New Access Request Created",
        targetUser: cleanEmail,
        executedBy: cleanEmail,
        details: `Initial access request submitted by ${cleanName} (${cleanEmail}). Status: PENDING, Role: NULL.`,
      });

      return res.status(200).json({
        success: true,
        case: "A",
        status: "PENDING",
        message: "Your request has been sent to the HR Admin. Please wait for approval.",
        user: newUser,
      });
    }

    const existing = users[existingIndex];
    const normStatus = normalizeStatus(existing.status);

    // Audit Log: Login Attempt
    appendAuditLog({
      action: "Login Attempt",
      targetUser: cleanEmail,
      executedBy: cleanEmail,
      details: `Google login attempt. Current status: ${normStatus}, Role: ${existing.role || "NULL"}`,
    });

    // Case B: User exists with Status 'PENDING'
    if (normStatus === "PENDING") {
      return res.status(200).json({
        success: false,
        case: "B",
        status: "PENDING",
        message: "Your request has been sent to the HR Admin. Please wait for approval.",
        user: existing,
      });
    }

    // Case C: User exists with Status 'REJECTED'
    if (normStatus === "REJECTED") {
      return res.status(200).json({
        success: false,
        case: "C",
        status: "REJECTED",
        message: "Your access request has been rejected by the HR Admin.",
        user: existing,
      });
    }

    // Case D: User exists with Status 'APPROVED'
    const sessionToken = createJwtToken({
      sub: existing.id || existing.uid,
      email: existing.email,
      name: existing.name,
      role: existing.role || "EMPLOYEE",
      status: "APPROVED",
    });

    return res.status(200).json({
      success: true,
      case: "D",
      status: "APPROVED",
      token: sessionToken,
      message: `Your account has been approved. Assigned Role: ${existing.role || "EMPLOYEE"}`,
      user: existing,
    });
  });

  // Check user status by email
  app.get("/api/auth/status", (req, res) => {
    const email = (req.query.email as string) || "";
    if (!email) {
      return res.status(400).json({ error: "Email query param required" });
    }

    const cleanEmail = email.trim().toLowerCase();
    const users = loadUsers();
    const user = users.find((u) => u.email.toLowerCase() === cleanEmail);

    if (!user) {
      return res.json({ success: true, status: "NotFound", user: null });
    }

    const normStatus = normalizeStatus(user.status);
    let sessionToken: string | undefined;
    if (normStatus === "APPROVED") {
      sessionToken = createJwtToken({
        sub: user.id || user.uid,
        email: user.email,
        name: user.name,
        role: user.role || "EMPLOYEE",
        status: "APPROVED",
      });
    }

    return res.json({
      success: true,
      status: normStatus,
      token: sessionToken,
      user,
    });
  });

  // Logout Endpoint with Audit Logging
  app.post("/api/auth/logout", (req, res) => {
    const { email } = req.body;
    const userEmail = email ? String(email).trim().toLowerCase() : "unknown";

    appendAuditLog({
      action: "Logout",
      targetUser: userEmail,
      executedBy: userEmail,
      details: "User initiated sign out session termination.",
    });

    return res.json({ success: true });
  });

  // -------------------------------------------------------------
  // 3. HR ADMIN & SUPER ADMIN MANAGEMENT INTERFACE (Strict RBAC)
  // -------------------------------------------------------------

  // Get all users (Admin only)
  app.get("/api/users", requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
    const users = loadUsers();
    return res.json({ success: true, users });
  });

  // Role Assignment & Approval Workflow:
  // "Approve & Assign Role" Action:
  // - Sets user.status = 'APPROVED'
  // - Sets user.role = Selected Role
  // - Sets user.notificationUnread = true
  // - Records auditor ID and timestamp
  app.post("/api/users/:uid/approve", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
    const { uid } = req.params;
    const { role } = req.body;
    const adminUser = req.currentUser!;

    let targetRole = String(role || "EMPLOYEE").trim().toUpperCase().replace(/\s+/g, "_");
    if (targetRole === "ADMIN") targetRole = "HR_ADMIN";
    if (targetRole === "SUPERADMIN") targetRole = "SUPER_ADMIN";
    const isTargetSuperAdmin = isSuperAdminRole(targetRole);

    // Strict Hierarchy Check: Only Super Admin can assign the Super Admin role
    if (isTargetSuperAdmin && !isSuperAdminRole(adminUser.role)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Only a Super Admin can assign or elevate to the Super Admin role.",
      });
    }

    const users = loadUsers();
    const index = users.findIndex(
      (u) =>
        u.id === uid ||
        u.uid === uid ||
        u.email.toLowerCase() === uid.toLowerCase()
    );

    if (index === -1) {
      return res.status(404).json({ error: "User not found" });
    }

    const targetUser = users[index];
    const previousRole = targetUser.role;
    const nowIso = new Date().toISOString();
    const auditorId = adminUser.id || adminUser.uid || adminUser.email;

    targetUser.status = "APPROVED";
    targetUser.role = targetRole;
    targetUser.statusUpdatedAt = nowIso;
    targetUser.reviewedAt = nowIso;
    targetUser.actionByUserId = auditorId;
    targetUser.reviewedBy = adminUser.email;
    targetUser.notificationUnread = true;

    saveUsers(users);

    // Audit Logging: Request Approved & Role Assigned
    appendAuditLog({
      action: "Request Approved",
      targetUser: targetUser.email,
      executedBy: adminUser.email,
      details: `Access request approved by ${adminUser.name} (${adminUser.email}). Assigned Role: ${targetRole}`,
    });

    appendAuditLog({
      action: "Role Assigned",
      targetUser: targetUser.email,
      executedBy: adminUser.email,
      details: `Role assigned: '${targetRole}' (previous: ${previousRole || "NULL"}) by auditor ${auditorId}`,
    });

    return res.json({ success: true, user: targetUser });
  });

  // "Reject Request" Action:
  // - Sets user.status = 'REJECTED'
  // - Sets user.notificationUnread = true
  // - Records auditor ID and timestamp
  app.post("/api/users/:uid/reject", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
    const { uid } = req.params;
    const adminUser = req.currentUser!;

    const users = loadUsers();
    const index = users.findIndex(
      (u) =>
        u.id === uid ||
        u.uid === uid ||
        u.email.toLowerCase() === uid.toLowerCase()
    );

    if (index === -1) {
      return res.status(404).json({ error: "User not found" });
    }

    const targetUser = users[index];

    // Strict Hierarchy Check: Cannot alter or reject Super Admin accounts
    if (isSuperAdminRole(targetUser.role)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Super Admin accounts cannot be rejected or modified by HR Admin.",
      });
    }

    const nowIso = new Date().toISOString();
    const auditorId = adminUser.id || adminUser.uid || adminUser.email;

    targetUser.status = "REJECTED";
    targetUser.statusUpdatedAt = nowIso;
    targetUser.reviewedAt = nowIso;
    targetUser.actionByUserId = auditorId;
    targetUser.reviewedBy = adminUser.email;
    targetUser.notificationUnread = true;

    saveUsers(users);

    // Audit Logging: Request Rejected
    appendAuditLog({
      action: "Request Rejected",
      targetUser: targetUser.email,
      executedBy: adminUser.email,
      details: `Access request rejected by ${adminUser.name} (${adminUser.email})`,
    });

    return res.json({ success: true, user: targetUser });
  });

  // Change Role on an existing user (Admin only, respecting hierarchy)
  app.post("/api/users/:uid/role", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
    const { uid } = req.params;
    const { role } = req.body;
    const adminUser = req.currentUser!;

    if (!role) {
      return res.status(400).json({ error: "Role is required" });
    }

    const users = loadUsers();
    const index = users.findIndex(
      (u) =>
        u.id === uid ||
        u.uid === uid ||
        u.email.toLowerCase() === uid.toLowerCase()
    );

    if (index === -1) {
      return res.status(404).json({ error: "User not found" });
    }

    const targetUser = users[index];

    // Hierarchy check: Non-superadmin cannot alter a superadmin or elevate anyone to superadmin
    if (isSuperAdminRole(targetUser.role) && !isSuperAdminRole(adminUser.role)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Super Admin accounts cannot be altered by HR Admin.",
      });
    }

    if (isSuperAdminRole(role) && !isSuperAdminRole(adminUser.role)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Only a Super Admin can elevate a user to Super Admin.",
      });
    }

    const oldRole = targetUser.role;
    const nowIso = new Date().toISOString();
    const auditorId = adminUser.id || adminUser.uid || adminUser.email;

    targetUser.role = role;
    targetUser.statusUpdatedAt = nowIso;
    targetUser.reviewedAt = nowIso;
    targetUser.actionByUserId = auditorId;
    targetUser.reviewedBy = adminUser.email;
    targetUser.notificationUnread = true;

    saveUsers(users);

    // Audit Logging: Role Changed
    appendAuditLog({
      action: "Role Changed",
      targetUser: targetUser.email,
      executedBy: adminUser.email,
      details: `Role updated from '${oldRole || "NULL"}' to '${role}' by ${adminUser.name}`,
    });

    return res.json({ success: true, user: targetUser });
  });

  // Mark notification as read for a user
  app.post("/api/users/:uid/mark-notification-read", (req: Request, res: Response) => {
    const { uid } = req.params;
    const users = loadUsers();
    const index = users.findIndex(
      (u) =>
        u.id === uid ||
        u.uid === uid ||
        u.email.toLowerCase() === uid.toLowerCase()
    );

    if (index !== -1) {
      users[index].notificationUnread = false;
      saveUsers(users);
      return res.json({ success: true, user: users[index] });
    }

    return res.status(404).json({ error: "User not found" });
  });

  // -------------------------------------------------------------
  // 4. AUDIT LOGS ENDPOINT (Admin only)
  // -------------------------------------------------------------
  app.get("/api/audit-logs", requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
    const logs = loadAuditLogs();
    return res.json({ success: true, logs });
  });

  // -------------------------------------------------------------
  // 5. EMPLOYEE DIRECTORY ENDPOINTS (Strict Admin Clearance Required)
  // -------------------------------------------------------------
  app.get("/api/employees", requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
    const emps = loadEmployees();
    return res.json({ success: true, employees: emps });
  });

  app.post("/api/employees", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
    const newEmp = req.body;
    if (!newEmp || !newEmp.firstName) {
      return res.status(400).json({ error: "Invalid employee data" });
    }
    const emps = loadEmployees();
    const id = newEmp.id || "MOD" + String(emps.length + 1).padStart(3, "0");
    const record = { ...newEmp, id, status: newEmp.status || "ACTIVE" };
    emps.unshift(record);
    saveEmployees(emps);
    appendAuditLog({
      action: "Employee Created",
      targetUser: `${record.firstName} ${record.lastName}`,
      executedBy: req.currentUser!.email,
      details: `New employee created: ${record.id} - ${record.designation}`,
    });
    return res.status(201).json({ success: true, employee: record });
  });

  app.put("/api/employees/:id", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const emps = loadEmployees();
    const idx = emps.findIndex((e) => e.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: "Employee not found" });
    }
    emps[idx] = { ...emps[idx], ...req.body, id };
    saveEmployees(emps);
    appendAuditLog({
      action: "Employee Updated",
      targetUser: `${emps[idx].firstName} ${emps[idx].lastName}`,
      executedBy: req.currentUser!.email,
      details: `Employee profile updated for ${id}`,
    });
    return res.json({ success: true, employee: emps[idx] });
  });

  app.delete("/api/employees/:id", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    let emps = loadEmployees();
    const target = emps.find((e) => e.id === id);
    if (!target) {
      return res.status(404).json({ error: "Employee not found" });
    }
    emps = emps.filter((e) => e.id !== id);
    saveEmployees(emps);
    appendAuditLog({
      action: "Employee Deleted",
      targetUser: `${target.firstName || id} ${target.lastName || ""}`,
      executedBy: req.currentUser!.email,
      details: `Employee ${id} deleted by ${req.currentUser!.name}`,
    });
    return res.json({ success: true });
  });

  // -------------------------------------------------------------
  // 5. PROTECTED GEMINI AI WORKSPACE (Approved users only)
  // -------------------------------------------------------------
  app.post("/api/gemini/chat", authenticateUser, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { message, history = [] } = req.body;

      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message is required" });
      }

      const ai = getGemini();
      if (!ai) {
        return res.status(500).json({
          error: "Gemini API key is not configured.",
          message: "Please ensure GEMINI_API_KEY is configured in the environment settings.",
        });
      }

      const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

      if (Array.isArray(history)) {
        for (const item of history.slice(-8)) {
          if (item.sender === "user" && item.text) {
            contents.push({ role: "user", parts: [{ text: item.text }] });
          } else if (item.sender === "assistant" && item.text) {
            contents.push({ role: "model", parts: [{ text: item.text }] });
          }
        }
      }

      contents.push({ role: "user", parts: [{ text: message }] });

      const startTime = Date.now();
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents,
        config: {
          systemInstruction:
            "You are Modela Connect Intelligence, an enterprise HRMS & operations assistant powered by Google Gemini. " +
            "You provide clear, accurate, professional guidance on human resources, organizational workflows, " +
            "compliance, employee performance, payroll logic, and enterprise software engineering.",
          temperature: 0.7,
        },
      });

      const latencyMs = Date.now() - startTime;
      const responseText = response.text || "No response generated by model.";

      return res.json({
        success: true,
        reply: responseText,
        model: "gemini-3.8-flash",
        latencyMs,
      });
    } catch (err: any) {
      console.error("Gemini API error:", err);
      return res.status(500).json({
        error: "Gemini Generation Failed",
        details: err?.message || "Unknown error communicating with Gemini API",
      });
    }
  });

  // ---------------------------------------------
  // Vite Integration (development vs production)
  // ---------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Modela Connect Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
