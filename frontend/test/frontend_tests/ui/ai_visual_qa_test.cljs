;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-visual-qa-test
  "Visual QA (W18): the reducer of the `visual-qa` runs and a render of
  the report panel's body and buttons for every state and both
  personas (jsdom documents, the runner has no DOM)."
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom" :as rd]
   ["react-dom/client" :as rdc]
   [app.main.data.ai.actions :as actions]
   [app.main.ui.workspace.ai.qa.events :as qa]
   [app.main.ui.workspace.ai.qa.panel :as panel]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def ^:private pixel
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

(def ^:private images
  {:design pixel :app pixel :diff pixel})

(def ^:private check-result
  {:mode "check"
   :run-name "20261118T101500-ab12"
   :trigger "user"
   :threshold 90
   :settings {:threshold 90 :max-iterations 3 :auto-run-after-build false}
   :score 89
   :passed false
   :screens [{:board-id "b-home" :name "Home" :route "/" :width 390 :height 844
              :score 78 :passed false :ssim 0.912 :pixel-diff 12.4 :images images
              :paths {:design ".penforge/qa/r/home-design.png"
                      :app ".penforge/qa/r/home-app.png"
                      :diff ".penforge/qa/r/home-diff.png"}}
             {:board-id "b-login" :name "Login" :route "/login" :width 390 :height 844
              :score 100 :passed true :ssim 1 :pixel-diff 0 :images images}]
   :skipped-screens [{:board-id "b-task" :name "Task" :route "/task/:id" :reason "dynamic-route"}]
   :commit nil
   :checkpoint nil})

(def ^:private fix-result
  (-> check-result
      (assoc :mode "fix" :commit "abc123" :checkpoint "cp-4" :score 97 :passed true)
      (assoc-in [:screens 0] {:board-id "b-home" :name "Home" :route "/" :width 390 :height 844
                              :score 94 :before 78 :attempts 2 :passed true :ssim 0.98
                              :pixel-diff 2.1 :images images :changed-files ["src/Home.tsx"]})))

(defn- reduce-messages
  [qa messages]
  (reduce qa/apply-run-message qa messages))

;; --- Reducer

(t/deftest check-run-keeps-progress-then-the-result
  (let [running (reduce-messages
                 {:status :running :mode :check :rid "r1"}
                 [{:type "workflow.started" :run-id "run-1"}
                  {:type "workflow.event" :run-id "run-1" :kind "progress"
                   :payload {:step "compare" :params {:name "Home"} :text "Comparing Home"}}
                  {:type "workflow.event" :run-id "run-1" :kind "progress"
                   :payload {:summary "Reading a file" :status "running"}}])
        done    (reduce-messages
                 running
                 [{:type "workflow.event" :run-id "run-1" :kind "result" :payload check-result}
                  {:type "workflow.done" :run-id "run-1" :ok true :summary "1 of 2 screens match"}])]
    (t/is (= "run-1" (:run-id running)))
    (t/is (= "compare" (get-in running [:progress :step])))
    (t/is (= "Reading a file" (:activity running)))
    (t/is (= :done (:status done)))
    (t/is (= check-result (:result done)))
    (t/is (= (:settings check-result) (:settings done)))
    (t/is (nil? (:progress done)))
    (t/is (= ["b-home"] (qa/failing-board-ids (:result done))))
    (t/is (= [1 2] (qa/match-counts (:result done))))))

(t/deftest failed-runs-keep-the-code
  (let [result (reduce-messages
                {:status :running :mode :check}
                [{:type "workflow.started" :run-id "run-2"}
                 {:type "workflow.event" :run-id "run-2" :kind "failed"
                  :payload {:code "not-built" :message "The app has not been built yet."}}
                 {:type "workflow.done" :run-id "run-2" :ok false :error "The app has not been built yet."}])]
    (t/is (= :error (:status result)))
    (t/is (= "not-built" (:error-code result)))
    (t/is (= "penforge.qa.error.not-built" (panel/error-text result false))))
  (let [result (qa/apply-run-message {:status :running}
                                     {:type "error" :code "busy" :message "busy"})]
    (t/is (= :error (:status result)))
    (t/is (= "busy" (:error-code result)))))

