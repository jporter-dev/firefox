/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";
import { IPPEarlyStartupFilter } from "moz-src:///toolkit/components/ipprotection/IPPEarlyStartupFilter.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  IPProtectionServerlist:
    "moz-src:///toolkit/components/ipprotection/IPProtectionServerlist.sys.mjs",
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPProtectionService:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
  IPProtectionStates:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  console.createInstance({
    prefix: "IPPAlwaysOn",
    maxLogLevel: Services.prefs.getBoolPref("browser.ipProtection.log", false)
      ? "Debug"
      : "Warn",
  })
);

const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 30000;

/**
 * Keeps the proxy connection alive on enterprise builds where the
 * AccessConnector policy is active. Unlike IPPAutoStart, this class:
 *
 *  - Recovers from ERROR states by stopping and requesting a restart.
 *  - Restarts when the proxy stops unexpectedly.
 *  - Restarts are deferred and backed off so that repeated failures don't spin the main thread.
 *  - Switches to a new server when the server list is updated.
 *
 * Because this is policy-driven there is no user-facing toggle; the proxy
 * runs whenever the service is ready and the policy is set.
 */
class IPPAlwaysOnSingleton {
  #initialized = false;
  #shouldBeRunning = false;
  #startPending = false;
  #restartTimer = 0;
  #restartDelayMs = 0;

  constructor() {
    this.handleServiceEvent = this.#handleServiceEvent.bind(this);
    this.handleProxyEvent = this.#handleProxyEvent.bind(this);
    this.handleServerlistEvent = this.#handleServerlistEvent.bind(this);
  }

  get alwaysOnEnabled() {
    return !!Services.policies.getActivePolicies()?.AccessConnector;
  }

  init() {
    if (this.#initialized || !this.alwaysOnEnabled) {
      lazy.logConsole.debug(
        "init() skipped — initialized:",
        this.#initialized,
        "alwaysOnEnabled:",
        this.alwaysOnEnabled
      );
      return;
    }
    lazy.logConsole.info("Initialized");
    this.#initialized = true;

    lazy.IPProtectionService.addEventListener(
      "IPProtectionService:StateChanged",
      this.handleServiceEvent
    );
    lazy.IPPProxyManager.addEventListener(
      "IPPProxyManager:StateChanged",
      this.handleProxyEvent
    );
    lazy.IPProtectionServerlist.addEventListener(
      "IPProtectionServerlist:ListChanged",
      this.handleServerlistEvent
    );
  }

  initOnStartupCompleted() {}

  uninit() {
    if (!this.#initialized) {
      return;
    }
    this.#initialized = false;
    this.#shouldBeRunning = false;
    this.#startPending = false;
    this.#cancelStartRequest();

    lazy.IPProtectionService.removeEventListener(
      "IPProtectionService:StateChanged",
      this.handleServiceEvent
    );
    lazy.IPPProxyManager.removeEventListener(
      "IPPProxyManager:StateChanged",
      this.handleProxyEvent
    );
    lazy.IPProtectionServerlist.removeEventListener(
      "IPProtectionServerlist:ListChanged",
      this.handleServerlistEvent
    );
  }

