;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.preview
  "Live preview of the generated app (W09).

  The daemon runs the dev server of the project's `app-src/`
  (`preview.start` / `preview.stop`) and reports `preview.status`
  (plus `preview.log` lines for the developer persona). The workspace
  shows the app in a pane next to the canvas or in a large overlay.

  State lives under `[:penforge :preview]`:

  - `:status` `:idle` `:starting` `:ready` `:stopped` `:failed`
  - `:url` preview URL, `:reason` daemon reason code (`:start-timeout`
    `:crashed` `:command-failed` `:restarting` `:stopped`
    `:project-closed` `:daemon-stopped`), `:code` error code of a refused
    request, `:message` technical English detail (developer persona
    only), `:restarts` restarts after crashes
  - `:rid` request id of the last `preview.start` / `preview.stop`
  - `:pane` `nil` (closed), `:split` or `:overlay`
  - `:device` `:desktop` or `:mobile` (390px frame)
  - `:width` width of the split pane in px
  - `:reload-key` bumped to reload the frame
  - `:logs` last dev server lines `{:stream :text}`

  The pane, device and width are kept per tab in session storage, so a
  page reload shows the preview again; the daemon keeps the server
  running for a while after the tab goes away."
  (:require
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.penforge :as penforge]
   [app.main.store :as st]
   [app.util.storage :as storage]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def max-logs 300)
(def min-width 320)
(def default-width 480)
(def mobile-width 390)

(def empty-preview
  {:status :idle
   :pane nil
   :device :desktop
   :width default-width
   :reload-key 0
   :logs []})

(def live-statuses
  #{:starting :ready})

;; --- Pure helpers

(defn clamp-width
  "Clamp a split pane width between `min-width` and `max-width`."
  [width max-width]
  (-> width
      (max min-width)
      (min (max min-width max-width))))

(defn- append-log
  [preview line]
  (update preview :logs
          (fn [logs]
            (let [logs (conj (or logs []) line)
                  extra (- (count logs) max-logs)]
              (if (pos? extra)
                (subvec logs extra)
                logs)))))

(defn apply-message
  "Reduce a daemon message of the open project into the preview
  state. `error` replies count only for the last preview request."
  [preview msg]
  (case (:type msg)
    "preview.status"
    (-> preview
        (assoc :status (keyword (:state msg))
               :reason (some-> (:reason msg) keyword)
               :message (:message msg)
               :restarts (or (:restarts msg) 0)
               :code nil)
        (cond-> (some? (:url msg)) (assoc :url (:url msg))))

    "preview.ready"
    (assoc preview :status :ready :url (:url msg) :reason nil :message nil :code nil)

    "preview.stopped"
    (cond-> preview
      (contains? live-statuses (:status preview))
      (assoc :status :stopped))

    "preview.log"
    (append-log preview {:stream (keyword (:stream msg)) :text (:text msg)})

    "error"
    (if (and (some? (:rid msg)) (= (:rid msg) (:rid preview)))
      (assoc preview :status :failed :code (:code msg) :message (:message msg))
      preview)

    preview))

(defn- get-preview
  [state]
  (get-in state [:penforge :preview] empty-preview))

(defn- update-preview
  [state f & args]
  (apply update-in state [:penforge :preview] (fnil f empty-preview) args))

(defn- current-project-id
  [state]
  (some-> (:current-project-id state) str))

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn live?
  "Whether the dev server is starting or ready."
  [preview]
  (contains? live-statuses (:status preview)))

(defn default-device
  "Initial device frame: mobile for mobile projects."
  [state]
  (if (= :mobile (some-> (penforge/current-platform state) keyword))
    :mobile
    :desktop))

;; --- Session preferences

(defn- load-prefs
  [project-id]
  (let [prefs (get @storage/session ::prefs)]
    (when (= project-id (:project-id prefs))
      (select-keys prefs [:pane :device :width]))))

(defn- save-prefs!
  [state]
  (let [preview (get-preview state)]
    (swap! storage/session assoc ::prefs
           {:project-id (current-project-id state)
            :pane (:pane preview)
            :device (:device preview)
            :width (:width preview)})))

;; --- Events

(defn receive
  "Apply a daemon message to the preview state."
  [msg]
  (ptk/reify ::receive
    ptk/UpdateEvent
    (update [_ state]
      (update-preview state apply-message msg))))

(defn start-preview
  "Ask the daemon to run (or join) the dev server of the open project.
  Without a daemon connection nothing is sent; the preview starts on
  the next connection while the pane is open."
  []
  (let [rid (proto/next-rid)]
    (ptk/reify ::start-preview
      ptk/UpdateEvent
      (update [_ state]
        (if (and (connected? state) (current-project-id state))
          (update-preview state assoc :status :starting :rid rid :code nil :reason nil :message nil)
          state))

      ptk/EffectEvent
      (effect [_ state _]
        (when-let [project-id (current-project-id state)]
          (when (connected? state)
            (client/send! (proto/preview-start project-id rid))))))))

