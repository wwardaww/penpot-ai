;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-comments-test
  (:require
   ["react-dom/server" :as rds]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.comments :as ai-comments]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.store :as st]
   [app.main.ui.workspace.ai.comments.fix-button :refer [fix-with-ai-button*]]
   [app.util.i18n :as i18n]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [frontend-tests.helpers.async :as async]
   [frontend-tests.helpers.mock :as mock]
   [okulary.core :as l]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(def ^:private team-id (uuid/next))
(def ^:private page-id (uuid/next))
(def ^:private thread-id (uuid/next))

(defn- base-state
  [& {:keys [can-edit status read-only]
      :or {can-edit true status :connected read-only false}}]
  {:current-team-id team-id
   :current-page-id page-id
   :teams {team-id {:id team-id :permissions {:can-edit can-edit}}}
   :workspace-global {:read-only? read-only}
   :penforge {:connection {:status status}}})

(defn- daemon-message
  [msg]
  (ptk/data-event ::client/message msg))

(defn- sent-run
  "The `workflow.run` of `name` sent to the daemon, or nil."
  [sent name]
  (some #(when (and (= "workflow.run" (:type %)) (= name (:name %))) %) @sent))

;; --- State helpers

(t/deftest can-fix-needs-the-flag-a-connection-and-edit-rights
  (with-redefs [client/enabled? (constantly true)]
    (t/is (true? (ai-comments/can-fix? (base-state))))
    (t/is (false? (ai-comments/can-fix? (base-state :can-edit false))))
    (t/is (false? (ai-comments/can-fix? (base-state :read-only true))))
    (t/is (false? (ai-comments/can-fix? (base-state :status :pairing)))))
  (with-redefs [client/enabled? (constantly false)]
    (t/is (false? (ai-comments/can-fix? (base-state))))))

(t/deftest fix-thread-marks-the-thread-running-once
  (with-redefs [client/enabled? (constantly true)]
    (let [thread {:id thread-id :page-id page-id}
          state  (ptk/update (ai-comments/fix-thread thread) (base-state))]
      (t/is (= :running (:status (ai-comments/get-thread-fix state thread-id))))
      (t/is (= state (ptk/update (ai-comments/fix-thread thread) state))
            "a running thread is not started twice")
      (t/is (nil? (ai-comments/get-thread-fix
                   (ptk/update (ai-comments/fix-thread thread) (base-state :status :disconnected))
                   thread-id))))))

(t/deftest fix-comments-action-is-in-the-header-for-editors
  (with-redefs [client/enabled? (constantly true)]
    (let [registry @actions/registry
          header   (actions/get-actions registry :header (base-state))
          action   (some #(when (= :ai/fix-comments (:id %)) %) header)]
      (t/is (some? action))
      (t/is (actions/enabled? action (base-state)))
      (t/is (not (actions/enabled? action (assoc-in (base-state) [:penforge-comment-fixes :batch :status] :running))))
      (t/is (not-any? #(= :ai/fix-comments (:id %))
                      (actions/get-actions registry :header (base-state :can-edit false))))
      (t/is (some #(= :ai/fix-file-comments (:id %))
                  (actions/get-actions registry :main-menu (base-state)))))))

;; --- Event flows

(t/deftest ^:async fix-thread-runs-the-workflow-and-records-the-outcome
  (let [sent  (atom [])
        store (ptk/store {:state (base-state) :on-error #(t/is false (str %))})]
    (await
     (mock/with-mocks*
       {client/enabled? (mock/stub (fn [] true))
        client/send!    (mock/stub (fn [msg] (swap! sent conj msg) true))}
       (ptk/emit! store (ai-comments/fix-thread {:id thread-id :page-id page-id}))
       (await (async/wait-for #(sent-run sent "fix-comment") "the run is sent"))
       (let [{:keys [rid params]} (sent-run sent "fix-comment")]
         (t/is (= {:thread-id (str thread-id) :page-id (str page-id)} params))
         (t/is (true? (get-in @store [:penforge :chat :pending-runs rid :silent])))
         (ptk/emit! store
                    (daemon-message {:type "workflow.started" :rid rid :run-id "run-1" :name "fix-comment"})
                    (daemon-message {:type "workflow.event" :run-id "run-1" :kind "result"
                                     :payload {:thread-id (str thread-id) :seq-number 3
                                               :outcome "fixed" :note "The button is blue now."
                                               :resolved true :replied true}})
                    (daemon-message {:type "workflow.done" :run-id "run-1" :ok true
                                     :summary "Fixed comment #3"}))
         (await (async/wait-for-store
                 store
                 #(= :fixed (:status (ai-comments/get-thread-fix @store thread-id)))
                 "the thread is fixed"))
         (await (async/settle))
         (t/is (= {:status :fixed :note "The button is blue now."}
                  (ai-comments/get-thread-fix @store thread-id))))))))

(t/deftest ^:async a-failed-run-marks-the-thread-as-error
  (let [sent  (atom [])
        store (ptk/store {:state (base-state) :on-error #(t/is false (str %))})]
    (await
     (mock/with-mocks*
       {client/enabled? (mock/stub (fn [] true))
        client/send!    (mock/stub (fn [msg] (swap! sent conj msg) true))}
       (ptk/emit! store (ai-comments/fix-thread {:id thread-id}))
       (await (async/wait-for #(sent-run sent "fix-comment") "the run is sent"))
       (let [{:keys [rid params]} (sent-run sent "fix-comment")]
         (t/is (= {:thread-id (str thread-id)} params))
         (ptk/emit! store
                    (daemon-message {:type "workflow.started" :rid rid :run-id "run-2" :name "fix-comment"})
                    (daemon-message {:type "workflow.done" :run-id "run-2" :ok false
                                     :summary "Could not finish" :error "boom"}))
         (await (async/wait-for-store
                 store
                 #(= :error (:status (ai-comments/get-thread-fix @store thread-id)))
                 "the thread fails")))))))

(t/deftest ^:async fix-comments-follows-the-batch
  (let [sent    (atom [])
        other   (uuid/next)
        store   (ptk/store {:state (base-state) :on-error #(t/is false (str %))})]
    (await
     (mock/with-mocks*
       {client/enabled? (mock/stub (fn [] true))
        client/send!    (mock/stub (fn [msg] (swap! sent conj msg) true))
        chat/open-chat  (mock/stub (fn [] (ptk/data-event ::open-chat {})))}
       (ptk/emit! store (ai-comments/fix-comments :page))
       (await (async/wait-for #(sent-run sent "fix-comments") "the batch is sent"))
       (let [{:keys [rid params]} (sent-run sent "fix-comments")]
         (t/is (= {:scope "page" :page-id (str page-id)} params))
         (t/is (false? (get-in @store [:penforge :chat :pending-runs rid :silent]))
               "the batch shows in the AI tab")
         (ptk/emit! store
                    (daemon-message {:type "workflow.started" :rid rid :run-id "run-3" :name "fix-comments"})
                    (daemon-message {:type "workflow.event" :run-id "run-3" :kind "progress"
                                     :payload {:step "fixing" :thread-id (str thread-id) :seq-number 2
                                               :index 1 :total 2 :text "Working on comment #2 (1 of 2)"}}))
         (await (async/wait-for-store
                 store
                 #(= :running (:status (ai-comments/get-thread-fix @store thread-id)))
                 "the thread being fixed shows as running"))
         (ptk/emit! store
                    (daemon-message {:type "workflow.event" :run-id "run-3" :kind "progress"
                                     :payload {:step "fixed" :thread-id (str thread-id) :seq-number 2
                                               :outcome "fixed" :index 1 :total 2}})
                    (daemon-message {:type "workflow.event" :run-id "run-3" :kind "result"
                                     :payload {:fixed [{:thread-id (str thread-id) :seq-number 2
                                                        :outcome "fixed" :note "Bigger title."}]
                                               :skipped [{:thread-id (str other) :seq-number 1
                                                          :reason "informational" :note ""}]
                                               :needs-you []}})
                    (daemon-message {:type "workflow.done" :run-id "run-3" :ok true
                                     :summary "Fixed 1 comment, left 1 without changes"}))
         (await (async/wait-for-store
                 store
                 #(= :done (get-in @store [:penforge-comment-fixes :batch :status]))
                 "the batch ends"))
         (await (async/settle))
         (t/is (= "Fixed 1 comment, left 1 without changes"
                  (get-in @store [:penforge-comment-fixes :batch :summary])))
         (t/is (= {:status :fixed :note "Bigger title."}
                  (ai-comments/get-thread-fix @store thread-id))))))))

;; --- Render

(defn- render-button
  [state thread]
  (with-redefs [st/state        (l/atom state)
                client/enabled? (constantly true)
                i18n/tr         (mock/stub (fn [key] key))]
    (rds/renderToStaticMarkup
     (mf/element fix-with-ai-button* #js {:thread thread}))))

(t/deftest fix-button-renders-for-editors-on-open-threads
  (let [thread {:id thread-id :is-resolved false}
        markup (render-button (base-state) thread)]
    (t/is (str/includes? markup "penforge.comments.fix-with-ai"))
    (t/is (str/includes? markup "data-testid=\"comment-fix-with-ai\""))
    (t/is (not (str/includes? markup "disabled")))))

(t/deftest fix-button-is-hidden-without-rights-connection-or-open-thread
  (let [thread {:id thread-id :is-resolved false}]
    (t/is (= "" (render-button (base-state :can-edit false) thread)))
    (t/is (= "" (render-button (base-state :status :disconnected) thread)))
    (t/is (= "" (render-button (base-state) (assoc thread :is-resolved true))))))

(t/deftest fix-button-shows-the-running-and-final-state
  (let [thread  {:id thread-id :is-resolved false}
        with    (fn [fix] (assoc-in (base-state) [:penforge-comment-fixes :threads thread-id] fix))
        running (render-button (with {:status :running}) thread)
        fixed   (render-button (with {:status :fixed :note "Blue now."}) (assoc thread :is-resolved true))
        failed  (render-button (with {:status :failed}) thread)]
    (t/is (str/includes? running "penforge.comments.fixing"))
    (t/is (str/includes? running "disabled"))
    (t/is (str/includes? fixed "penforge.comments.fixed"))
    (t/is (str/includes? fixed "title=\"Blue now.\""))
    (t/is (str/includes? failed "penforge.comments.fix-failed"))
    (t/is (not (str/includes? failed "disabled")) "a failed fix can be retried")))
