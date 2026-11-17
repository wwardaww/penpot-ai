;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-generate-test
  "W13: the generate-screen action, its workflow params, the result
  handling and a render of the prompt dialog."
  (:require
   ["react-dom/server" :as rds]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [app.main.data.ai.actions.generate :as gen]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.workspace.selection :as dws]
   [app.main.ui.hooks :as hooks]
   [app.main.ui.workspace.ai.generate.dialog :as dialog]
   [app.util.i18n :as i18n]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(def ^:private file-id (uuid/next))
(def ^:private page-id (uuid/next))
(def ^:private project-id (uuid/next))
(def ^:private board-id (uuid/next))

(defn- workspace-state
  [& {:keys [connected objects read-only platform]}]
  {:current-file-id file-id
   :current-page-id page-id
   :current-project-id project-id
   :penforge-project-settings (if platform {project-id platform} {})
   :workspace-global {:read-only? (boolean read-only)}
   :files {file-id {:id file-id
                    :data {:pages [page-id]
                           :pages-index {page-id {:id page-id
                                                  :objects (or objects {})}}}}}
   :penforge {:connection {:status (if connected :connected :disconnected)}}})

(defn- collect
  "Subscribe to `observable` and return an atom with every value it
  emits (the sources in these tests are synchronous)."
  [observable]
  (let [values (atom [])]
    (rx/sub! observable #(swap! values conj %))
    values))

;; --- params

(t/deftest workflow-params-are-trimmed-and-optional-values-left-out
  (let [ref-id (uuid/next)]
    (t/is (= {:prompt "login screen"
              :platform "mobile"
              :target-page-id (str page-id)
              :reference-node-ids [(str ref-id)]}
             (gen/workflow-params {:prompt "  login screen "
                                   :platform :mobile
                                   :page-id page-id
                                   :reference-ids [ref-id]}))))
  (t/is (= {:prompt "login"}
           (gen/workflow-params {:prompt "login" :reference-ids []}))))

;; --- action

(t/deftest the-action-is-registered-in-the-main-menu-and-palette
  (let [registry @actions/registry
        action   (get registry :ai/generate-screen)]
    (t/is (some? action))
    (t/is (= #{:main-menu :command-palette} (:scopes action)))
    (doseq [scope [:main-menu :command-palette]]
      (t/is (some #(= :ai/generate-screen (:id %))
                  (actions/get-actions registry scope (workspace-state)))
            (str scope)))
    (t/is (actions/enabled? action (workspace-state)))
    (t/is (not (actions/enabled? action (workspace-state :read-only true))))))

(t/deftest dialog-props-default-to-the-project-platform
  (let [selected #{(uuid/next)}
        props    (gen/dialog-props (workspace-state :platform :mobile) selected)]
    (t/is (= :mobile (:platform props)))
    (t/is (= (vec selected) (:selection props)))
    (t/is (= page-id (:page props)))
    (t/is (fn? (:submit props))))
  (t/is (= :web (:platform (gen/dialog-props (workspace-state) [])))))

;; --- events

(t/deftest generate-screen-starts-the-workflow-and-selects-the-board
  (let [stream (rx/subject)
        state  (workspace-state :connected true)
        events (collect (ptk/watch (gen/generate-screen {:prompt "login"
                                                         :platform :web
                                                         :page-id page-id})
                                   state stream))
        run    (some #(when (= ::chat/run-workflow (ptk/type %)) %) @events)]
    (t/is (some #(= ::chat/open-chat (ptk/type %)) @events))
    (t/is (some? run))
    ;; the request id is internal to the event: read it from the pending
    ;; run it stores
    (let [state' (ptk/update run state)
          rid    (-> state' (get-in [:penforge :chat :pending-runs]) keys first)]
      (t/is (= {:name "generate-screen" :silent false}
               (get-in state' [:penforge :chat :pending-runs rid])))
      (rx/push! stream (ptk/data-event ::client/message
                                       {:type "workflow.started" :rid rid :run-id "run-1"
                                        :name "generate-screen"}))
      (rx/push! stream (ptk/data-event ::client/message
                                       {:type "workflow.event" :run-id "run-1" :kind "progress"
                                        :payload {:text "Designing the screen"}}))
      (rx/push! stream (ptk/data-event ::client/message
                                       {:type "workflow.event" :run-id "run-1" :kind "result"
                                        :payload {:board-id (str board-id)
                                                  :page-id (str page-id)}}))
      (let [shown (last @events)]
        (t/is (= ::gen/show-result (ptk/type shown)))))
    (rx/end! stream)))

(t/deftest generate-screen-does-not-follow-a-run-when-disconnected
  (let [stream (rx/subject)
        events (collect (ptk/watch (gen/generate-screen {:prompt "login"})
                                   (workspace-state) stream))]
    (t/is (= [::chat/open-chat ::chat/run-workflow] (mapv ptk/type @events)))
    (t/is (false? (.-observed stream)))
    (rx/end! stream)))

(t/deftest show-result-selects-a-board-of-the-current-page
  (let [objects {board-id {:id board-id :type :frame}}
        payload {:board-id (str board-id) :page-id (str page-id)}
        shown   (collect (ptk/watch (gen/show-result payload)
                                    (workspace-state :objects objects) nil))]
    (t/is (= 2 (count @shown)))
    (t/is (= ::dws/select-shapes (ptk/type (first @shown)))))
  (t/is (empty? @(collect (ptk/watch (gen/show-result {:board-id (str board-id)
                                                       :page-id (str (uuid/next))})
                                     (workspace-state :objects {board-id {:id board-id}}) nil))))
  (t/is (empty? @(collect (ptk/watch (gen/show-result {:board-id (str board-id)
                                                       :page-id (str page-id)})
                                     (workspace-state) nil))))
  (t/is (empty? @(collect (ptk/watch (gen/show-result {:board-id "not-a-uuid"})
                                     (workspace-state) nil)))))

;; --- dialog

(defn- render-dialog
  [props]
  ;; static markup: no DOM for the tooltip portals of the buttons
  (with-redefs [i18n/tr (fn ([key] key) ([key & _] key))
                hooks/use-portal-container (fn ([] nil) ([_] nil))]
    (rds/renderToStaticMarkup
     ;; a map, as the modal registry passes it
     (mf/element dialog/generate-screen-dialog* props))))

(t/deftest the-dialog-renders-with-and-without-a-selection
  (let [markup (render-dialog {:platform :mobile :selection [] :page page-id})]
    (t/is (str/includes? markup "penforge.generate.title"))
    (t/is (str/includes? markup "penforge-generate-prompt"))
    (t/is (str/includes? markup "penforge.generate.platform.mobile"))
    (t/is (str/includes? markup "penforge.generate.use-selection-empty"))
    ;; nothing typed yet: the submit button is disabled
    (t/is (re-find #"<button[^>]*disabled[^>]*data-testid=\"penforge-generate-submit\"|<button[^>]*data-testid=\"penforge-generate-submit\"[^>]*disabled"
                   markup)))
  (let [markup (render-dialog {:platform :web :selection [(uuid/next)] :page page-id})]
    (t/is (str/includes? markup "penforge.generate.use-selection"))
    (t/is (not (str/includes? markup "penforge.generate.use-selection-empty")))))

(t/deftest can-generate-needs-a-prompt-within-the-limit
  (t/is (dialog/can-generate? "login"))
  (t/is (not (dialog/can-generate? "   ")))
  (t/is (not (dialog/can-generate? nil)))
  (t/is (not (dialog/can-generate? (apply str (repeat (inc dialog/max-prompt-length) "x"))))))
