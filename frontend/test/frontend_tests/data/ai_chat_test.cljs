;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-chat-test
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.chat :as chat]
   [cljs.test :as t :include-macros true]))

(def ^:private base
  (assoc chat/empty-chat :conversation-id "c1"))

(defn- reduce-messages
  [chat messages]
  (reduce chat/apply-message chat messages))

(t/deftest deltas-build-one-streaming-assistant-entry
  (let [chat (reduce-messages base
                              [{:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "Hel"}
                               {:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "lo"}])]
    (t/is (= :streaming (:status chat)))
    (t/is (= 1 (count (:entries chat))))
    (t/is (= {:kind :assistant :id "m1" :text "Hello" :streaming true}
             (first (:entries chat))))))

(t/deftest done-ends-the-turn
  (let [chat (reduce-messages base
                              [{:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "Hi"}
                               {:type "chat.tool" :conversation-id "c1" :tool-name "t"
                                :summary "Reading" :status "running"}
                               {:type "chat.done" :conversation-id "c1" :message-id "m1"
                                :usage {:output-tokens 2}}])]
    (t/is (= :idle (:status chat)))
    (t/is (not (contains? (first (:entries chat)) :streaming)))
    (t/is (= {:output-tokens 2} (:usage (first (:entries chat)))))
    (t/is (= :done (:status (second (:entries chat)))) "running tools close with the turn")))

(t/deftest messages-of-other-conversations-are-ignored
  (let [chat (reduce-messages base
                              [{:type "chat.delta" :conversation-id "other" :message-id "m1" :text "x"}
                               {:type "chat.done" :conversation-id "other" :message-id "m1"}])]
    (t/is (= base chat))))

(t/deftest tool-lines-update-in-place
  (let [chat  (reduce-messages base
                               [{:type "chat.tool" :conversation-id "c1" :tool-name "a"
                                 :summary "Reading the design" :status "running"}
                                {:type "chat.tool" :conversation-id "c1" :tool-name "b"
                                 :summary "Looking" :status "running"}
                                {:type "chat.tool" :conversation-id "c1" :tool-name "a"
                                 :summary "Read the design" :status "done" :detail "{}"}])
        [a b] (:entries chat)]
    (t/is (= 2 (count (:entries chat))))
    (t/is (= [:done "Read the design" "{}"] [(:status a) (:summary a) (:detail a)]))
    (t/is (= :running (:status b)))))

(t/deftest history-goes-before-live-entries
  (let [chat (-> base
                 (chat/add-user-message "u2" "live")
                 (chat/apply-message {:type "chat.history" :rid "r" :conversation-id "c1"
                                      :messages [{:role "user" :message-id "u1" :text "old" :ts "t"}
                                                 {:role "assistant" :message-id "a1" :text "answer" :ts "t"}]}))]
    (t/is (= ["u1" "a1" "u2"] (mapv :id (:entries chat))))
    (t/is (= [:user :assistant :user] (mapv :kind (:entries chat))))
    (t/is (= :loaded (:history-status chat)))))

(t/deftest failed-history-request-is-not-an-error-entry
  (let [chat (-> base
                 (assoc :history-rid "h1")
                 (chat/apply-message {:type "error" :rid "h1" :code "not-implemented" :message "x"}))]
    (t/is (empty? (:entries chat)))
    (t/is (= :error (:history-status chat)))))

(t/deftest errors-become-entries
  (let [chat (chat/apply-message base {:type "error" :code "busy" :message "Busy"})]
    (t/is (= [:error "busy"] ((juxt :kind :code) (first (:entries chat)))))))

(t/deftest permission-requests-wait-for-an-answer
  (let [chat  (-> base
                  (chat/apply-message {:type "permission.request" :request-id "p1" :title "Write files"
                                       :description "d" :risk "high"})
                  (chat/answer-entry "p1" :allowed))
        entry (first (:entries chat))]
    (t/is (= [:permission :high :allowed] ((juxt :kind :risk :answer) entry)))))