(t/deftest side-results-update-settings-and-acceptance
  (let [qa (-> {:status :done :result check-result}
               (qa/apply-run-message {:type "workflow.event" :kind "result"
                                      :payload {:mode "settings"
                                                :settings {:threshold 90 :auto-run-after-build true}}})
               (qa/apply-run-message {:type "workflow.event" :kind "result"
                                      :payload {:mode "accept" :run-name "20261118T101500-ab12"}}))]
    (t/is (true? (get-in qa [:settings :auto-run-after-build])))
    (t/is (= "20261118T101500-ab12" (:accepted qa)))
    (t/is (= check-result (:result qa)) "a side run keeps the report")))

(t/deftest skipped-automatic-runs-are-flagged
  (let [qa (qa/apply-run-message {:status :running :auto true}
                                 {:type "workflow.event" :kind "result"
                                  :payload {:mode "check" :trigger "build" :skipped true
                                            :settings {:auto-run-after-build false}}})]
    (t/is (true? (:skipped qa)))
    (t/is (nil? (:result qa)))))

(t/deftest progress-steps-are-translated
  (t/is (= "penforge.qa.step.fix" (panel/progress-text {:step "fix" :params {:name "Home" :attempt 1 :of 3}})))
  (t/is (= "penforge.qa.step.preview" (panel/progress-text {:step "preview"})))
  (t/is (= "Doing something" (panel/progress-text {:step "unknown" :text "Doing something"}))))

