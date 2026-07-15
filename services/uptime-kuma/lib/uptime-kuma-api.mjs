import { io } from "socket.io-client";

/**
 * @typedef {Record<string, unknown>} UptimeKumaMonitorRow
 */

/**
 * @param {unknown} list
 * @returns {UptimeKumaMonitorRow[]}
 */
export function monitorListRowsFromPayload(list) {
  if (Array.isArray(list)) return list;
  if (list && typeof list === "object") {
    return Object.values(list);
  }
  return [];
}

/**
 * Uptime Kuma 2.x pushes monitor data on the monitorList socket event; the getMonitorList
 * callback only returns { ok: true }.
 *
 * @param {import("socket.io-client").Socket} socket
 * @param {number} timeoutMs
 */
export function waitForMonitorListEvent(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Uptime Kuma socket timeout waiting for monitorList event"));
    }, timeoutMs);
    socket.once("monitorList", (list) => {
      clearTimeout(timer);
      resolve(list);
    });
  });
}

/**
 * @param {unknown} list
 * @returns {Record<string, unknown>[]}
 */
export function statusPageListRowsFromPayload(list) {
  if (Array.isArray(list)) return list;
  if (list && typeof list === "object") {
    return Object.values(list);
  }
  return [];
}

/**
 * @param {unknown} list
 * @returns {Record<string, unknown>[]}
 */
export function notificationListRowsFromPayload(list) {
  if (Array.isArray(list)) return list;
  if (list && typeof list === "object") {
    return Object.values(list);
  }
  return [];
}

/**
 * Uptime Kuma pushes notification list on the notificationList socket event after login.
 *
 * @param {import("socket.io-client").Socket} socket
 * @param {number} timeoutMs
 */
export function waitForNotificationListEvent(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Uptime Kuma socket timeout waiting for notificationList event"));
    }, timeoutMs);
    socket.once("notificationList", (list) => {
      clearTimeout(timer);
      resolve(list);
    });
  });
}

/**
 * Uptime Kuma pushes status page list on the statusPageList socket event after login.
 *
 * @param {import("socket.io-client").Socket} socket
 * @param {number} timeoutMs
 */
export function waitForStatusPageListEvent(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Uptime Kuma socket timeout waiting for statusPageList event"));
    }, timeoutMs);
    socket.once("statusPageList", (list) => {
      clearTimeout(timer);
      resolve(list);
    });
  });
}

/**
 * @param {string} baseUrl
 * @param {string} slug
 */
export async function fetchStatusPagePublicData(baseUrl, slug) {
  const root = baseUrl.replace(/\/$/, "");
  const url = `${root}/api/status-page/${encodeURIComponent(String(slug).toLowerCase())}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Uptime Kuma status page HTTP ${resp.status} for ${slug}`);
  }
  return resp.json();
}

/**
 * @param {string} baseUrl
 * @param {{ username: string; password: string; timeoutMs?: number }} auth
 */