(t/deftest workflow-runs-follow-their-request
  (let [chat           (-> base
                           (assoc-in [:pending-runs "rid1"] {:name "auto-name" :silent false})
                           (reduce-messages
                            [{:type "workflow.started" :rid "rid1" :run-id "run1" :name "auto-name"}
                             {:type "workflow.event" :run-id "run1" :kind "progress" :payload "Naming layers"}
                             {:type "workflow.event" :run-id "run1" :kind "question"
                              :payload {:question-id "q1" :text "Rename?" :options [{:id "y" :label "Yes"}]}}
                             {:type "workflow.event" :run-id "run1" :kind "log" :payload "debug"}
                             {:type "workflow.event" :run-id "other" :kind "question" :payload {:question-id "q2"}}
                             {:type "workflow.done" :run-id "run1" :ok true :summary "Named 3 layers"}]))
        [run question] (:entries chat)]
    (t/is (empty? (:pending-runs chat)))
    (t/is (= [:workflow :done "Named 3 layers" "Naming layers"]
             ((juxt :kind :status :summary :progress) run)))
    (t/is (= [:question "q1" "run1"] ((juxt :kind :id :run-id) question)))
    (t/is (= 2 (count (:entries chat))) "events of unknown runs are ignored")
    (t/is (= [{:kind "log" :payload "debug"}] (get-in chat [:runs "run1" :events])))))

(t/deftest silent-runs-stay-out-of-the-timeline
  (let [chat (-> base
                 (assoc-in [:pending-runs "rid1"] {:name "x" :silent true})
                 (reduce-messages
                  [{:type "workflow.started" :rid "rid1" :run-id "run1" :name "x"}
                   {:type "workflow.done" :run-id "run1" :ok false :summary "" :error "boom"}]))]
    (t/is (empty? (:entries chat)))
    (t/is (= :error (get-in chat [:runs "run1" :status])))))

(t/deftest failed-run-requests-report-once
  (let [chat (-> base
                 (assoc-in [:pending-runs "rid1"] {:name "x" :silent false})
                 (chat/apply-message {:type "error" :rid "rid1" :code "unknown-workflow" :message "no"}))]
    (t/is (empty? (:pending-runs chat)))
    (t/is (= "unknown-workflow" (:code (first (:entries chat)))))))

(t/deftest end-turn-closes-streaming-entries
  (let [chat (-> base
                 (reduce-messages
                  [{:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "Hi"}
                   {:type "chat.tool" :conversation-id "c1" :tool-name "t" :summary "s" :status "running"}])
                 (chat/end-turn))]
    (t/is (= :idle (:status chat)))
    (t/is (not (contains? (first (:entries chat)) :streaming)))
    (t/is (= :error (:status (second (:entries chat)))))))

(t/deftest user-messages-take-the-pending-attachments
  (let [node {:kind "node" :file-id "f" :page-id "p" :node-id "n1" :name "Card" :type "frame"}
        chat (-> base
                 (chat/add-attachments [node node])
                 (chat/add-attachments [node (assoc node :node-id "n2")]))
        sent (chat/add-user-message chat "u1" "Fix this")]
    (t/is (= ["n1" "n2"] (mapv :node-id (:attachments chat))) "duplicates are skipped")
    (t/is (empty? (:attachments sent)))
    (t/is (= :streaming (:status sent)))
    (t/is (= ["n1" "n2"] (mapv :node-id (:attachments (peek (:entries sent))))))))

;; --- W25: working state, selection context, files

(t/deftest working-follows-turns-and-shown-runs
  (t/is (not (chat/working? base)))
  (t/is (chat/working? (assoc base :status :streaming)))
  (t/is (chat/working? (assoc-in base [:pending-runs "r"] {:name "x" :silent false})))
  (t/is (not (chat/working? (assoc-in base [:runs "run"] {:status :running :silent true})))
        "silent runs do not show as chat work")
  (t/is (chat/busy? (assoc-in base [:runs "run"] {:status :running :silent true}))
        "silent runs may still change the design"))

(t/deftest waiting-means-an-open-question-while-busy
  (let [asked (-> base
                  (assoc :status :streaming)
                  (chat/apply-message {:type "permission.request" :request-id "p1" :title "t"
                                       :description "d" :risk "low"}))]
    (t/is (chat/waiting? asked))
    (t/is (= {:type :waiting} (chat/current-step asked)))
    (t/is (not (chat/waiting? (chat/answer-entry asked "p1" :allowed))))
    (t/is (not (chat/waiting? (assoc asked :status :idle))) "a finished turn waits for nothing")))

(t/deftest current-step-names-what-runs-now
  (let [sent (chat/add-user-message base "u1" "hi")]
    (t/is (= {:type :thinking} (chat/current-step sent)))
    (t/is (= {:type :tool :text "Reading the design"}
             (chat/current-step
              (chat/apply-message sent {:type "chat.tool" :conversation-id "c1" :tool-name "t"
                                        :summary "Reading the design" :status "running"}))))
    (t/is (= {:type :writing}
             (chat/current-step
              (chat/apply-message sent {:type "chat.delta" :conversation-id "c1"
                                        :message-id "m1" :text "Hi"}))))
    (t/is (= {:type :workflow :text "Building the board"}
             (chat/current-step
              (-> base
                  (assoc-in [:pending-runs "rid1"] {:name "g" :silent false})
                  (reduce-messages
                   [{:type "workflow.started" :rid "rid1" :run-id "run1" :name "g"}
                    {:type "workflow.event" :run-id "run1" :kind "progress"
                     :payload {:step "board" :text "Building the board"}}])))))))

