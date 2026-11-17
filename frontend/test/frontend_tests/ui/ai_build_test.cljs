;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-build-test
  "Build pipeline UI (W08): the reducer of the plan and build runs, the
  developer overrides, and a render of every stage of the dialog for
  both personas (jsdom documents, the runner has no DOM)."
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom" :as rd]
   ["react-dom/client" :as rdc]
   [app.main.ui.workspace.ai.build.dialog :as dialog]
   [app.main.ui.workspace.ai.build.events :as build]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def ^:private plan-payload
  {:plan-id "plan-1"
   :mode "full"
   :summary "Login leads to the Dashboard when you press Sign in."
   :question "Build it?"
   :options [{:id "build" :label "Build it"} {:id "cancel" :label "Not now"}]
   :screens [{:board-id "b-login" :name "Login" :status "new"}
             {:board-id "b-dash" :name "Dashboard" :status "changed"}]})

(def ^:private developer-part
  {:stack {:name "React + Vite + TypeScript"
           :commands {:install ["npm" "install"]
                      :build ["npm" "run" "build"]
                      :dev ["npm" "run" "dev"]}}
   :tree "app-src/\n  src/"
   :routes [{:board-id "b-login" :name "Login" :route "/"}
            {:board-id "b-dash" :name "Dashboard" :route "/dashboard"}]
   :components [{:name "PrimaryButton" :purpose "Sign in button"}]
   :notes ""})

(defn- reduce-messages
  [build messages]
  (reduce build/apply-message build messages))

;; --- Reducer

(t/deftest plan-run-ends-on-the-plan-stage
  (let [result (reduce-messages
                (assoc build/initial-state :stage :planning :workflow "build-plan")
                [{:type "workflow.started" :run-id "r1"}
                 {:type "workflow.event" :run-id "r1" :kind "progress"
                  :payload {:step "read" :id "read" :label "Reading the design" :status "running"}}
                 {:type "workflow.event" :run-id "r1" :kind "progress"
                  :payload {:summary "Looking at the design" :status "running"}}
                 {:type "workflow.event" :run-id "r1" :kind "progress"
                  :payload {:step "read" :id "read" :label "Reading the design" :status "done"}}
                 {:type "workflow.event" :run-id "r1" :kind "plan" :payload plan-payload}
                 {:type "workflow.done" :run-id "r1" :ok true :summary "ok"}])]
    (t/is (= :plan (:stage result)))
    (t/is (= plan-payload (:plan result)))
    (t/is (= [{:id "read" :step "read" :label "Reading the design" :status :done}]
             (:steps result)))
    (t/is (nil? (:run-id result)))))

(t/deftest build-run-ends-done-with-the-result
  (let [result (reduce-messages
                (assoc build/initial-state :stage :building :workflow "build-run")
                [{:type "workflow.started" :run-id "r2"}
                 {:type "workflow.event" :run-id "r2" :kind "log" :payload {:text "npm run build ok"}}
                 {:type "workflow.event" :run-id "r2" :kind "result"
                  :payload {:commit "abc" :preview true}}
                 {:type "workflow.done" :run-id "r2" :ok true :summary "Your app is ready."}])]
    (t/is (= :done (:stage result)))
    (t/is (= {:commit "abc" :preview true} (:result result)))
    (t/is (= ["npm run build ok"] (:logs result)))))

(t/deftest failures-keep-the-persona-safe-message
  (let [result (reduce-messages
                (assoc build/initial-state :stage :building :workflow "build-run")
                [{:type "workflow.event" :run-id "r3" :kind "failed"
                  :payload {:message "Please press Build again."}}
                 {:type "workflow.done" :run-id "r3" :ok false :error "Please press Build again."}])]
    (t/is (= :error (:stage result)))
    (t/is (= "Please press Build again." (:failure result))))
  (let [result (build/apply-message (assoc build/initial-state :stage :planning)
                                    {:type "error" :rid "x" :code "unknown-workflow"})]
    (t/is (= :error (:stage result)))
    (t/is (= "unknown-workflow" (:error result)))))

