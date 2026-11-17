;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.detached
  "Detached AI chat window (W10).

  The chat can leave the left sidebar for a browser window of its own
  (a second monitor, for example). The design keeps a single agent
  session per workspace tab:

  - The workspace tab keeps the only daemon connection, the chat state
    and the `context.set` updates (`app.main.data.ai.client`,
    `app.main.data.ai.chat`). The detached window opens no socket.
  - The detached window loads the `penforge-chat` route, a shell that
    tells its opener it is ready (`window.postMessage`). The workspace
    tab then renders the chat into that window's document with a
    React root of its own, bound to the workspace store. Both views
    read the same store, so there is no state to sync and no extra hop
    between a daemon message and the detached view.
  - Closing the window docks the chat back in the sidebar; leaving or
    closing the workspace tab closes the window.

  State: `[:penforge :detached]` is nil while docked, else
  `{:status :opening|:open, :window-name}`. The window object itself
  lives outside the store (`current-window`).

  The UI layer registers how to render the chat into the window with
  `set-renderer!` (`app.main.ui.workspace.ai.detached.window`), which
  keeps this namespace free of UI requires."
  (:require
   [app.common.logging :as log]
   [app.common.uuid :as uuid]
   [app.main.data.ai.chat :as-alias chat]
   [app.main.data.ai.client :as-alias client]
   [app.main.data.notifications :as ntf]
   [app.main.router :as rt]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(log/set-level! :info)

(def message-type
  "`type` of the `postMessage` data the detached window sends to its
  opener."
  "penforge:chat-window")

(def window-features
  "Features of the detached window: a popup sized like a wide sidebar."
  "popup=yes,width=460,height=820")

(def closed-check-interval
  "How often (ms) the workspace tab checks whether the user closed the
  detached window."
  500)

;; --- Pure helpers

(defn detached?
  "True while the chat lives in its own window."
  [state]
  (some? (get-in state [:penforge :detached])))

(defn new-window-name
  "A window name unique to one detach, so two workspace tabs never
  share (and fight over) the same detached window."
  []
  (str "penforge-chat-" (uuid/next)))

(defn apply-window-event
  "Reduce a window lifecycle event into the detached state (nil while
  docked).

  - `:opened` the window was opened; its page is loading
  - `:ready` its page is ready and the chat is rendered there
  - `:unload` its page is going away (reload or close); the chat waits
    for the next `:ready`
  - `:closed` the window is gone; the chat docks"
  [detached event & {:keys [window-name]}]
  (case event
    :opened {:status :opening :window-name window-name}
    :ready  (when detached (assoc detached :status :open))
    :unload (when detached (assoc detached :status :opening))
    :closed nil
    detached))

(defn parse-window-message
  "The lifecycle event (`:ready` or `:unload`) carried by a `message`
  DOM event, when it comes from `window` on `origin`; nil otherwise."
  [^js event window origin]
  (let [data (.-data event)]
    (when (and (some? window)
               (identical? window (.-source event))
               (= origin (.-origin event))
               (object? data)
               (= message-type (unchecked-get data "type")))
      (case (unchecked-get data "event")
        "ready"  :ready
        "unload" :unload
        nil))))

