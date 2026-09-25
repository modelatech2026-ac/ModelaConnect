/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { AppUser, UserRole, AuthorizationStatus } from "../types";
import { DEMO_USERS } from "../data/initialData";
import { useToast } from "./ToastContext";
import {
  getSafeFirebase,
  getUserDocFromFirestore,
  subscribeToUserDoc,
} from "../services/firebaseAuthService";
import {
  isRoleSuperAdmin,
  isRoleAdmin,
  isRoleEmployee,
  normalizeUserRole,
  checkIsUserSuperAdmin,
  isApprovedStatus,
  isPendingStatus,
  isRejectedStatus,
} from "../lib/authUtils";
import { onAuthStateChanged, signOut as fbSignOut } from "firebase/auth";

interface AuthContextType {
  currentUser: AppUser | null;
  currentRole: UserRole;
  isAuthenticated: boolean;
  isApproved: boolean;
  isPending: boolean;
  isRejected: boolean;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isEmployee: boolean;
  isLoading: boolean;
  demoUsers: AppUser[];
  loginWithGoogle: (email: string, name?: string) => Promise<{
    success: boolean;
    case: "A" | "B" | "C" | "D";
    status: AuthorizationStatus;
    message: string;
    user?: AppUser;
  }>;
  login: (email: string, pass?: string) => Promise<{ success: boolean; user?: AppUser; error?: string }>;
  logout: () => void;
  switchDemoUser: (target: string) => AppUser | null;
  switchPersona: (employeeIdOrUid: string) => AppUser | null;
  setCurrentUser: React.Dispatch<React.SetStateAction<AppUser | null>>;
  hasPermission: (allowedRoles: (UserRole | string)[]) => boolean;
  refreshUserStatus: () => Promise<AuthorizationStatus | null>;
  isSignInModalOpen: boolean;
  setIsSignInModalOpen: (open: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_STORAGE_KEY = "modela_active_user_data";
export const SESSION_REQUEST_KEY = "modela_session_request_submitted";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { toast, success, info, error: toastError } = useToast();

  // Reset local storage state on initial load so the application always opens to Step 1
  // unless a request has actually been submitted during the session.
  const [currentUser, setCurrentUser] = useState<AppUser | null>(() => {
    try {
      const hasSessionRequest = sessionStorage.getItem(SESSION_REQUEST_KEY);
      if (!hasSessionRequest) {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        localStorage.removeItem("modela_jwt_token");
        return null;
      }
      const saved = localStorage.getItem(AUTH_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.email) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return null;
  });

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSignInModalOpen, setIsSignInModalOpen] = useState<boolean>(false);

  // Sync current user to local storage (no images stored)
  useEffect(() => {
    if (currentUser) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(currentUser));
    } else {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  }, [currentUser]);

  // Initial session hydration
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // Google OAuth Login Action
  const loginWithGoogle = useCallback(
    async (
      email: string,
      name?: string
    ): Promise<{
      success: boolean;
      case: "A" | "B" | "C" | "D";
      status: AuthorizationStatus;
      message: string;
      user?: AppUser;
    }> => {
      setIsLoading(true);
      const cleanEmail = email.trim().toLowerCase();
      const cleanName = name?.trim() || cleanEmail.split("@")[0];

      try {
        const res = await fetch("/api/auth/google", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: cleanEmail, name: cleanName }),
        });

        const data = await res.json();
        const serverUser = data.user;

        if (data.token) {
          localStorage.setItem("modela_jwt_token", data.token);
        }

        const resolvedUser: AppUser = {
          uid: serverUser?.uid || "USR-" + Math.random().toString(36).substring(2, 9),
          name: serverUser?.name || cleanName,
          email: cleanEmail,
          status: serverUser?.status || data.status || "Pending",
          role: serverUser?.role || null,
          employeeId: serverUser?.employeeId,
          isSuperAdmin: checkIsUserSuperAdmin(serverUser),
        };

        setCurrentUser(resolvedUser);
        setIsLoading(false);

        if (data.status === "Approved") {
          success(
            "Access Authorized",
            `Welcome back, ${resolvedUser.name}. Authenticated as ${resolvedUser.role || "Staff Member"}.`
          );
        } else if (data.status === "Rejected") {
          toastError("Access Denied", "Your request for access has been rejected.");
        } else {
          info(
            "Access Request Submitted",
            "Your access request has been submitted. Please wait for HR/Super Admin approval."
          );
        }