export function createUptimeKumaClient(baseUrl, auth) {
  const timeoutMs = auth.timeoutMs ?? 45000;
  const url = baseUrl.replace(/\/$/, "");
  const preferPolling = auth.preferPolling === true;

  /** @type {import("socket.io-client").Socket | null} */
  let socket = null;
  /** @type {Record<string, unknown>[] | null} */
  let cachedStatusPageList = null;
  /** @type {Record<string, unknown>[] | null} */
  let cachedNotificationList = null;

  /**
   * @param {string} event
   * @param {unknown} [payload]
   */
  function emitWithCallback(event, payload) {
    return new Promise((resolve, reject) => {
      if (!socket) {
        reject(new Error("Uptime Kuma socket not connected"));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`Uptime Kuma socket timeout waiting for ${event}`));
      }, timeoutMs);

      const callback = (resp) => {
        clearTimeout(timer);
        if (!resp || resp.ok === false) {
          reject(new Error(resp?.msg ?? `${event} failed`));
          return;
        }
        resolve(resp);
      };

      if (payload === undefined) {
        socket.emit(event, callback);
      } else {
        socket.emit(event, payload, callback);
      }
    });
  }

  return {
    async connect() {
      if (socket?.connected) return;
      socket = io(url, {
        transports: preferPolling ? ["polling", "websocket"] : ["websocket", "polling"],
        reconnection: false,
        timeout: timeoutMs,
      });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Uptime Kuma socket connect timeout")), timeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        socket.once("connect_error", (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    },

    async login() {
      await this.connect();
      if (!socket) {
        throw new Error("Uptime Kuma socket not connected");
      }
      cachedStatusPageList = null;
      cachedNotificationList = null;
      const statusPageListPromise = waitForStatusPageListEvent(socket, timeoutMs);
      const notificationListPromise = waitForNotificationListEvent(socket, timeoutMs);
      const resp = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Uptime Kuma socket timeout waiting for login"));
        }, timeoutMs);
        socket.emit("login", { username: auth.username, password: auth.password }, (data) => {
          clearTimeout(timer);
          resolve(data ?? {});
        });
      });
      if (resp.tokenRequired) {
        throw new Error(
          "Uptime Kuma admin account requires 2FA; disable 2FA or use an account without 2FA for hdc automation",
        );
      }
      if (resp.ok === false) {
        throw new Error(typeof resp.msg === "string" ? resp.msg : "Uptime Kuma login failed");
      }
      try {
        const list = await statusPageListPromise;
        cachedStatusPageList = statusPageListRowsFromPayload(list);
      } catch {
        cachedStatusPageList = [];
      }
      try {
        const list = await notificationListPromise;
        cachedNotificationList = notificationListRowsFromPayload(list);
      } catch {
        cachedNotificationList = [];
      }
      return resp;
    },

    async disconnect() {
      if (socket) {
        socket.disconnect();
        socket = null;
      }
      cachedStatusPageList = null;
      cachedNotificationList = null;
    },

    /**
     * @returns {Promise<UptimeKumaMonitorRow[]>}
     */
    async getMonitorList() {
      if (!socket) {
        throw new Error("Uptime Kuma socket not connected");
      }
      const listPromise = waitForMonitorListEvent(socket, timeoutMs);
      await emitWithCallback("getMonitorList");
      const list = await listPromise;
      return monitorListRowsFromPayload(list);
    },

    /**
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async getTags() {
      const resp = await emitWithCallback("getTags");
      const tags = resp.tags ?? [];
      return Array.isArray(tags) ? tags : [];
    },

    /**
     * @param {{ name: string; color?: string }} tag
     */
    async addTag(tag) {
      const resp = await emitWithCallback("addTag", tag);
      return resp.tag ?? resp;
    },

    /**
     * @param {number} tagId
     * @param {number} monitorId
     * @param {string} [value]
     */
    async addMonitorTag(tagId, monitorId, value = "") {
      return new Promise((resolve, reject) => {
        if (!socket) {
          reject(new Error("Uptime Kuma socket not connected"));
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error("Uptime Kuma socket timeout waiting for addMonitorTag"));
        }, timeoutMs);
        socket.emit("addMonitorTag", tagId, monitorId, value, (resp) => {
          clearTimeout(timer);
          if (!resp || resp.ok === false) {
            reject(new Error(resp?.msg ?? "addMonitorTag failed"));
            return;
          }
          resolve(resp);
        });
      });
    },

    /**
     * @param {number} tagId
     * @param {number} monitorId
     * @param {string} [value]
     */
    async deleteMonitorTag(tagId, monitorId, value = "") {
      return new Promise((resolve, reject) => {
        if (!socket) {
          reject(new Error("Uptime Kuma socket not connected"));
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error("Uptime Kuma socket timeout waiting for deleteMonitorTag"));
        }, timeoutMs);
        socket.emit("deleteMonitorTag", tagId, monitorId, value, (resp) => {
          clearTimeout(timer);
          if (!resp || resp.ok === false) {
            reject(new Error(resp?.msg ?? "deleteMonitorTag failed"));
            return;
          }
          resolve(resp);
        });
      });
    },

    /**
     * @param {Record<string, unknown>} monitor
     */
    async addMonitor(monitor) {
      const resp = await emitWithCallback("add", monitor);
      return { monitorID: resp.monitorID ?? resp.monitorId ?? null, ...resp };
    },

    /**
     * @param {Record<string, unknown>} monitor
     */
    async editMonitor(monitor) {
      return emitWithCallback("editMonitor", monitor);
    },

    /**
     * @param {number} monitorID
     */
    async deleteMonitor(monitorID) {
      return emitWithCallback("deleteMonitor", monitorID);
    },

    /**
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async getStatusPageList() {
      if (cachedStatusPageList) {
        return cachedStatusPageList;
      }
      throw new Error("Uptime Kuma status page list not available; call login() first");
    },

    /**
     * @param {string} slug
     */
    async getStatusPage(slug) {
      return new Promise((resolve, reject) => {
        if (!socket) {
          reject(new Error("Uptime Kuma socket not connected"));
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error("Uptime Kuma socket timeout waiting for getStatusPage"));
        }, timeoutMs);
        socket.emit("getStatusPage", slug, (resp) => {
          clearTimeout(timer);
          if (!resp || resp.ok === false) {
            reject(new Error(resp?.msg ?? "getStatusPage failed"));
            return;
          }
          resolve(resp);
        });
      });
    },

    /**
     * @param {string} title
     * @param {string} slug
     */
    async addStatusPage(title, slug) {
      return new Promise((resolve, reject) => {
        if (!socket) {
          reject(new Error("Uptime Kuma socket not connected"));
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error("Uptime Kuma socket timeout waiting for addStatusPage"));
        }, timeoutMs);
        socket.emit("addStatusPage", title, slug, (resp) => {
          clearTimeout(timer);
          if (!resp || resp.ok === false) {
            reject(new Error(resp?.msg ?? "addStatusPage failed"));
            return;
          }
          resolve(resp);
        });
      });
    },

    /**
     * @param {string} slug
     * @param {Record<string, unknown>} config
     * @param {string} imgDataUrl
     * @param {Record<string, unknown>[]} publicGroupList
     */
    async saveStatusPage(slug, config, imgDataUrl, publicGroupList) {
      return new Promise((resolve, reject) => {
        if (!socket) {
          reject(new Error("Uptime Kuma socket not connected"));
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error("Uptime Kuma socket timeout waiting for saveStatusPage"));
        }, timeoutMs);
        socket.emit("saveStatusPage", slug, config, imgDataUrl, publicGroupList, (resp) => {
          clearTimeout(timer);
          if (!resp || resp.ok === false) {
            reject(new Error(resp?.msg ?? "saveStatusPage failed"));
            return;
          }
          resolve(resp);
        });
      });
    },

    /**
     * @param {string} slug
     */
    async deleteStatusPage(slug) {
      return new Promise((resolve, reject) => {
        if (!socket) {
          reject(new Error("Uptime Kuma socket not connected"));
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error("Uptime Kuma socket timeout waiting for deleteStatusPage"));
        }, timeoutMs);
        socket.emit("deleteStatusPage", slug, (resp) => {
          clearTimeout(timer);
          if (!resp || resp.ok === false) {
            reject(new Error(resp?.msg ?? "deleteStatusPage failed"));
            return;
          }
          resolve(resp);
        });
      });
    },

    /**
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async getNotificationList() {
      if (cachedNotificationList) {
        return cachedNotificationList;
      }
      if (!socket) {
        throw new Error("Uptime Kuma socket not connected");
      }
      const listPromise = waitForNotificationListEvent(socket, timeoutMs);
      try {
        await emitWithCallback("getNotificationList");
      } catch {
        // UK 2.x may not ack getNotificationList; rely on pushed notificationList event.
      }
      const list = await listPromise;
      cachedNotificationList = notificationListRowsFromPayload(list);
      return cachedNotificationList;
    },

    /**
     * @param {Record<string, unknown>} config
     */
    async addNotification(config) {
      return emitWithCallback("addNotification", {
        notification: JSON.stringify(config),
        notificationID: null,
      });
    },

    /**
     * @param {Record<string, unknown>} config
     * @param {number} notificationId
     */
    async editNotification(config, notificationId) {
      return emitWithCallback("addNotification", {
        notification: JSON.stringify(config),
        notificationID: notificationId,
      });
    },

    /**
     * @param {number} notificationId
     */
    async testNotification(notificationId) {
      return emitWithCallback("testNotification", notificationId);
    },
  };
}
