// App.jsx
import React, { useEffect, useMemo, useState, useRef } from "react";
import axios from "axios";

/*
  Admin single-file frontend (App.jsx)
  - Tabs: Dashboard, Users, Tasks, Withdrawals, Settings
  - Secure-ish axios instance with interceptor (Authorization header)
  - Token stored in memory; optional sessionStorage as fallback
  - Simple input sanitization and confirmation dialogs
  - Retry with exponential backoff for network errors
  - Guarded admin routes (requires token & server validation)
  - Comments in Somali for faham degdeg ah
*/

/* =======================
   KONFIGA / DEFAULTS
   ======================= */
const DEFAULT_API = (import.meta && import.meta.env && import.meta.env.VITE_API_URL) || process.env.REACT_APP_API_URL || "https://your-backend.example.com";
const ADMIN_TOKEN_KEY = "task_admin_token_v1"; // sessionStorage key (optional fallback)

/* =======================
   UTIL: Xaqiijin iyo Helpers
   ======================= */
// Nadiifi input (basic)
function sanitize(str = "") {
  return String(str).replace(/[\u0000-\u001F<>]/g, "").trim();
}

// Exponential backoff retry helper
async function retryWithBackoff(fn, retries = 3, baseDelay = 400) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const shouldRetry = err && (!err.response || (err.response && err.response.status >= 500));
      if (!shouldRetry || attempt > retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 100;
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

/* =======================
   AXIOS INSTANCE (SECURE PATTERN)
   - Adds admin-token header from memory
   - Adds common security headers
   - Timeout + response handling
   ======================= */
function createAdminAxios(getToken) {
  const a = axios.create({
    baseURL: DEFAULT_API,
    timeout: 12_000, // 12s
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest", // CSRF hint
    },
  });

  // Attach token on requests
  a.interceptors.request.use((config) => {
    const t = getToken();
    if (t) {
      config.headers["Authorization"] = `Bearer ${t}`;
      // small anti-replay hint header (timestamp)
      config.headers["X-Client-Ts"] = Date.now();
    }
    return config;
  });

  // Optional: central error handler
  a.interceptors.response.use(
    (res) => res,
    (err) => {
      // If 401 -> token invalid: throw special error
      if (err.response && err.response.status === 401) {
        err.isUnauthorized = true;
      }
      return Promise.reject(err);
    }
  );

  return a;
}

/* =======================
   MAIN APP
   ======================= */