(t/deftest activity-records-start-end-and-outcome
  (let [sent  (chat/add-user-message base "u1" "hi")
        start (chat/track-activity base sent 1000)
        done  (chat/track-activity start
                                   (chat/apply-message start {:type "chat.done" :conversation-id "c1"
                                                              :message-id "m1"})
                                   61000)]
    (t/is (= {:started-at 1000 :from 0} (:activity start)))
    (t/is (= {:started-at 1000 :from 0 :ended-at 61000 :outcome :done} (:activity done))))

  (t/testing "an error while working ends as failed"
    (let [start  (chat/track-activity base (chat/add-user-message base "u1" "hi") 0)
          failed (chat/track-activity start
                                      (chat/apply-message start {:type "error" :rid "u1"
                                                                 :code "internal" :message "x"})
                                      5)
          ended  (chat/track-activity failed
                                      (chat/apply-message failed {:type "chat.done" :conversation-id "c1"
                                                                  :message-id "m"})
                                      9)]
      (t/is (:failed (:activity failed)))
      (t/is (= :error (get-in ended [:activity :outcome])))))

  (t/testing "a cancelled turn ends as stopped"
    (let [start (-> (chat/track-activity base (chat/add-user-message base "u1" "hi") 0)
                    (assoc-in [:activity :cancelled] true))
          ended (chat/track-activity start (chat/end-turn start) 3)]
      (t/is (= :cancelled (get-in ended [:activity :outcome])))))

  (t/testing "silent runs leave the activity alone"
    (let [silent (assoc-in base [:pending-runs "r"] {:name "x" :silent true})]
      (t/is (nil? (:activity (chat/track-activity base silent 1)))))))

(def ^:private objects
  (let [a (uuid/next) b (uuid/next)]
    {:ids [a b]
     :objects {a {:id a :name "Button" :type :rect}
               b {:id b :name "Card" :type :frame}}}))

(t/deftest the-selection-is-the-default-context
  (let [{:keys [ids objects]} objects
        context (chat/selection-context base ids objects "f" "p")]
    (t/is (= ["Button" "Card"] (mapv :name context)))
    (t/is (= ["node" "node"] (mapv :kind context)))
    (t/is (= [(str (first ids)) (str (second ids))] (mapv :node-id context)))
    (t/is (= "p" (:page-id (first context))))
    (t/is (nil? (chat/selection-context base [] objects "f" "p")) "nothing selected")
    (t/is (nil? (chat/selection-context (assoc base :dismissed-selection (set ids)) ids objects "f" "p"))
          "the user removed this selection")
    (t/is (= 1 (count (chat/selection-context (assoc base :dismissed-selection (set ids))
                                              [(first ids)] objects "f" "p")))
          "a new selection comes back")
    (t/is (nil? (chat/selection-context
                 (chat/add-attachments base [{:kind "node" :node-id "n" :name "x"}])
                 ids objects "f" "p"))
          "layers attached by hand replace the selection")
    (t/is (= 1 (count (chat/selection-context
                       (chat/add-attachments base [{:kind "file" :id "f1" :name "a.png"}])
                       [(first ids)] objects "f" "p")))
          "files do not replace the selection")))

(t/deftest selection-context-joins-the-message
  (let [node    {:kind "node" :file-id "f" :page-id "p" :node-id "n1" :name "Button" :type "rect"}
        sent    (chat/add-user-message base "u1" "make it blue" [node])
        entry   (peek (:entries sent))]
    (t/is (= [node] (:attachments entry)))
    (t/is (= [node] (get-in sent [:outbox "u1"])))))