(defn window-message
  "The `postMessage` data of a lifecycle event of the detached window."
  [event]
  #js {:type message-type :event (name event)})

;; --- Window and renderer (side effects, outside the store)

(defonce ^:private current-window
  (atom nil))

(defonce ^:private renderer
  (atom nil))

(defn set-renderer!
  "Register how the chat is rendered into the detached window:
  `{:mount (fn [window]) :unmount (fn [])}`. `mount` replaces what an
  earlier `mount` rendered."
  [{:keys [mount unmount] :as fns}]
  (assert (fn? mount) "mount must be a function")
  (assert (fn? unmount) "unmount must be a function")
  (reset! renderer fns))

(defn- window-open?
  [^js window]
  (and (some? window) (not (.-closed window))))

(defn- mount!
  [window]
  (if-let [mount (:mount @renderer)]
    (mount window)
    (log/warn :hint "no renderer registered for the detached chat")))

(defn- unmount!
  []
  (when-let [unmount (:unmount @renderer)]
    (unmount)))

(defn focus-window!
  "Bring the detached window to the front, if there is one."
  []
  (let [window @current-window]
    (when (window-open? window)
      (.focus ^js window))))

(defn chat-document
  "The document the chat lives in while it is detached (the detached
  window's), or nil while it is in the sidebar or the window is gone."
  []
  (let [window @current-window]
    (when (window-open? window)
      (try
        (.-document ^js window)
        (catch :default _ nil)))))

(defn notify-opener!
  "Called from the detached window page: tell the opener about a
  lifecycle event (`:ready` or `:unload`)."
  [event]
  (let [opener (.-opener js/window)]
    (when (window-open? opener)
      (.postMessage ^js opener (window-message event) (.. js/window -location -origin)))))

(def pairing-token-key
  "sessionStorage key of the daemon pairing token; the same key as
  `app.main.data.ai.client/token-key` (that namespace is not loaded in
  the detached window page)."
  "penforge.token")

(defn forget-pairing-token!
  "Called from the detached window page. `window.open` copies the
  opener's sessionStorage into the new window, pairing token included.
  The window never talks to the daemon, so it drops the copy: if it
  outlives its opener, nothing in it can open a second agent session
  with that token."
  ([] (forget-pairing-token! (try
                               (unchecked-get js/globalThis "sessionStorage")
                               (catch :default _ nil))))
  ([^js storage]
   (when (some? storage)
     (try
       (.removeItem storage pairing-token-key)
       (catch :default cause
         (log/warn :hint "unable to drop the pairing token" :cause cause))))))

;; --- Render latency (dev builds only)

(defonce ^:private last-message
  (atom nil))

(defn- track-message!
  [msg]
  (reset! last-message {:type (:type msg) :at (js/performance.now)}))

(defn log-render-latency!
  "Called after the detached chat rendered a state change. In dev
  builds, logs the time from the daemon message that ended a turn to
  the detached render, once per turn."
  []
  (when *assert*
    (when-let [{:keys [type at]} @last-message]
      (reset! last-message nil)
      (when (= "chat.done" type)
        (log/info :hint "detached chat render latency"
                  :ms (.toFixed (- (js/performance.now) at) 1))))))

;; --- Events

(defn- update-detached
  [state event & {:as opts}]
  (if-let [detached (apply-window-event (get-in state [:penforge :detached]) event opts)]
    (assoc-in state [:penforge :detached] detached)
    (update state :penforge dissoc :detached)))

(defn dock
  "Bring the chat back to the sidebar and close the detached window."
  []
  (ptk/reify ::dock
    ptk/UpdateEvent
    (update [_ state]
      (update-detached state :closed))

    ptk/EffectEvent
    (effect [_ _ _]
      (unmount!)
      (let [window @current-window]
        (reset! current-window nil)
        (when (window-open? window)
          (.close ^js window))))))

(defn- window-ready
  [window]
  (ptk/reify ::window-ready
    ptk/UpdateEvent
    (update [_ state]
      (if (identical? window @current-window)
        (update-detached state :ready)
        state))

    ptk/EffectEvent
    (effect [_ state _]
      (when (and (detached? state) (identical? window @current-window))
        (mount! window)))))

(defn- window-unload
  [window]
  (ptk/reify ::window-unload
    ptk/UpdateEvent
    (update [_ state]
      (if (identical? window @current-window)
        (update-detached state :unload)
        state))

    ptk/EffectEvent
    (effect [_ _ _]
      (when (identical? window @current-window)
        (unmount!)))))

(defn- dom-events
  "Stream of the `type` DOM events of `target`."
  [^js target type]
  (rx/create
   (fn [subs]
     (let [listener #(rx/push! subs %)]
       (.addEventListener target type listener)
       #(.removeEventListener target type listener)))))

(defn- follow-window
  "Events that keep the chat and the detached window `popup` together until
  the chat docks."
  [popup stream]
  (let [origin (.. js/window -location -origin)]
    (->> (rx/merge
          ;; Ready / unload messages of the window page.
          (->> (dom-events js/window "message")
               (rx/map #(parse-window-message % popup origin))
               (rx/filter some?)
               (rx/map (fn [event]
                         (if (= :ready event)
                           (window-ready popup)
                           (window-unload popup)))))

          ;; Closing the window docks the chat.
          (->> (rx/interval closed-check-interval)
               (rx/filter #(not (window-open? popup)))
               (rx/take 1)
               (rx/map (fn [_] (dock))))

          ;; The detached window shows the chat of this workspace tab
          ;; only: it goes away with it.
          (->> (dom-events js/window "pagehide")
               (rx/tap (fn [_]
                         (when (window-open? popup)
                           (.close ^js popup))))
               (rx/ignore))

          (->> stream
               (rx/filter (ptk/type? ::chat/finalize))
               (rx/take 1)
               (rx/map (fn [_] (dock))))

          ;; Ask AI and the other chat entry points of the canvas reach
          ;; the detached chat: bring its window to the front.
          (->> stream
               (rx/filter #(or (ptk/type? ::chat/open-chat %)
                               (ptk/type? ::chat/attach-node %)))
               (rx/tap (fn [_] (focus-window!)))
               (rx/ignore))

          (if *assert*
            (->> stream
                 (rx/filter (ptk/type? ::client/message))
                 (rx/tap (comp track-message! deref))
                 (rx/ignore))
            (rx/empty)))
         (rx/take-until (rx/filter (ptk/type? ::dock) stream)))))

(defn- opened
  [window-name]
  (ptk/reify ::opened
    ptk/UpdateEvent
    (update [_ state]
      (update-detached state :opened :window-name window-name))))

(defn detach
  "Move the chat to its own window. When it already has one, bring
  that window to the front."
  []
  (ptk/reify ::detach
    ptk/WatchEvent
    (watch [_ state stream]
      (if (and (detached? state) (window-open? @current-window))
        (do (focus-window!)
            (rx/empty))
        (let [file-id     (or (get-in state [:penforge :chat :file-id])
                              (:current-file-id state))
              window-name (new-window-name)
              uri         (rt/resolve-uri (:router state) :penforge-chat
                                          {:file-id (str file-id)})
              popup       (when uri
                            (try
                              (.open js/window uri window-name window-features)
                              (catch :default cause
                                (log/warn :hint "unable to open the detached chat window"
                                          :cause cause)
                                nil)))]
          (if (nil? popup)
            (rx/of (ntf/warn (tr "penforge.detached.blocked")))
            (do
              (reset! current-window popup)
              (rx/concat
               (rx/of (opened window-name))
               (follow-window popup stream)))))))))