export default function App() {
  // token stored in memory (preferred)
  const tokenRef = useRef(null);

  // UI state
  const [ready, setReady] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [adminUser, setAdminUser] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard"); // dashboard | users | tasks | withdrawals | settings
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [dangerConfirm, setDangerConfirm] = useState(null); // { action: fn, text }
  const [users, setUsers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");

  // token getter
  const getToken = () => tokenRef.current;

  // axios instance
  const api = useMemo(() => createAdminAxios(getToken), []);

  /* =======================
     AUTH: Load token from sessionStorage optionally and validate with server
     - For best security: set token via backend (httpOnly cookie). Frontend uses in-memory token only.
     ======================= */
  useEffect(() => {
    // Load optional session token (if admin previously chose remember)
    try {
      const maybe = sessionStorage.getItem(ADMIN_TOKEN_KEY);
      if (maybe) {
        tokenRef.current = sanitize(maybe);
      }
    } catch (e) {
      console.warn("sessionStorage error", e);
    }

    // validate token if exists
    (async () => {
      if (!tokenRef.current) {
        setAuthChecked(true);
        setReady(true);
        return;
      }
      setLoading(true);
      try {
        const res = await retryWithBackoff(() => api.get("/admin/me"), 2);
        setAdminUser(res.data?.admin || { name: "admin" });
      } catch (err) {
        console.warn("Token validation failed:", err);
        // token invalid -> clear
        tokenRef.current = null;
        try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch {}
        setMessage("Token invalid, fadlan login mar kale.");
      } finally {
        setLoading(false);
        setAuthChecked(true);
        setReady(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* =======================
     AUTH: Login & Logout
     ======================= */
  const handleLogin = async (secret, remember = false) => {
    secret = sanitize(secret);
    if (!secret) return setMessage("Fadlan geli token ama sirta admin-ka.");

    setLoading(true);
    setMessage(null);
    try {
      // send to backend to exchange for session token and validate
      const res = await retryWithBackoff(() => api.post("/admin/auth", { secret }), 2);
      const token = res.data?.token;
      if (!token) throw new Error("No token received");
      // store token in memory
      tokenRef.current = token;
      // Optional session persistence (sessionStorage only)
      if (remember) {
        try { sessionStorage.setItem(ADMIN_TOKEN_KEY, token); } catch {}
      } else {
        try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch {}
      }
      // fetch profile
      const me = await api.get("/admin/me");
      setAdminUser(me.data.admin || { name: "admin" });
      setAuthChecked(true);
      setMessage("Ku soo dhawoow admin.");
    } catch (err) {
      console.error(err);
      setMessage(err?.response?.data?.message || "Login failed. Hubi tokenka.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    // clear memory + session
    tokenRef.current = null;
    try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch {}
    setAdminUser(null);
    setMessage("Waa lagaa saaray (logged out).");
    setActiveTab("dashboard");
  };

  /* =======================
     DATA LOADERS
     - Each loader uses retry/backoff
     ======================= */
  const loadUsers = async () => {
    setLoading(true);
    try {
      const res = await retryWithBackoff(() => api.get("/admin/users"), 2);
      setUsers(Array.isArray(res.data) ? res.data : res.data.users || []);
    } catch (err) {
      console.error("loadUsers", err);
      setMessage("Ma la soo bixi karo liiska users. Eeg console.");
    } finally {
      setLoading(false);
    }
  };

  const loadTasks = async () => {
    setLoading(true);
    try {
      const res = await retryWithBackoff(() => api.get("/admin/tasks"), 2);
      setTasks(Array.isArray(res.data) ? res.data : res.data.tasks || []);
    } catch (err) {
      console.error("loadTasks", err);
      setMessage("Ma la soo bixi karo liiska tasks. Eeg console.");
    } finally {
      setLoading(false);
    }
  };

  const loadWithdrawals = async () => {
    setLoading(true);
    try {
      const res = await retryWithBackoff(() => api.get("/admin/withdrawals"), 2);
      setWithdrawals(Array.isArray(res.data) ? res.data : res.data.withdrawals || []);
    } catch (err) {
      console.error("loadWithdrawals", err);
      setMessage("Ma la soo bixi karo liiska withdrawals. Eeg console.");
    } finally {
      setLoading(false);
    }
  };

  // Load relevant data when tab changes
  useEffect(() => {
    if (!authChecked || !getToken()) return;
    if (activeTab === "users") loadUsers();
    if (activeTab === "tasks") loadTasks();
    if (activeTab === "withdrawals") loadWithdrawals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, authChecked]);

  /* =======================
     ADMIN ACTIONS
     - banUser, unbanUser, approveWithdraw, rejectWithdraw, addTask
     - All actions prompt confirmation and sanitize inputs
     ======================= */
  const banUser = async (userId) => {
    if (!userId) return;
    setDangerConfirm({
      text: `Ma hubtaa inaad ban garaynayso user ${userId}? Tani waa irreversible.`,
      action: async () => {
        setDangerConfirm(null);
        setLoading(true);
        try {
          await retryWithBackoff(() => api.post("/admin/user/ban", { userId: sanitize(userId) }), 2);
          setMessage("User waa la banned/garay.");
          await loadUsers();
        } catch (err) {
          console.error(err);
          setMessage("Cilad ayaa dhacday markii la isku dayay in la ban-gareeyo.");
        } finally { setLoading(false); }
      },
    });
  };

  const unbanUser = async (userId) => {
    if (!userId) return;
    setDangerConfirm({
      text: `Ma hubtaa inaad unban garaynayso user ${userId}?`,
      action: async () => {
        setDangerConfirm(null);
        setLoading(true);
        try {
          await retryWithBackoff(() => api.post("/admin/user/unban", { userId: sanitize(userId) }), 2);
          setMessage("User waa la unbanned.");
          await loadUsers();
        } catch (err) {
          console.error(err);
          setMessage("Cilad ayaa dhacday markii la isku dayay in la unban-gareeyo.");
        } finally { setLoading(false); }
      },
    });
  };

  const approveWithdraw = async (wid) => {
    if (!wid) return;
    setDangerConfirm({
      text: `Approve payment id=${wid}? Xaqiiji marka lacagta la bixiyo.`,
      action: async () => {
        setDangerConfirm(null);
        setLoading(true);
        try {
          await retryWithBackoff(() => api.post("/admin/withdraw/approve", { id: sanitize(wid) }), 2);
          setMessage("Withdrawal approved.");
          await loadWithdrawals();
        } catch (err) {
          console.error(err);
          setMessage("Cilad markii la isku dayay approve.");
        } finally { setLoading(false); }
      },
    });
  };

  const rejectWithdraw = async (wid, reason = "") => {
    if (!wid) return;
    setDangerConfirm({
      text: `Reject payment id=${wid}? Sababta: ${reason || "No reason provided"}`,
      action: async () => {
        setDangerConfirm(null);
        setLoading(true);
        try {
          await retryWithBackoff(() => api.post("/admin/withdraw/reject", { id: sanitize(wid), reason: sanitize(reason) }), 2);
          setMessage("Withdrawal rejected.");
          await loadWithdrawals();
        } catch (err) {
          console.error(err);
          setMessage("Cilad markii la isku dayay reject.");
        } finally { setLoading(false); }
      },
    });
  };

  const addTask = async (title, description, reward) => {
    title = sanitize(title);
    description = sanitize(description);
    reward = Number(reward) || 0;
    if (!title || reward <= 0) return setMessage("Fadlan geli title sax ah iyo reward ka weyn 0.");
    setLoading(true);
    try {
      await retryWithBackoff(() => api.post("/admin/task/add", { title, description, reward }), 2);
      setMessage("Task cusub waa la abuuray.");
      await loadTasks();
    } catch (err) {
      console.error(err);
      setMessage("Cilad markii la isku dayay in la abuuro task.");
    } finally { setLoading(false); }
  };

  /* =======================
     UI: small helpers
     ======================= */
  const filteredUsers = users.filter(u =>
    (u.email || u.name || u.id || "")
      .toLowerCase()
      .includes(searchQuery.toLowerCase().trim())
  );

  /* =======================
     Render
     ======================= */
  if (!ready) {
    return (
      <div style={styles.app}>
        <h3>Loading admin panel...</h3>
      </div>
    );
  }

  // If not authed -> show login UI
  if (!getToken() || !adminUser) {
    return (
      <div style={styles.app}>
        <div style={styles.card}>
          <h2 style={styles.title}>Admin Login</h2>
          <p style={{ color: "#666" }}>Geli admin secret/token si aad u gasho. Backend-ku waa inuu xaqiijiyaa token-ka.</p>

          <LoginForm onLogin={handleLogin} loading={loading} />
          {message && <div style={styles.message}>{message}</div>}
        </div>
      </div>
    );
  }

  // Main admin UI
  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.headerTitle}>TaskEarn — Admin</h1>
          <div style={styles.headerSub}>Logged in as: <strong>{adminUser.name || "admin"}</strong></div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            placeholder="Search users by email / id"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={styles.search}
            aria-label="Search users"
          />
          <button onClick={() => { setMessage(null); }} style={styles.btnSecondary}>Clear</button>
          <button onClick={handleLogout} style={styles.btnDanger}>Logout</button>
        </div>
      </header>

      <nav style={styles.nav}>
        <NavButton label="Dashboard" active={activeTab === "dashboard"} onClick={() => setActiveTab("dashboard")} />
        <NavButton label="Users" active={activeTab === "users"} onClick={() => setActiveTab("users")} />
        <NavButton label="Tasks" active={activeTab === "tasks"} onClick={() => setActiveTab("tasks")} />
        <NavButton label="Withdrawals" active={activeTab === "withdrawals"} onClick={() => setActiveTab("withdrawals")} />
        <NavButton label="Settings" active={activeTab === "settings"} onClick={() => setActiveTab("settings")} />
      </nav>

      <main style={styles.main}>
        {message && <div style={styles.toast}>{message}</div>}
        {dangerConfirm && (
          <div style={styles.confirm}>
            <p>{dangerConfirm.text}</p>
            <div style={{ marginTop: 8 }}>
              <button onClick={() => { dangerConfirm.action(); }} style={styles.btnDanger}>Yes, proceed</button>
              <button onClick={() => setDangerConfirm(null)} style={styles.btnSecondary}>Cancel</button>
            </div>
          </div>
        )}

        {activeTab === "dashboard" && (
          <DashboardPanel api={api} loadUsers={loadUsers} loadTasks={loadTasks} loadWithdrawals={loadWithdrawals} />
        )}

        {activeTab === "users" && (
          <UsersPanel users={filteredUsers} loading={loading} onBan={banUser} onUnban={unbanUser} refresh={loadUsers} />
        )}

        {activeTab === "tasks" && (
          <TasksPanel tasks={tasks} onAddTask={addTask} refresh={loadTasks} />
        )}

        {activeTab === "withdrawals" && (
          <WithdrawalsPanel withdrawals={withdrawals} onApprove={approveWithdraw} onReject={rejectWithdraw} refresh={loadWithdrawals} />
        )}

        {activeTab === "settings" && (
          <SettingsPanel api={api} adminUser={adminUser} />
        )}
      </main>
    </div>
  );
}

/* =======================
   SMALL COMPONENTS
   ======================= */

function LoginForm({ onLogin, loading }) {
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(false);

  return (
    <div style={{ marginTop: 12 }}>
      <input
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="Admin secret/token"
        style={styles.input}
        aria-label="admin secret"
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span style={{ fontSize: 13 }}>Remember (session)</span>
        </label>
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={() => onLogin(secret, remember)} style={styles.btnPrimary} disabled={loading}>
          {loading ? "Fadlan sug..." : "Login"}
        </button>
      </div>
    </div>
  );
}

function NavButton({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ ...styles.navBtn, ...(active ? styles.navBtnActive : {}) }}>
      {label}
    </button>
  );
}

/* DashboardPanel: simple overview and quick counts */
function DashboardPanel({ api, loadUsers, loadTasks, loadWithdrawals }) {
  const [stats, setStats] = useState({ users: 0, totalRevenue: 0, pendingWithdrawals: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get("/admin/overview");
        if (!cancelled) {
          setStats(res.data || { users: 0, totalRevenue: 0, pendingWithdrawals: 0 });
        }
      } catch (err) {
        console.warn("overview err", err);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h2 style={styles.sectionTitle}>Dashboard Overview</h2>
      <div style={styles.grid}>
        <div style={styles.cardSmall}>
          <div style={styles.cardTitle}>Users</div>
          <div style={styles.cardValue}>{stats.users}</div>
          <button style={styles.btnSecondary} onClick={loadUsers}>Refresh Users</button>
        </div>

        <div style={styles.cardSmall}>
          <div style={styles.cardTitle}>Revenue</div>
          <div style={styles.cardValue}>${Number(stats.totalRevenue || 0).toFixed(2)}</div>
          <button style={styles.btnSecondary} onClick={loadTasks}>Refresh Tasks</button>
        </div>

        <div style={styles.cardSmall}>
          <div style={styles.cardTitle}>Pending Withdrawals</div>
          <div style={styles.cardValue}>{stats.pendingWithdrawals}</div>
          <button style={styles.btnSecondary} onClick={loadWithdrawals}>Refresh Withdrawals</button>
        </div>
      </div>
    </div>
  );
}

/* UsersPanel */
function UsersPanel({ users, loading, onBan, onUnban, refresh }) {
  return (
    <div>
      <h2 style={styles.sectionTitle}>Users ({users.length})</h2>
      <div style={{ marginBottom: 8 }}>
        <button onClick={refresh} style={styles.btnPrimary}>Refresh</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th>ID</th><th>Name</th><th>Email</th><th>Balance</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td style={styles.code}>{u.id}</td>
                <td>{u.name || "-"}</td>
                <td style={styles.code}>{u.email || "-"}</td>
                <td>${Number(u.balance || 0).toFixed(2)}</td>
                <td>{u.banned ? "BANNED" : "Active"}</td>
                <td>
                  {!u.banned ? <button onClick={() => onBan(u.id)} style={styles.btnDangerSmall}>Ban</button>
                            : <button onClick={() => onUnban(u.id)} style={styles.btnPrimarySmall}>Unban</button>}
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", padding: 12 }}>{loading ? "Loading..." : "No users found"}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* TasksPanel */
function TasksPanel({ tasks, onAddTask, refresh }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [reward, setReward] = useState("");

  return (
    <div>
      <h2 style={styles.sectionTitle}>Tasks ({tasks.length})</h2>
      <div style={{ marginBottom: 12 }}>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} style={styles.input} />
        <input placeholder="Reward (USD)" value={reward} onChange={(e) => setReward(e.target.value)} style={styles.input} />
        <textarea placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...styles.input, height: 80 }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { onAddTask(title, desc, reward); setTitle(""); setDesc(""); setReward(""); }} style={styles.btnPrimary}>Create Task</button>
          <button onClick={refresh} style={styles.btnSecondary}>Refresh</button>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead><tr><th>ID</th><th>Title</th><th>Reward</th><th>Created</th></tr></thead>
          <tbody>
            {tasks.map(t => (
              <tr key={t.id}>
                <td style={styles.code}>{t.id}</td>
                <td>{t.title}</td>
                <td>${Number(t.reward || 0).toFixed(2)}</td>
                <td>{new Date(t.createdAt || Date.now()).toLocaleString()}</td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", padding: 12 }}>No tasks</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* WithdrawalsPanel */
function WithdrawalsPanel({ withdrawals, onApprove, onReject, refresh }) {
  const [reason, setReason] = useState("");

  return (
    <div>
      <h2 style={styles.sectionTitle}>Withdrawals ({withdrawals.length})</h2>
      <div style={{ marginBottom: 8 }}>
        <button onClick={refresh} style={styles.btnPrimary}>Refresh</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead><tr><th>ID</th><th>User</th><th>Amount</th><th>Method</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {withdrawals.map(w => (
              <tr key={w.id}>
                <td style={styles.code}>{w.id}</td>
                <td style={styles.code}>{w.userId}</td>
                <td>${Number(w.amount || 0).toFixed(2)}</td>
                <td>{w.method}</td>
                <td>{w.status}</td>
                <td>
                  {w.status === "PENDING" && (
                    <>
                      <button onClick={() => onApprove(w.id)} style={styles.btnPrimarySmall}>Approve</button>
                      <button onClick={() => { const r=prompt("Sababta diidmada (reason)"); if(r!==null) onReject(w.id,r); }} style={styles.btnDangerSmall}>Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {withdrawals.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", padding: 12 }}>No withdrawals</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* SettingsPanel */
function SettingsPanel({ api, adminUser }) {
  const [maintenance, setMaintenance] = useState(false);
  const [conversion, setConversion] = useState(1000); // points->USD
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get("/admin/settings");
        setMaintenance(Boolean(res.data?.maintenance));
        setConversion(Number(res.data?.conversion) || 1000);
      } catch (e) {
        // ignore
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.post("/admin/settings", { maintenance: Boolean(maintenance), conversion: Number(conversion) });
      setMsg("Saved.");
    } catch (err) {
      setMsg("Save failed.");
    } finally { setSaving(false); }
  };

  return (
    <div>
      <h2 style={styles.sectionTitle}>Settings</h2>
      <div style={styles.cardSmall}>
        <div style={{ marginBottom: 8 }}>
          <label><strong>Maintenance Mode</strong></label>
          <div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={maintenance} onChange={(e) => setMaintenance(e.target.checked)} />
              <span>{maintenance ? "ON" : "OFF"}</span>
            </label>
          </div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <label><strong>Conversion (points -> $)</strong></label>
          <div>
            <input type="number" value={conversion} onChange={(e) => setConversion(e.target.value)} style={styles.inputSmall} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={saving} style={styles.btnPrimary}>{saving ? "Saving..." : "Save"}</button>
          <button onClick={() => { setMaintenance(false); setConversion(1000); }} style={styles.btnSecondary}>Reset</button>
        </div>

        {msg && <div style={{ marginTop: 8 }}>{msg}</div>}
      </div>
    </div>
  );
}

/* =======================
   STYLES (simple JS objects so single-file)
   ======================= */
const styles = {
  app: {
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial",
    padding: 18,
    maxWidth: 1100,
    margin: "18px auto",
  },
  card: {
    background: "#fff",
    padding: 18,
    borderRadius: 12,
    boxShadow: "0 8px 30px rgba(15,23,42,0.06)",
  },
  title: { fontSize: 20, fontWeight: 700, marginBottom: 8 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  headerTitle: { fontSize: 20, fontWeight: 800 },
  headerSub: { fontSize: 13, color: "#555" },
  search: { padding: 8, borderRadius: 8, border: "1px solid #eee", minWidth: 280 },
  nav: { display: "flex", gap: 8, marginBottom: 14 },
  navBtn: { padding: "8px 12px", borderRadius: 10, border: "1px solid transparent", background: "#fafafa", cursor: "pointer" },
  navBtnActive: { background: "#5b21b6", color: "#fff", border: "1px solid rgba(0,0,0,0.06)" },
  main: { background: "#fff", padding: 16, borderRadius: 12, boxShadow: "0 8px 30px rgba(15,23,42,0.04)" },
  toast: { padding: 10, background: "#f3f4f6", borderRadius: 8, marginBottom: 12 },
  confirm: { padding: 12, background: "#fff3f2", border: "1px solid #fed7d7", borderRadius: 10, marginBottom: 12 },
  sectionTitle: { fontSize: 18, fontWeight: 800, marginBottom: 12 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 },
  cardSmall: { padding: 12, borderRadius: 10, background: "#fff", boxShadow: "0 6px 18px rgba(15,23,42,0.04)" },
  cardTitle: { fontSize: 13, color: "#444" },
  cardValue: { fontSize: 24, fontWeight: 800 },
  input: { padding: 8, borderRadius: 8, border: "1px solid #ececec", width: "100%", marginBottom: 8 },
  inputSmall: { padding: 8, borderRadius: 8, border: "1px solid #ececec", width: 120 },
  btnPrimary: { background: "#4f46e5", color: "#fff", padding: "8px 12px", borderRadius: 8, border: "none", cursor: "pointer" },
  btnPrimarySmall: { background: "#4f46e5", color: "#fff", padding: "6px 8px", borderRadius: 6, border: "none", cursor: "pointer", marginRight: 6 },
  btnDanger: { background: "#dc2626", color: "#fff", padding: "8px 12px", borderRadius: 8, border: "none", cursor: "pointer" },
  btnDangerSmall: { background: "#dc2626", color: "#fff", padding: "6px 8px", borderRadius: 6, border: "none", cursor: "pointer", marginRight: 6 },
  btnSecondary: { background: "#f3f4f6", color: "#111827", padding: "8px 12px", borderRadius: 8, border: "1px solid #e5e7eb", cursor: "pointer" },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 8 },
  code: { fontFamily: "monospace", fontSize: 12, color: "#0f172a" },
  message: { marginTop: 12, padding: 12, background: "#fff4e6", borderRadius: 8 },
};