(t/deftest the-action-is-registered
  (t/is (some #(= :ai/visual-qa (:id %)) (actions/get-actions @actions/registry :main-menu {}))))

;; --- Render

(defn- next-immediate
  []
  (js/Promise. (fn [resolve] (js/setImmediate resolve))))

(defn- ^:async render
  "Renders the panel's body and footer once; resolves to `{:markup :errors}`."
  [state persona]
  (let [errors    (volatile! [])
        on-error  (fn [error _info] (vswap! errors conj (.-message error)))
        window    (.-window (JSDOM. "<!doctype html><div id=\"root\"></div>"))
        container (.getElementById (.-document window) "root")
        root      (rdc/createRoot container #js {:onUncaughtError on-error
                                                 :onCaughtError on-error
                                                 :onRecoverableError on-error})
        previous  (.-window js/globalThis)
        markup    (volatile! nil)
        noop      (fn [& _])]
    (set! (.-window js/globalThis) window)
    (try
      (try
        (rd/flushSync
         (fn []
           (.render root
                    (mf/html
                     [:div
                      [:> panel/qa-view* {:qa state :persona persona :on-auto-run-change noop :on-answer noop}]
                      [:> panel/qa-footer* {:qa state :on-stop noop :on-check noop :on-fix noop
                                            :on-keep-fixing noop :on-accept noop :on-close noop}]]))))
        (vreset! markup (.-innerHTML container))
        (finally
          (rd/flushSync #(.unmount root))
          (.close window)))
      (await (next-immediate))
      (finally
        (set! (.-window js/globalThis) previous)))
    {:markup @markup :errors @errors}))

(defn- includes-all?
  [markup texts]
  (every? #(str/includes? markup %) texts))

(t/deftest ^:async every-state-renders
  (let [idle     (await (render {:status :idle} :designer))
        running  (await (render {:status :running :mode :fix
                                 :progress {:step "fix" :params {:name "Home" :attempt 1 :of 3}}
                                 :activity "Editing src/Home.tsx"
                                 :result check-result}
                                :developer))
        failed   (await (render {:status :error :error-code "no-browser"} :designer))
        crashed  (await (render {:status :error :error "TypeError: boom"} :developer))
        checked  (await (render {:status :done :mode :check :result check-result
                                 :settings (:settings check-result)}
                                :designer))
        dev      (await (render {:status :done :mode :check :result check-result} :developer))
        fixed    (await (render {:status :done :mode :fix :result fix-result} :designer))]
    (doseq [{:keys [errors]} [idle running failed crashed checked dev fixed]]
      (t/is (empty? errors)))
    (t/is (str/includes? (:markup idle) "penforge.qa.intro"))
    (t/is (includes-all? (:markup running) ["penforge.qa.step.fix" "Editing src/Home.tsx" "penforge.qa.stop"]))
    (t/is (str/includes? (:markup failed) "penforge.qa.error.no-browser"))
    (t/is (str/includes? (:markup crashed) "penforge.qa.error.generic-detail"))
    (t/is (includes-all? (:markup checked) ["Home" "Login" "penforge.qa.some-differ"
                                            "penforge.qa.score.differs" "penforge.qa.score.matches"
                                            "penforge.qa.fix" "penforge.qa.accept"
                                            "penforge.qa.skipped.dynamic-route"
                                            "data:image/png;base64"]))
    (t/is (not (str/includes? (:markup checked) "home-diff.png")) "no file paths for designers")
    (t/is (not (str/includes? (:markup checked) "penforge.qa.stop")))
    (t/is (includes-all? (:markup dev) ["home-diff.png" "penforge.qa.metrics" "/login"]))
    (t/is (includes-all? (:markup fixed) ["penforge.qa.all-match" "penforge.qa.before" "penforge.qa.saved"
                                          "penforge.qa.undo-hint" "penforge.qa.done"]))
    (t/is (not (str/includes? (:markup fixed) "penforge.qa.keep-fixing")))))

(t/deftest ^:async keep-fixing-after-an-unfinished-fix
  (let [unfinished (assoc-in fix-result [:screens 0 :passed] false)
        {:keys [markup errors]} (await (render {:status :done :mode :fix :result unfinished} :designer))]
    (t/is (empty? errors))
    (t/is (includes-all? markup ["penforge.qa.keep-fixing" "penforge.qa.accept"]))))

(t/deftest lost-connections-end-the-run
  (let [qa (reduce-messages {:status :running :mode :fix :run-id "run-3"
                             :progress {:step "fix"}
                             :question {:question-id "q1"}}
                            [{:type "interrupted"}])]
    (t/is (= :error (:status qa)))
    (t/is (= "interrupted" (:error-code qa)))
    (t/is (nil? (:run-id qa)))
    (t/is (nil? (:question qa)))
    (t/is (= "penforge.qa.error.interrupted" (panel/error-text qa false))))
  (t/is (qa/terminal-message? {:type "interrupted"}))
  (t/is (qa/terminal-message? {:type "workflow.done"}))
  (t/is (not (qa/terminal-message? {:type "workflow.event"}))))

(t/deftest questions-wait-in-the-panel
  (let [question {:question-id "q1" :text "The app's code has 2 changed file(s)…"
                  :options [{:id "fix" :label "Fix anyway"} {:id "check" :label "Only check"}]}
        qa       (qa/apply-run-message {:status :running :mode :fix}
                                       {:type "workflow.event" :kind "question" :payload question})]
    (t/is (= question (:question qa)))))

(t/deftest ^:async questions-and-limits-render
  (let [question {:question-id "q1" :text "…"
                  :options [{:id "fix" :label "Fix anyway"} {:id "check" :label "Only check"}]}
        asking   (await (render {:status :running :mode :fix :question question} :designer))
        limited  (await (render {:status :done :mode :fix
                                 :result (assoc fix-result :limit "turns"
                                                :skipped-screens [{:board-id "b-x" :name "Extra" :reason "limit"}])}
                                :designer))]
    (t/is (empty? (:errors asking)))
    (t/is (empty? (:errors limited)))
    (t/is (includes-all? (:markup asking) ["penforge.qa.question.dirty" "penforge.qa.question.fix-anyway"
                                           "penforge.qa.question.only-check"]))
    (t/is (includes-all? (:markup limited) ["penforge.qa.limit.turns" "penforge.qa.skipped.limit"]))))