        return {
          success: data.success,
          case: data.case || (data.status === "Approved" ? "D" : data.status === "Rejected" ? "C" : "A"),
          status: data.status,
          message: data.message,
          user: resolvedUser,
        };
      } catch (err: any) {
        setIsLoading(false);
        const errorMsg = err?.message || "Failed to authenticate with Google.";
        toastError("Sign In Error", errorMsg);
        return {
          success: false,
          case: "A",
          status: "Pending",
          message: errorMsg,
        };
      }
    },
    [success, info, toastError]
  );

  // Classic login helper for modals/demo switching
  const login = useCallback(
    async (
      email: string,
      _pass?: string
    ): Promise<{ success: boolean; user?: AppUser; error?: string }> => {
      const res = await loginWithGoogle(email);
      return {
        success: res.status === "Approved",
        user: res.user,
        error: res.status !== "Approved" ? res.message : undefined,
      };
    },
    [loginWithGoogle]
  );

  // Switch demo persona
  const switchDemoUser = useCallback(
    (identifier: string): AppUser | null => {
      const cleanId = identifier.trim().toLowerCase();
      const target =
        DEMO_USERS.find((u) => u.employeeId?.toLowerCase() === cleanId) ||
        DEMO_USERS.find((u) => u.uid?.toLowerCase() === cleanId) ||
        DEMO_USERS.find((u) => u.email.toLowerCase() === cleanId) ||
        DEMO_USERS.find((u) => u.name.toLowerCase() === cleanId) ||
        DEMO_USERS.find((u) => u.name.toLowerCase().includes(cleanId));

      if (target) {
        setCurrentUser(target);
        info("Active Persona", `${target.name} (${target.role})`);
        return target;
      }
      return null;
    },
    [info]
  );

  const switchPersona = useCallback(
    (employeeIdOrUid: string): AppUser | null => {
      return switchDemoUser(employeeIdOrUid);
    },
    [switchDemoUser]
  );

  // Refresh user status from server
  const refreshUserStatus = useCallback(async (): Promise<AuthorizationStatus | null> => {
    if (!currentUser?.email) return null;
    try {
      const res = await fetch(`/api/auth/status?email=${encodeURIComponent(currentUser.email)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.token) {
          localStorage.setItem("modela_jwt_token", data.token);
        }
        if (data.user) {
          const updated: AppUser = {
            ...currentUser,
            status: data.user.status,
            role: data.user.role,
            isSuperAdmin: checkIsUserSuperAdmin(data.user),
          };
          setCurrentUser(updated);
          return data.user.status;
        }
      }
    } catch (err) {
      console.warn("Error refreshing user status:", err);
    }
    return currentUser.status || null;
  }, [currentUser]);

  // Logout with server audit log
  const logout = useCallback(() => {
    const userEmail = currentUser?.email;
    if (userEmail) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userEmail }),
      }).catch(() => {});
    }

    const { auth } = getSafeFirebase();
    if (auth) {
      fbSignOut(auth).catch(() => {});
    }

    setCurrentUser(null);
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem("modela_jwt_token");
    sessionStorage.removeItem(SESSION_REQUEST_KEY);
    toast({
      type: "info",
      title: "Signed Out",
      description: "You have securely signed out of Modela Connect.",
    });
  }, [currentUser?.email, toast]);

  // Derived authorization flags
  const isSuperAdmin = checkIsUserSuperAdmin(currentUser);
  const currentRole: UserRole = isSuperAdmin
    ? "Super Admin"
    : currentUser?.role
    ? normalizeUserRole(currentUser.role)
    : "Employee";

  const isAdmin = isSuperAdmin || isRoleAdmin(currentUser?.role);
  const isEmployee = !isSuperAdmin && !isAdmin && (isRoleEmployee(currentUser?.role) || currentRole === "Employee");

  const isApproved =
    Boolean(currentUser) &&
    isApprovedStatus(currentUser?.status) &&
    currentUser?.role !== null &&
    currentUser?.role !== "Guest";

  const isPending = Boolean(currentUser) && isPendingStatus(currentUser?.status);
  const isRejected = Boolean(currentUser) && isRejectedStatus(currentUser?.status);

  const hasPermission = useCallback(
    (allowedRoles: (UserRole | string)[]): boolean => {
      if (!currentUser || !isApproved) return false;
      if (isSuperAdmin) return true;
      return allowedRoles.some((r) => {
        const norm = String(r).trim().toUpperCase();
        if (norm === "SUPERADMIN" || norm === "SUPER ADMIN") return isSuperAdmin;
        if (norm === "ADMIN" || norm === "HR ADMIN") return isAdmin;
        if (norm === "EMPLOYEE") return isEmployee;
        return norm === String(currentUser.role).trim().toUpperCase() || norm === currentRole.toUpperCase();
      });
    },
    [currentUser, isApproved, isSuperAdmin, isAdmin, isEmployee, currentRole]
  );

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        currentRole,
        isAuthenticated: !!currentUser,
        isApproved,
        isPending,
        isRejected,
        isSuperAdmin,
        isAdmin,
        isEmployee,
        isLoading,
        demoUsers: DEMO_USERS,
        loginWithGoogle,
        login,
        logout,
        switchDemoUser,
        switchPersona,
        setCurrentUser,
        hasPermission,
        refreshUserStatus,
        isSignInModalOpen,
        setIsSignInModalOpen,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