(defn stop-preview
  "Stop the dev server of the open project (for every tab)."
  []
  (let [rid (proto/next-rid)]
    (ptk/reify ::stop-preview
      ptk/UpdateEvent
      (update [_ state]
        (update-preview state assoc :rid rid))

      ptk/EffectEvent
      (effect [_ state _]
        (when-let [project-id (current-project-id state)]
          (client/send! (proto/preview-stop project-id rid)))))))

(defn open-pane
  "Show the preview as `:split` pane or `:overlay` and start the dev
  server unless it is already live."
  [mode]
  (ptk/reify ::open-pane
    ptk/UpdateEvent
    (update [_ state]
      (update-preview state assoc :pane mode))

    ptk/WatchEvent
    (watch [_ state _]
      (if (live? (get-preview state))
        (rx/empty)
        (rx/of (start-preview))))

    ptk/EffectEvent
    (effect [_ state _]
      (save-prefs! state))))

(defn close-pane
  "Hide the preview; the dev server keeps running."
  []
  (ptk/reify ::close-pane
    ptk/UpdateEvent
    (update [_ state]
      (update-preview state assoc :pane nil))

    ptk/EffectEvent
    (effect [_ state _]
      (save-prefs! state))))

(defn toggle-pane
  "Open the split pane, or close the preview when it is shown."
  []
  (ptk/reify ::toggle-pane
    ptk/WatchEvent
    (watch [_ state _]
      (if (some? (:pane (get-preview state)))
        (rx/of (close-pane))
        (rx/of (open-pane :split))))))

(defn set-device
  [device]
  (ptk/reify ::set-device
    ptk/UpdateEvent
    (update [_ state]
      (update-preview state assoc :device device))

    ptk/EffectEvent
    (effect [_ state _]
      (save-prefs! state))))

(defn set-width
  "Set the split pane width (px), clamped to `max-width`."
  [width max-width]
  (ptk/reify ::set-width
    ptk/UpdateEvent
    (update [_ state]
      (update-preview state assoc :width (clamp-width width max-width)))

    ptk/EffectEvent
    (effect [_ state _]
      (save-prefs! state))))

(defn reload
  "Reload the preview frame."
  []
  (ptk/reify ::reload
    ptk/UpdateEvent
    (update [_ state]
      (update-preview state update :reload-key (fnil inc 0)))))

(defn show-app
  "Show the generated app: open the pane (split unless the overlay is
  shown) and start the dev server, or reload the frame when it is
  already live (e.g. after a new build). Used by the Build dialog's
  \"Open preview\" (W08)."
  []
  (ptk/reify ::show-app
    ptk/WatchEvent
    (watch [_ state _]
      (let [preview (get-preview state)]
        (rx/of (if (live? preview) (reload) (start-preview))
               (open-pane (or (:pane preview) :split)))))))

(defn initialize
  "Start following the preview of the project of the open file; mounted
  at file level next to the AI session."
  [project-id]
  (ptk/reify ::initialize
    ptk/UpdateEvent
    (update [_ state]
      (let [project-id (some-> project-id str)]
        (assoc-in state [:penforge :preview]
                  (merge empty-preview
                         {:project-id project-id
                          :device (default-device state)}
                         (load-prefs project-id)))))

    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (rx/merge
                     (rx/filter (ptk/type? ::finalize) stream)
                     (rx/filter (ptk/type? ::initialize) stream))
            project-id* (fn [] (current-project-id @st/state))]
        (->> (rx/merge
              (->> (client/messages stream)
                   (rx/filter (fn [{:keys [type project-id]}]
                                (or (= "error" type)
                                    (and (contains? #{"preview.status" "preview.ready"
                                                      "preview.stopped" "preview.log"}
                                                    type)
                                         (= project-id (project-id*))))))
                   (rx/map receive))

              ;; A finished build (W08 dialog) updates the app; reload a live
              ;; frame. The keyword avoids a cyclic require of the dialog.
              (->> stream
                   (rx/filter (ptk/type? :app.main.ui.workspace.ai.build.events/built))
                   (rx/filter (fn [_] (live? (get-preview @st/state))))
                   (rx/map (fn [_] (reload))))

              ;; (Re)join the dev server on every connection while the
              ;; preview is shown or live, e.g. after a page reload.
              (->> (rx/merge
                    (rx/of :init)
                    (rx/filter (ptk/type? ::client/connected) stream))
                   (rx/filter (fn [_]
                                (let [state @st/state
                                      preview (get-preview state)]
                                  (and (connected? state)
                                       (or (some? (:pane preview))
                                           (live? preview))))))
                   (rx/map (fn [_] (start-preview)))))
             (rx/take-until stopper))))))

(defn finalize
  []
  (ptk/reify ::finalize
    ptk/UpdateEvent
    (update [_ state]
      (update state :penforge dissoc :preview))))
