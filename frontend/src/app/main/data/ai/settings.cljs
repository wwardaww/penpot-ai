;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.settings
  "AI settings the Penforge daemon keeps: the command that starts Claude
  and the permission mode.

  In the `:auto` mode the daemon answers permission requests and workflow
  questions itself; the answers are recorded in the chat timeline, where
  the user's own answers are.

  State lives under `[:penforge :settings]`:
  `{:scope :machine|:session, :permission-mode :manual|:auto,
  :claude-command (nil where it cannot be read),
  :save {:status :pending|:saved|:failed, :rid, :error},
  :test {:status :pending|:done|:failed, :rid, :claude-command, :found,
  :kind, :path, :version, :problem, :error}}`, nil until the daemon
  answered. Errors are `{:code :reason}` as the daemon sends them, or
  `{:code \"not-connected\"}`."
  (:require
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.store :as st]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [potok.v2.core :as ptk]))

(def permission-modes
  [:manual :auto])

(def ref:settings
  (l/derived #(get-in % [:penforge :settings]) st/state))

(def ref:connected
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

;; --- Pure helpers

(defn- state-path
  [& ks]
  (into [:penforge :settings] ks))

(defn- reply?
  [state request rid]
  (and (some? rid) (= rid (get-in state (state-path request :rid)))))

(defn- apply-settings
  [state {:keys [rid scope permission-mode claude-command]}]
  (-> state
      (update-in (state-path) merge
                 {:scope (keyword scope)
                  :permission-mode (keyword permission-mode)
                  :claude-command claude-command})
      (cond-> (reply? state :save rid)
        (assoc-in (state-path :save) {:status :saved}))))

(defn- apply-tested
  [state {:keys [rid] :as msg}]
  (if (reply? state :test rid)
    (assoc-in state (state-path :test)
              (-> (select-keys msg [:claude-command :found :kind :path :version :problem])
                  (assoc :status :done)))
    state))

(defn- apply-error
  [state {:keys [rid] :as msg}]
  (if-let [request (some #(when (reply? state % rid) %) [:save :test])]
    (update-in state (state-path request) merge
               {:status :failed :error (select-keys msg [:code :reason])})
    state))

(defn- answer-automatically
  "Record an answer of the daemon in the chat timeline."
  [state id answer]
  (if (some? (get-in state [:penforge :chat]))
    (update-in state [:penforge :chat]
               (fn [chat]
                 (-> (chat/answer-entry chat id answer)
                     (update :entries
                             (fn [entries]
                               (mapv #(cond-> % (= id (:id %)) (assoc :auto true)) entries))))))
    state))

(defn apply-message
  "Apply a daemon message to the state; messages that are not about the
  settings or the daemon's own answers leave it unchanged."
  [state {:keys [type kind payload] :as msg}]
  (case type
    "settings"
    (apply-settings state msg)

    "settings.tested"
    (apply-tested state msg)

    "permission.answered"
    (answer-automatically state (:request-id msg) (if (:allow msg) :allowed :denied))

    "workflow.event"
    (if (= "answered" kind)
      (answer-automatically state (:question-id payload) (:option-id payload))
      state)

    "error"
    (apply-error state msg)

    state))

;; --- Events

(defn- handle-message
  [msg]
  (ptk/reify ::handle-message
    ptk/UpdateEvent
    (update [_ state]
      (apply-message state msg))))

(defn- request
  "Send `message` and remember it as the pending `request` (`:save` or
  `:test`)."
  [state request message]
  (assoc-in state (state-path request)
            (if (client/send! message)
              {:status :pending :rid (:rid message)}
              {:status :failed :error {:code "not-connected"}})))

(defn fetch-settings
  "Ask the daemon for the settings."
  []
  (ptk/reify ::fetch-settings
    ptk/UpdateEvent
    (update [_ state]
      ;; replies to requests of an earlier connection never arrive
      (update-in state (state-path) dissoc :save :test))

    ptk/EffectEvent
    (effect [_ _ _]
      (client/send! (proto/settings-get)))))

(defn set-permission-mode
  "Switch the permission mode (`:manual` or `:auto`)."
  [mode]
  (ptk/reify ::set-permission-mode
    ptk/EffectEvent
    (effect [_ _ _]
      (client/send! (proto/settings-set {:permission-mode mode})))))

(defn save-claude-command
  "Use `command` to start Claude from the next turn on."
  [command]
  (ptk/reify ::save-claude-command
    ptk/UpdateEvent
    (update [_ state]
      (request state :save (proto/settings-set {:claude-command command})))))

(defn check-claude-command
  "Ask the daemon whether `command` starts Claude, without saving it."
  [command]
  (ptk/reify ::check-claude-command
    ptk/UpdateEvent
    (update [_ state]
      (request state :test (proto/settings-test command)))))

(defn clear-results
  "Forget the results of the last save and test."
  []
  (ptk/reify ::clear-results
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path) dissoc :save :test))))

(defn watch-settings
  "Follow the settings and the daemon's own answers until the AI session
  stops."
  []
  (ptk/reify ::watch-settings
    ptk/WatchEvent
    (watch [_ state stream]
      (let [stopper (rx/merge
                     (rx/filter (ptk/type? ::client/finalize) stream)
                     (rx/filter (ptk/type? ::client/initialize) stream)
                     (rx/filter (ptk/type? ::watch-settings) stream))]
        (->> (rx/merge
              (if (= :connected (get-in state [:penforge :connection :status]))
                (rx/of (fetch-settings))
                (rx/empty))
              (->> stream
                   (rx/filter (ptk/type? ::client/connected))
                   (rx/map (fn [_] (fetch-settings))))
              (->> (client/messages stream)
                   (rx/filter (fn [{:keys [type kind]}]
                                (or (contains? #{"settings" "settings.tested" "permission.answered" "error"} type)
                                    (and (= "workflow.event" type) (= "answered" kind)))))
                   (rx/map handle-message)))
             (rx/take-until stopper))))))

;; The AI session starts with `client/initialize` (once per open file, or
;; on the settings page); the watcher follows it.
(defonce settings-watcher-subscription
  (->> st/stream
       (rx/filter (ptk/type? ::client/initialize))
       (rx/subs! (fn [_] (st/emit! (watch-settings))))))