  /**
   * Returns true if a start request would be blocked by the current state of
   * the service, proxy, or server list.
   */
  #isStartBlocked() {
    if (
      lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVE &&
      lazy.IPPProxyManager.channelFilter()?.proxyInfo
    ) {
      return true;
    }
    return !lazy.IPProtectionServerlist.hasList;
  }

  /**
   * Requests a start of the proxy, with exponential backoff on repeated failures.
   *
   * @param {boolean} [resetBackoff]
   *   Reset the backoff delay to the base value.
   */
  #requestStart(resetBackoff = false) {
    if (resetBackoff) {
      this.#cancelStartRequest();
    }
    if (this.#startPending || this.#restartTimer) {
      return;
    }
    if (this.#isStartBlocked()) {
      return;
    }

    const delay = this.#restartDelayMs;
    this.#restartDelayMs = Math.min(
      this.#restartDelayMs ? this.#restartDelayMs * 2 : RESTART_BASE_DELAY_MS,
      RESTART_MAX_DELAY_MS
    );
    this.#restartTimer = lazy.setTimeout(() => {
      this.#restartTimer = 0;
      if (!this.#shouldBeRunning || !this.alwaysOnEnabled) {
        return;
      }
      this.#tryStart();
    }, delay);
  }

  #cancelStartRequest() {
    if (this.#restartTimer) {
      lazy.clearTimeout(this.#restartTimer);
      this.#restartTimer = 0;
    }
    this.#restartDelayMs = 0;
  }

  /**
   * Stops the proxy and, once it settles, requests a fresh start.
   *
   * @param {boolean} [resetBackoff] Reset the backoff delay to the base value.
   */
  #stopThenRestart(resetBackoff = false) {
    lazy.IPPProxyManager.stop(false).then(
      () => {
        if (this.#shouldBeRunning && this.alwaysOnEnabled) {
          this.#requestStart(resetBackoff);
        }
      },
      e => lazy.logConsole.error("Failed to stop proxy:", e)
    );
  }

  /**
   * Attempts to start the proxy immediately, if not already
   * pending and not blocked by the current state.
   */
  #tryStart() {
    if (this.#startPending) {
      return;
    }
    if (this.#isStartBlocked()) {
      return;
    }
    lazy.logConsole.info("Starting proxy");
    this.#startPending = true;
    lazy.IPPProxyManager.start(
      false,
      PrivateBrowsingUtils.permanentPrivateBrowsing
    ).then(
      result => {
        if (!result?.started) {
          this.#startPending = false;
        }
      },
      () => {
        this.#startPending = false;
      }
    );
  }

  #handleServiceEvent() {
    const serviceState = lazy.IPProtectionService.state;
    switch (serviceState) {
      case lazy.IPProtectionStates.UNINITIALIZED:
      case lazy.IPProtectionStates.UNAVAILABLE:
      case lazy.IPProtectionStates.UNAUTHENTICATED:
        this.#shouldBeRunning = false;
        this.#startPending = false;
        break;

      case lazy.IPProtectionStates.READY:
        this.#shouldBeRunning = true;
        this.#requestStart(true);
        break;

      default:
        break;
    }
  }

  #handleProxyEvent() {
    // alwaysOnEnabled flips to false synchronously when the policy is removed,
    // before uninit() runs. Bail out so we don't restart in response to the
    // ACTIVE->READY transition produced by teardown.
    if (!this.#shouldBeRunning || !this.alwaysOnEnabled) {
      return;
    }

    switch (lazy.IPPProxyManager.state) {
      case lazy.IPPProxyStates.ACTIVE:
        this.#startPending = false;
        this.#cancelStartRequest();
        break;

      case lazy.IPPProxyStates.READY:
        this.#startPending = false;
        this.#requestStart();
        break;

      case lazy.IPPProxyStates.ERROR:
        this.#startPending = false;
        // Repeated failures back off; don't reset the delay.
        this.#stopThenRestart();
        break;

      default:
        break;
    }
  }

  #handleServerlistEvent() {
    if (!this.alwaysOnEnabled) {
      return;
    }
    if (!lazy.IPProtectionServerlist.hasList) {
      // Serverlist cleared (e.g. policy removed); stop any active connection.
      const state = lazy.IPPProxyManager.state;
      if (
        state === lazy.IPPProxyStates.ACTIVE ||
        state === lazy.IPPProxyStates.ERROR
      ) {
        lazy.IPPProxyManager.stop(false);
      }
      return;
    }
    const state = lazy.IPPProxyManager.state;
    switch (state) {
      case lazy.IPPProxyStates.ACTIVE: {
        // Hot-swap without dropping the connection.
        lazy.logConsole.debug("Switching to updated server");
        const { error } = lazy.IPPProxyManager.switch();
        if (error) {
          // Fresh server list, reset backoff so the reconnect isn't delayed.
          this.#stopThenRestart(true);
        }
        break;
      }

      case lazy.IPPProxyStates.ERROR:
        // A fresh server list may resolve the error; reset backoff to retry promptly.
        if (this.#shouldBeRunning) {
          this.#stopThenRestart(true);
        }
        break;

      case lazy.IPPProxyStates.READY:
        if (this.#shouldBeRunning) {
          this.#requestStart(true);
        }
        break;

      default:
        break;
    }
  }
}

const IPPAlwaysOn = new IPPAlwaysOnSingleton();

const IPPAlwaysOnHelpers = [
  IPPAlwaysOn,
  new IPPEarlyStartupFilter(() => IPPAlwaysOn.alwaysOnEnabled),
];

export { IPPAlwaysOnHelpers, IPPAlwaysOnSingleton };