(t/deftest overrides-hold-only-what-the-developer-changed
  (t/is (nil? (dialog/get-overrides developer-part
                                    {:stack-name "React + Vite + TypeScript"
                                     :routes {"b-login" "/" "b-dash" "/dashboard"}
                                     :notes "  "})))
  (t/is (= {:stack-name "Next.js"
            :routes {"b-dash" "/home"}
            :notes "Use CSS modules"}
           (dialog/get-overrides developer-part
                                 {:stack-name " Next.js "
                                  :routes {"b-login" "/" "b-dash" "/home"}
                                  :notes "Use CSS modules"}))))

;; --- Render

(defn- next-immediate
  []
  (js/Promise. (fn [resolve] (js/setImmediate resolve))))

(defn- ^:async render-view
  "Renders `build-view*` once; resolves to `{:markup :errors}`."
  [build persona]
  (let [errors    (volatile! [])
        on-error  (fn [error _info] (vswap! errors conj (.-message error)))
        window    (.-window (JSDOM. "<!doctype html><div id=\"root\"></div>"))
        container (.getElementById (.-document window) "root")
        root      (rdc/createRoot container #js {:onUncaughtError on-error
                                                 :onCaughtError on-error
                                                 :onRecoverableError on-error})
        previous  (.-window js/globalThis)
        markup    (volatile! nil)]
    (set! (.-window js/globalThis) window)
    (try
      (try
        (rd/flushSync
         (fn []
           (.render root (mf/element dialog/build-view* #js {:build build :persona persona}))))
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

(t/deftest ^:async designer-plan-shows-outcomes-only
  (let [{:keys [markup errors]}
        (await (render-view {:stage :plan :plan plan-payload} :designer))]
    (t/is (empty? errors))
    (t/is (includes-all? markup ["Login leads to the Dashboard" "Login" "Dashboard"
                                 "penforge.build.plan.question"
                                 "penforge.build.plan.confirm"]))
    (t/is (not (str/includes? markup "npm")))))

(t/deftest ^:async developer-plan-shows-the-editable-plan
  (let [{:keys [markup errors]}
        (await (render-view {:stage :plan :plan (assoc plan-payload :developer developer-part)}
                            :developer))]
    (t/is (empty? errors))
    (t/is (includes-all? markup ["React + Vite + TypeScript" "npm run build" "/dashboard"
                                 "PrimaryButton" "penforge.build.dev.notes"
                                 "penforge.build.plan.question-developer"]))))

(t/deftest ^:async progress-done-and-error-stages-render
  (let [steps    [{:id "scaffold" :label "Setting up the app" :status :done}
                  {:id "b-login" :label "Building Login" :status :running}]
        planning (await (render-view {:stage :planning :steps steps :activity "Reading the design"} :designer))
        building (await (render-view {:stage :building :steps steps :logs ["npm install ok"]} :designer))
        dev      (await (render-view {:stage :building :steps steps :logs ["npm install ok"]} :developer))
        done     (await (render-view {:stage :done :result {:commit "0123456789abcdef"}} :developer))
        failed   (await (render-view {:stage :error :error "TypeError: boom"} :designer))
        dev-fail (await (render-view {:stage :error :error "TypeError: boom"} :developer))
        offline  (await (render-view {:stage :error :error "not-connected"} :designer))]
    (t/is (every? (comp empty? :errors) [planning building dev done failed dev-fail offline]))
    (t/is (includes-all? (:markup planning) ["Setting up the app" "Reading the design"]))
    (t/is (includes-all? (:markup building) ["Building Login" "penforge.build.hide"]))
    (t/is (not (str/includes? (:markup building) "npm install ok")) "no logs for designers")
    (t/is (str/includes? (:markup dev) "npm install ok"))
    (t/is (includes-all? (:markup done) ["penforge.build.done.open-preview" "penforge.build.dev.commit"]))
    (t/is (str/includes? (:markup failed) "penforge.build.error.generic"))
    (t/is (not (str/includes? (:markup failed) "TypeError")) "no error output for designers")
    (t/is (str/includes? (:markup dev-fail) "TypeError: boom"))
    (t/is (str/includes? (:markup offline) "penforge.build.error.open-ai"))))