(t/deftest files-go-out-with-bytes-and-stay-in-the-timeline-without
  (let [file  {:kind "file" :id "local-1" :name "shot.png" :mime "image/png" :size 3 :base64 "AAAA"}
        chat  (chat/add-attachments base [file (assoc file :id "local-2" :name "b.png")])
        sent  (chat/add-user-message chat "u1" "build this")
        entry (peek (:entries sent))]
    (t/is (= 2 (count (:attachments chat))) "files are never deduplicated as nodes")
    (t/is (= [{:kind "file" :name "shot.png" :mime "image/png" :size 3 :base64 "AAAA"}
              {:kind "file" :name "b.png" :mime "image/png" :size 3 :base64 "AAAA"}]
             (get-in sent [:outbox "u1"]))
          "the daemon gets the bytes, not the local id")
    (t/is (every? #(not (contains? % :base64)) (:attachments entry)))
    (t/is (= ["local-1" "local-2"] (mapv chat/attachment-key (:attachments entry))))
    (t/is (= {} (:outbox (chat/end-turn sent))) "a lost turn drops what did not go out")))

(t/deftest a-lost-connection-interrupts-every-run
  (let [chat  (-> base
                  (assoc-in [:pending-runs "r0"] {:name "x" :silent true})
                  (assoc-in [:pending-runs "r1"] {:name "generate-screen" :silent false})
                  (reduce-messages [{:type "workflow.started" :rid "r1" :run-id "run1" :name "generate-screen"}])
                  (assoc-in [:runs "run2"] {:run-id "run2" :status :running :silent true}))
        start (chat/track-activity base chat 0)
        lost  (chat/track-activity start (chat/end-turn start) 5)]
    (t/is (chat/busy? start))
    (t/is (not (chat/busy? lost)) "nothing keeps the canvas glow or the status bar alive")
    (t/is (not (chat/working? lost)))
    (t/is (empty? (:pending-runs lost)))
    (t/is (= #{:interrupted} (set (map :status (vals (:runs lost))))))
    (t/is (= :error (:status (first (filter #(= :workflow (:kind %)) (:entries lost))))))
    (t/is (= :interrupted (get-in lost [:activity :outcome])))))

(t/deftest failed-steps-count-only-the-last-activity
  (let [old   (chat/apply-message base {:type "chat.tool" :conversation-id "c1" :tool-name "a"
                                        :summary "s" :status "error"})
        start (chat/track-activity old (chat/add-user-message old "u1" "hi") 0)
        after (reduce chat/apply-message start
                      [{:type "chat.tool" :conversation-id "c1" :tool-name "t" :summary "s" :status "running"}
                       {:type "chat.tool" :conversation-id "c1" :tool-name "t" :summary "s" :status "error"}
                       {:type "chat.tool" :conversation-id "c1" :tool-name "penforge_canvas_check"
                        :summary "The screens overlap" :status "error"}
                       {:type "chat.tool" :conversation-id "c1" :tool-name "u" :summary "s" :status "done"}])]
    (t/is (= 1 (chat/failed-steps old)) "without an activity every step counts")
    (t/is (= 2 (chat/failed-steps after)) "the step that failed before this work is left out")))

(t/deftest retried-steps-do-not-count-as-failed
  (let [start (chat/track-activity base (chat/add-user-message base "u1" "hi") 0)
        after (reduce chat/apply-message start
                      [{:type "chat.tool" :conversation-id "c1" :tool-name "x" :summary "s" :status "running"}
                       {:type "chat.tool" :conversation-id "c1" :tool-name "x" :summary "s" :status "error"}
                       {:type "chat.tool" :conversation-id "c1" :tool-name "x" :summary "s" :status "running"}
                       {:type "chat.tool" :conversation-id "c1" :tool-name "x" :summary "s" :status "done"}])]
    (t/is (= 0 (chat/failed-steps after)))))

(t/deftest check-codes-and-refusal-reasons-are-kept
  (let [chat (reduce chat/apply-message base
                     [{:type "chat.tool" :conversation-id "c1" :tool-name "penforge_canvas_check"
                       :summary "s" :status "error" :code "boards-overlap" :params {:names ["A" "B"]}}
                      {:type "error" :rid "u1" :code "bad-request" :message "m"
                       :reason "file-type" :params {:name "a.exe"}}])
        [tool error] (:entries chat)]
    (t/is (= ["boards-overlap" {:names ["A" "B"]}] ((juxt :code :params) tool)))
    (t/is (= ["file-type" {:name "a.exe"}] ((juxt :reason :params) error)))))

(t/deftest only-questions-of-running-work-wait
  (let [question {:kind :question :id "q1" :run-id "run1" :text "?" :options []}
        stale    (-> base
                     (assoc :entries [question])
                     (assoc-in [:runs "run1"] {:status :done :silent true})
                     (assoc-in [:runs "run2"] {:status :running :silent true}))]
    (t/is (not (chat/waiting? stale)) "an old question of an ended run does not wait")
    (t/is (chat/waiting? (assoc-in stale [:runs "run1" :status] :running)))
    (t/is (not (chat/waiting? (-> base
                                  (assoc :entries [{:kind :permission :id "p1" :title "t" :risk :low}]))))
          "a permission request waits only during its turn")))
