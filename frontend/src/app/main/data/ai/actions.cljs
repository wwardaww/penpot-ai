;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions
  "Registry of Penforge AI actions (architecture §7).

  Every feature registers its actions from its own namespace
  `app.main.data.ai.actions.<name>` and adds one require line to
  `app.main.data.ai.actions.all`. The context menu, the main menu
  \"AI\" submenu, the header strip and (later) the command palette
  render from this registry, filtered by scope.

  An action is a map:

  - `:id` qualified keyword, unique (`:ai/auto-name`)
  - `:label` fn of no args returning the translated label; call `tr`
    with a literal key inside it (`#(tr \"penforge.actions.x\")`) so
    the translation scanner sees the key
  - `:icon` optional DS icon id (`i/text`)
  - `:scopes` set of `:context-menu` `:main-menu` `:header`
    `:command-palette`
  - `:order` optional number; lower first, then by id
  - `:visible?` optional fn of the app state; hidden when false
  - `:enabled?` optional fn of the app state; disabled when false
  - `:run` fn of a context map `{:scope :state :selected}` that does
    the work, usually emitting events (`st/emit!`)"
  (:require
   [app.common.schema :as sm]
   [app.main.store :as st]))

(def scopes
  #{:context-menu :main-menu :header :command-palette})

(def schema:action
  [:map {:title "AiAction"}
   [:id :qualified-keyword]
   [:label fn?]
   [:icon {:optional true} :string]
   [:scopes [:set (into [:enum] scopes)]]
   [:order {:optional true} number?]
   [:visible? {:optional true} fn?]
   [:enabled? {:optional true} fn?]
   [:run fn?]])

(def ^:private check-action
  (sm/check-fn schema:action :hint "invalid AI action"))

(defonce registry
  (atom {}))

(defn register-action!
  "Register (or replace) an action in the registry."
  [action]
  (let [action (check-action action)]
    (swap! registry assoc (:id action) action)
    action))

(defn unregister-action!
  [id]
  (swap! registry dissoc id))

(defn get-actions
  "Actions of the given scope that are visible for the state, in
  display order."
  [actions scope state]
  (->> (vals actions)
       (filter #(contains? (:scopes %) scope))
       (filter #(if-let [visible? (:visible? %)] (visible? state) true))
       (sort-by (juxt #(or (:order %) 100) #(str (:id %))))
       (vec)))

(defn enabled?
  [action state]
  (if-let [enabled-fn (:enabled? action)]
    (boolean (enabled-fn state))
    true))

(defn get-label
  [action]
  ((:label action)))

(defn run-action
  "Run an action from a scope."
  [action scope]
  (let [state @st/state]
    (when (enabled? action state)
      ((:run action) {:scope scope
                      :state state
                      :selected (get-in state [:workspace-local :selected])}))))
