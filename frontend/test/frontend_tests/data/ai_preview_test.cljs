;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-preview-test
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.build]
   [app.main.data.ai.preview :as preview]
   [app.main.data.ai.protocol :as proto]
   [app.main.store :as st]
   [app.main.ui.workspace.ai.build.events :as build]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.mock :as mock]
   [potok.v2.core :as ptk]))

(defn- watched-types-run
  "Types of the events an action's `:run` emits."
  [action]
  (let [types (atom [])]
    (with-redefs [st/emit! (mock/stub (fn [event] (swap! types conj (ptk/type event))))]
      ((:run action) {:scope :header :state {} :selected #{}}))
    @types))

(defn- json
  [data]
  (js/JSON.stringify (clj->js data)))

(t/deftest the-protocol-reads-preview-status-and-log
  (t/is (= {:type "preview.status" :project-id "p1" :state "ready"
            :url "http://localhost:5200/" :restarts 0}
           (proto/decode (json {"type" "preview.status" "projectId" "p1" "state" "ready"
                                "url" "http://localhost:5200/" "restarts" 0}))))
  (t/is (= {:type "preview.log" :project-id "p1" :stream "stderr" :text "boom"}
           (proto/decode (json {"type" "preview.log" "projectId" "p1"
                                "stream" "stderr" "text" "boom"}))))
  (t/is (nil? (proto/decode (json {"type" "preview.status" "projectId" "p1" "state" "weird"}))))
  (t/testing "unknown reasons still decode"
    (t/is (= "brand-new" (:reason (proto/decode (json {"type" "preview.status" "projectId" "p1"
                                                       "state" "failed" "reason" "brand-new"}))))))
  (t/testing "requests carry an optional rid"
    (t/is (= {:type "preview.start" :project-id "p1" :rid "r1"} (proto/preview-start "p1" "r1")))
    (t/is (= {:type "preview.stop" :project-id "p1"} (proto/preview-stop "p1")))
    (t/is (proto/valid-client-message? (proto/preview-start "p1" "r1")))))

(t/deftest status-messages-drive-the-preview-state
  (let [state (-> preview/empty-preview
                  (preview/apply-message {:type "preview.status" :project-id "p"
                                          :state "starting" :url "http://localhost:5201/"
                                          :restarts 0}))]
    (t/is (= :starting (:status state)))
    (t/is (= "http://localhost:5201/" (:url state)))
    (t/is (preview/live? state))

    (let [ready (preview/apply-message state {:type "preview.ready" :project-id "p"
                                              :url "http://localhost:5201/"})]
      (t/is (= :ready (:status ready)))

      (t/testing "a crash restart keeps the url and counts the restart"
        (let [restarting (preview/apply-message ready {:type "preview.status" :project-id "p"
                                                       :state "starting" :restarts 1
                                                       :reason "restarting"})]
          (t/is (= :starting (:status restarting)))
          (t/is (= :restarting (:reason restarting)))
          (t/is (= 1 (:restarts restarting)))
          (t/is (= "http://localhost:5201/" (:url restarting)))))

      (t/testing "stopped ends a live preview but keeps a failure"
        (t/is (= :stopped (:status (preview/apply-message ready {:type "preview.stopped"
                                                                 :project-id "p"}))))
        (let [failed (preview/apply-message ready {:type "preview.status" :project-id "p"
                                                   :state "failed" :message "nope"})]
          (t/is (= :failed (:status failed)))
          (t/is (= "nope" (:message failed)))
          (t/is (= :failed (:status (preview/apply-message failed {:type "preview.stopped"
                                                                   :project-id "p"})))))))))

(t/deftest only-errors-of-the-last-request-fail-the-preview
  (let [state (assoc preview/empty-preview :status :starting :rid "r1")]
    (t/is (= state (preview/apply-message state {:type "error" :rid "other"
                                                 :code "busy" :message "x"})))
    (t/is (= state (preview/apply-message state {:type "error" :code "busy" :message "x"})))
    (let [failed (preview/apply-message state {:type "error" :rid "r1"
                                               :code "not-configured"
                                               :message "There is no generated app"})]
      (t/is (= :failed (:status failed)))
      (t/is (= "not-configured" (:code failed))))))

(t/deftest logs-keep-the-last-lines
  (let [state (reduce (fn [state index]
                        (preview/apply-message state {:type "preview.log" :project-id "p"
                                                      :stream "stdout" :text (str index)}))
                      preview/empty-preview
                      (range (+ preview/max-logs 5)))]
    (t/is (= preview/max-logs (count (:logs state))))
    (t/is (= {:stream :stdout :text "5"} (first (:logs state))))))

(t/deftest the-split-width-stays-within-bounds
  (t/is (= preview/min-width (preview/clamp-width 10 1000)))
  (t/is (= 700 (preview/clamp-width 900 700)))
  (t/is (= 500 (preview/clamp-width 500 700)))
  (t/is (= preview/min-width (preview/clamp-width 500 100))))

(defn- watched-types
  "Types of the events a potok event emits from its watch."
  [event state]
  (let [types (atom [])]
    (rx/sub! (ptk/watch event state (rx/empty))
             #(swap! types conj (ptk/type %)))
    @types))

(t/deftest show-app-opens-the-pane-and-starts-or-reloads
  (let [idle {:penforge {:preview preview/empty-preview}}
        live {:penforge {:preview (assoc preview/empty-preview :status :ready :pane :overlay)}}]
    (t/is (= [::preview/start-preview ::preview/open-pane]
             (watched-types (preview/show-app) idle)))
    (t/is (= [::preview/reload ::preview/open-pane]
             (watched-types (preview/show-app) live)))
    (t/testing "the build dialog's Open preview goes through it"
      (t/is (= [:app.main.data.modal/hide-modal ::preview/show-app]
               (watched-types (build/open-preview) idle))))))

(t/deftest start-preview-sends-a-request-id
  (let [state   {:current-project-id "p1"
                 :penforge {:connection {:status :connected}
                            :preview preview/empty-preview}}
        updated (ptk/update (preview/start-preview) state)
        preview (get-in updated [:penforge :preview])]
    (t/is (= :starting (:status preview)))
    (t/is (string? (:rid preview)))
    (t/testing "a not-configured reply to that request shows as such"
      (let [failed (preview/apply-message preview {:type "error" :rid (:rid preview)
                                                   :code "not-configured" :message "no app"})]
        (t/is (= :failed (:status failed)))
        (t/is (= "not-configured" (:code failed)))))))

(t/deftest build-is-one-primary-action-that-opens-the-dialog
  (let [registry @actions/registry
        build    (get registry :ai/build)
        toggle   (get registry :ai/preview)]
    (t/is (true? (:primary build)))
    (t/is (contains? (:scopes build) :header))
    (t/is (contains? (:scopes toggle) :main-menu))
    (t/is (nil? (get registry :ai/build-app)) "the dialog has no second Build entry")
    (t/is (= [:ai/build]
             (->> (actions/get-actions registry :main-menu {})
                  (map :id)
                  (filter #{:ai/build :ai/build-app})
                  (vec))))
    (t/is (= [::build/start] (watched-types-run build)))
    (t/testing "build is disabled while any build runs"
      (t/is (actions/enabled? build {}))
      (t/is (not (actions/enabled? build {:penforge {:build {:stage :planning}}})))
      (t/is (not (actions/enabled? build {:penforge {:build {:stage :building}}})))
      (t/is (actions/enabled? build {:penforge {:build {:stage :done}}})))))
