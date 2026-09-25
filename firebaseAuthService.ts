/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getApps, initializeApp, FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  Auth,
  User as FirebaseUser,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  onSnapshot,
  Firestore,
} from "firebase/firestore";
import { AuthRequestUser, UserRole, AuthorizationStatus, AppUser } from "../types";

/**
 * Standardized Firestore error handler adhering to platform guidelines
 */
export function handleFirestoreError(error: unknown, operationType: string, path: string): never {
  const errObj = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
  };
  throw new Error(JSON.stringify(errObj));
}

/**
 * Safely resolves Firebase Auth and Firestore if environment credentials exist
 */
export function getSafeFirebase(): { app: FirebaseApp | null; auth: Auth | null; db: Firestore | null } {
  try {
    const apps = getApps();
    if (apps.length > 0) {
      const app = apps[0];
      return {
        app,
        auth: getAuth(app),
        db: getFirestore(app),
      };
    }

    const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> })?.env || {};
    const apiKey = metaEnv.VITE_FIREBASE_API_KEY;
    const projectId = metaEnv.VITE_FIREBASE_PROJECT_ID;

    if (apiKey && projectId) {
      const app = initializeApp({
        apiKey,
        authDomain: `${projectId}.firebaseapp.com`,
        projectId,
      });
      return {
        app,
        auth: getAuth(app),
        db: getFirestore(app),
      };
    }
    return { app: null, auth: null, db: null };
  } catch (err) {
    console.warn("Firebase Auth/Firestore not available:", err);
    return { app: null, auth: null, db: null };
  }
}

/**
 * Fetches a user document from the Firestore 'users' collection
 */
export async function getUserDocFromFirestore(uid: string): Promise<AppUser | null> {
  const { db } = getSafeFirebase();
  if (!db) return null;

  try {
    const userDocRef = doc(db, "users", uid);
    const snap = await getDoc(userDocRef);
    if (!snap.exists()) return null;

    const data = snap.data();
    return {
      uid: data.uid || uid,
      name: data.name || "Authenticated User",
      email: data.email || "",
      role: (data.role as UserRole) || null,
      status: (data.status as AuthorizationStatus) || "Pending",
      employeeId: data.employeeId || undefined,
      designation: data.designation || undefined,
    };
  } catch (err) {
    console.warn("Error fetching user document from Firestore:", err);
    return null;
  }
}

/**
 * Subscribes to real-time changes on a user document in Firestore 'users/{uid}'
 */
export function subscribeToUserDoc(
  uid: string,
  onUpdate: (user: AppUser | null) => void
): () => void {
  const { db } = getSafeFirebase();
  if (!db) return () => {};

  const userDocRef = doc(db, "users", uid);
  return onSnapshot(
    userDocRef,
    (snap) => {
      if (!snap.exists()) {
        onUpdate(null);
        return;
      }
      const data = snap.data();
      onUpdate({
        uid: data.uid || uid,
        name: data.name || "Authenticated User",
        email: data.email || "",
        role: (data.role as UserRole) || null,
        status: (data.status as AuthorizationStatus) || "Pending",
        employeeId: data.employeeId || undefined,
        designation: data.designation || undefined,
      });
    },
    (err) => {
      console.warn("User doc listener error:", err);
    }
  );
}

/**
 * Syncs a user document into Firestore 'users' collection with NO avatar/photos
 */
export async function syncGoogleUserToFirestore(
  requestUser: AuthRequestUser
): Promise<{ success: boolean; firestoreSynced: boolean; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) {
    return { success: true, firestoreSynced: false };
  }

  try {
    const userDocRef = doc(db, "users", requestUser.uid);
    await setDoc(
      userDocRef,
      {
        uid: requestUser.uid,
        name: requestUser.name,
        email: requestUser.email,
        status: requestUser.status || "Pending",
        role: requestUser.role || null,
        requestedAt: requestUser.requestedAt || new Date().toISOString(),
        reviewedAt: requestUser.reviewedAt || null,
        reviewedBy: requestUser.reviewedBy || null,
      },
      { merge: true }
    );
    return { success: true, firestoreSynced: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Firestore document write skipped or failed:", errorMsg);
    return { success: false, firestoreSynced: false, error: errorMsg };
  }
}

/**
 * Updates a user document in Firestore 'users' collection on approval or rejection
 */
export async function updateUserStatusInFirestore(
  uid: string,
  status: AuthorizationStatus,
  role?: UserRole | string | null,
  reviewedBy?: string
): Promise<{ success: boolean; firestoreSynced: boolean; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) {
    return { success: true, firestoreSynced: false };
  }

  try {
    const userDocRef = doc(db, "users", uid);
    const updatePayload: Record<string, unknown> = {
      status,
      reviewedAt: new Date().toISOString(),
      reviewedBy: reviewedBy || "System Root",
    };
    if (role !== undefined) {
      updatePayload.role = role;
    }
    await updateDoc(userDocRef, updatePayload);
    return { success: true, firestoreSynced: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Firestore user status update skipped:", errorMsg);
    return { success: false, firestoreSynced: false, error: errorMsg };
  }
}

/**
 * Appends an audit record to the 'activityLogs' Firestore collection
 */
export async function appendActivityLogToFirestore(logItem: {
  action: string;
  targetUser?: string;
  executedBy?: string;
  details?: string;
  module?: string;
  recordId?: string;
  payload?: string;
  userEmail?: string;
  userName?: string;
  userRole?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; firestoreSynced: boolean; id?: string; error?: string }> {
  const { db } = getSafeFirebase();
  if (!db) {
    return { success: true, firestoreSynced: false };
  }

  try {
    const logRef = doc(collection(db, "activityLogs"));
    const timestamp = new Date().toISOString();
    const docData = {
      id: logRef.id,
      timestamp,
      action: logItem.action,
      targetUser: logItem.targetUser || logItem.userEmail || "",
      executedBy: logItem.executedBy || logItem.userName || "System",
      details: logItem.details || logItem.payload || "",
      module: logItem.module || "Auth",
      recordId: logItem.recordId || logRef.id,
      metadata: logItem.metadata || {},
      result: "SUCCESS",
    };
    await setDoc(logRef, docData);
    return { success: true, firestoreSynced: true, id: logRef.id };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Firestore activityLog write skipped:", errorMsg);
    return { success: false, firestoreSynced: false, error: errorMsg };
  }
}

/**
 * Executes Google OAuth requesting ONLY 'email' and 'profile' scopes.
 * STRICT NO-IMAGE POLICY: Discards any profile photo or avatar URLs.
 */
export async function executeGoogleSyncAuth(): Promise<{
  success: boolean;
  user?: {
    uid: string;
    email: string;
    displayName: string;
  };
  useFallbackSimulation?: boolean;
  error?: string;
}> {
  const { auth } = getSafeFirebase();

  if (!auth) {
    return {
      success: false,
      useFallbackSimulation: true,
      error: "Firebase Auth not provisioned with live credentials. Falling back to Google identity selector.",
    };
  }

  try {
    const provider = new GoogleAuthProvider();
    provider.addScope("profile");
    provider.addScope("email");
    const result = await signInWithPopup(auth, provider);
    const fbUser: FirebaseUser = result.user;

    // Discard any avatarUrl / photoURL per strict no-image policy
    return {
      success: true,
      user: {
        uid: fbUser.uid,
        email: fbUser.email || "unknown@gmail.com",
        displayName: fbUser.displayName || "Google User",
      },
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Firebase Google popup error or sandbox limitation:", errorMsg);
    return {
      success: false,
      useFallbackSimulation: true,
      error: errorMsg,
    };
  }
}
