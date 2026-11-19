;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-design-system-test
  "Design system UI (W29): the chat start card and the dashboard list
  render in each of their states."
  (:require
   ["react-dom/server" :as rds]
   [app.main.ui.dashboard.penforge.design-systems.page :as page]
   [app.main.ui.workspace.ai.design-system.fig :as fig]
   [app.main.ui.workspace.ai.design-system.start :as start]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- js-props
  "Shallow JS props (values stay CLJS data, as rumext passes them)."
  [props]
  (let [result #js {}]
    (doseq [[k v] props]
      (unchecked-set result (name k) v))
    result))

(defn- render-card
  [props]
  (rds/renderToStaticMarkup
   (mf/element start/start-card*
               (js-props (merge {:onDesignMd identity :onDescribe identity :onGithub identity
                                 :onFig identity :onPublish identity}
                                props)))))

(t/deftest start-card-before-generation
  (let [html (render-card {:marker {:name "Acme"} :canEdit true :connected true})]
    (t/is (str/includes? html "data-testid=\"design-system-start\""))
    (t/is (str/includes? html "Acme"))
    (t/is (str/includes? html "type=\"file\""))
    (t/is (str/includes? html "accept=\".fig\""))
    (t/is (not (str/includes? html "penforge.design-systems.action.publish")) "no publish before generation")))

(t/deftest start-card-after-generation-offers-publish-until-shared
  (let [generated {:name "Acme" :generated-at "2026-11-19T10:00:00Z"}
        html      (render-card {:marker generated :canEdit true :connected true})
        shared    (render-card {:marker generated :canEdit true :connected true :shared true})]
    (t/is (str/includes? html "penforge.design-systems.action.publish"))
    (t/is (not (str/includes? shared "penforge.design-systems.action.publish")))
    (t/is (str/includes? shared "penforge.design-systems.published"))))

(t/deftest start-card-disabled-while-a-run-is-going-and-shows-fig-status
  (let [html (render-card {:marker {:name "Acme"} :canEdit true :connected true
                           :running {:kind :generate :rid "r"}
                           :fig {:status :error :code "no-icons"}})]
    (t/is (str/includes? html "disabled"))
    (t/is (str/includes? html "penforge.design-systems.fig.no-icons"))))

(t/deftest fig-status-texts
  (t/is (nil? (start/fig-status-text nil)))
  (t/is (string? (start/fig-status-text {:status :sent :count 4})))
  (t/is (string? (start/fig-status-text {:status :error :code "other"}))))

(t/deftest design-systems-list-states
  (let [render (fn [props]
                 (rds/renderToStaticMarkup
                  (mf/element page/design-systems-list* (js-props (merge {:onOpen identity} props)))))]
    (t/is (str/includes? (render {:files nil}) "labels.loading"))
    (t/is (str/includes? (render {:files [] :canEdit true}) "penforge.design-systems.empty"))
    (let [html (render {:files [{:id "f1" :name "Acme"
                                 :library-summary {:colors {:sample [{:color "#2B59C3"}]}
                                                   :components {:count 7}}}]})]
      (t/is (str/includes? html "data-testid=\"design-system-card\""))
      (t/is (str/includes? html "Acme"))
      (t/is (str/includes? html "background-color:#2B59C3")))))

(def ^:private progress
  {:kind :progress :payload {:stage :import}})

(t/deftest fig-job-answers-the-imported-file-id
  (t/async
    done
    (let [values (atom [])]
      (->> (fig/job-file-id (rx/from [progress
                                      {:kind :start}
                                      {:status "completed" :result {:file-ids ["f-1" "f-2"]}}
                                      {:status "completed" :result {:file-ids ["late"]}}]))
           (rx/subs! #(swap! values conj %)
                     (fn [cause]
                       (t/is false (str "unexpected error " cause))
                       (done))
                     (fn []
                       (t/is (= ["f-1"] @values))
                       (done)))))))

(t/deftest fig-job-failure-is-an-error
  (t/async
    done
    (->> (fig/job-file-id (rx/from [progress {:status "failed" :error {:code "x"}}]))
         (rx/subs! (fn [value]
                     (t/is false (str "unexpected value " value)))
                   (fn [cause]
                     (t/is (= "the import failed" (ex-message cause)))
                     (done))
                   (fn []
                     (t/is false "completed without an error")
                     (done))))))

(t/deftest fig-job-without-a-file-is-an-error
  (t/is (thrown? js/Error (fig/completed-file-id {:status "completed" :result {:file-ids []}})))
  (t/is (nil? (fig/completed-file-id progress))))
