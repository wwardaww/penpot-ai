;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-preview-pane-test
  "The preview pane renders each state of the dev server."
  (:require
   ["react-dom/server" :as rds]
   [app.main.data.ai.preview :as preview]
   [app.main.ui.ds.tooltip :as tooltip]
   [app.main.ui.workspace.ai.preview.pane :as pane]
   [app.util.i18n :as i18n]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [frontend-tests.helpers.mock :as mock]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(mf/defc tooltip-stub*
  "Server rendering has no portals; the real tooltip renders into one."
  [{:keys [children]}]
  children)

(defn- render-pane
  "Markup of the preview pane for a preview state."
  ([preview-state] (render-pane preview-state {}))
  ([preview-state {:keys [connected developer] :or {connected true developer false}}]
   (let [state (l/atom {:preview (merge preview/empty-preview preview-state)
                        :connected connected
                        :developer developer})]
     (with-redefs [pane/preview-ref (l/derived :preview state)
                   pane/connected-ref (l/derived :connected state)
                   pane/developer-ref (l/derived :developer state)
                   tooltip/tooltip* tooltip-stub*
                   i18n/tr (mock/stub (fn [key] key))]
       (rds/renderToStaticMarkup (mf/element pane/preview-pane* #js {}))))))

(t/deftest a-closed-preview-renders-nothing
  (t/is (= "" (render-pane {:pane nil :status :ready :url "http://localhost:5200/"}))))

(t/deftest a-ready-preview-shows-the-app-in-a-frame
  (let [markup (render-pane {:pane :split :status :ready :url "http://localhost:5200/"
                             :width 500})]
    (t/is (str/includes? markup "<iframe"))
    (t/is (str/includes? markup "src=\"http://localhost:5200/\""))
    (t/is (str/includes? markup "sandbox=\"allow-scripts"))
    (t/is (str/includes? markup "inline-size:500px"))
    (t/is (str/includes? markup "role=\"separator\""))
    (t/is (str/includes? markup "penforge.preview.status.ready"))
    (t/is (str/includes? markup "penforge.preview.stop"))))

(t/deftest the-mobile-frame-is-390-wide
  (let [markup (render-pane {:pane :split :status :ready :url "http://localhost:5200/"
                             :device :mobile})]
    (t/is (str/includes? markup "inline-size:390px"))
    (t/is (str/includes? markup "aria-pressed=\"true\""))
    (t/testing "the desktop frame has no fixed width"
      (t/is (not (str/includes? (render-pane {:pane :split :status :ready
                                              :url "http://localhost:5200/"})
                                "390px"))))))

(t/deftest a-starting-preview-shows-progress
  (let [markup (render-pane {:pane :split :status :starting})]
    (t/is (not (str/includes? markup "<iframe")))
    (t/is (str/includes? markup "penforge.preview.status.starting")))
  (t/is (str/includes? (render-pane {:pane :split :status :starting :restarts 2})
                       "penforge.preview.status.restarting")))

(t/deftest a-project-without-an-app-offers-to-build-it
  (let [markup (render-pane {:pane :split :status :failed :code "not-configured"})]
    (t/is (str/includes? markup "penforge.preview.not-built"))
    (t/is (str/includes? markup "penforge.build"))))

(t/deftest a-failed-preview-shows-the-reason-and-a-retry
  (let [state  {:pane :split :status :failed :reason :start-timeout
                :message "The app did not answer in time"}
        markup (render-pane state)]
    (t/is (str/includes? markup "penforge.preview.reason.start-timeout"))
    (t/is (str/includes? markup "penforge.preview.retry"))
    (t/is (not (str/includes? markup "did not answer"))
          "designers never see the English daemon detail")
    (t/is (str/includes? (render-pane state {:developer true}) "did not answer")
          "developers see the technical detail")))

(t/deftest every-daemon-reason-has-its-own-text
  (with-redefs [i18n/tr (mock/stub (fn [key] key))]
    (t/is (= "penforge.preview.reason.crashed"
             (pane/problem-text {:status :failed :reason :crashed})))
    (t/is (= "penforge.preview.reason.command-failed"
             (pane/problem-text {:status :failed :reason :command-failed})))
    (t/is (= "penforge.preview.reason.project-closed"
             (pane/problem-text {:status :stopped :reason :project-closed})))
    (t/is (= "penforge.preview.reason.daemon-stopped"
             (pane/problem-text {:status :stopped :reason :daemon-stopped})))
    (t/is (= "penforge.preview.reason.invalid-setup"
             (pane/problem-text {:status :failed :code "bad-request"})))
    (t/is (= "penforge.preview.status.failed"
             (pane/problem-text {:status :failed :reason :something-new})))
    (t/is (= "penforge.preview.stopped-hint"
             (pane/problem-text {:status :stopped :reason :stopped})))))

(t/deftest without-the-daemon-the-preview-asks-to-connect
  (let [markup (render-pane {:pane :split :status :idle} {:connected false})]
    (t/is (str/includes? markup "penforge.preview.not-connected"))))

(t/deftest the-overlay-is-a-dialog
  (let [markup (render-pane {:pane :overlay :status :ready :url "http://localhost:5200/"})]
    (t/is (str/includes? markup "role=\"dialog\""))
    (t/is (str/includes? markup "<iframe"))
    (t/is (not (str/includes? markup "role=\"separator\"")))))

(t/deftest only-developers-see-the-server-output
  (let [state {:pane :split :status :ready :url "http://localhost:5200/"
               :logs [{:stream :stdout :text "VITE ready"}
                      {:stream :stderr :text "warning: x"}]}]
    (t/is (not (str/includes? (render-pane state) "VITE ready")))
    (let [markup (render-pane state {:developer true})]
      (t/is (str/includes? markup "penforge.preview.logs"))
      (t/is (str/includes? markup "VITE ready"))
      (t/is (str/includes? markup "warning: x")))))
