;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.conformance
  "Conformance report of a finished build (W35) for the build dialog:
  whether the app follows the prototype flows, the design system and
  the animations, what was fixed and what is left."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn get-finding-text
  "Text of a finding: outcome words for designers, the daemon's technical
  English `text` for developers and unknown codes."
  [{:keys [code params text]} persona]
  (let [{:keys [screen route source target url value token component layer]} params]
    (if (= persona :developer)
      text
      (case code
        "route-missing" (tr "penforge.build.conformance.route-missing" screen)
        "route-extra" (tr "penforge.build.conformance.route-extra" route)
        "start-screen" (tr "penforge.build.conformance.start-screen" screen)
        "link-missing" (tr "penforge.build.conformance.link-missing" source screen target)
        "back-missing" (tr "penforge.build.conformance.back-missing" source screen)
        "overlay-missing" (tr "penforge.build.conformance.overlay-missing" source screen target)
        "url-missing" (tr "penforge.build.conformance.url-missing" source screen url)
        "hardcoded-color" (tr "penforge.build.conformance.hardcoded" value token)
        "hardcoded-size" (tr "penforge.build.conformance.hardcoded" value token)
        "hardcoded-font" (tr "penforge.build.conformance.hardcoded" value token)
        "off-system-color" (tr "penforge.build.conformance.off-system-color" value)
        "component-missing" (tr "penforge.build.conformance.component-missing" component)
        "component-unused" (tr "penforge.build.conformance.component-unused" screen component)
        "animation-missing" (tr "penforge.build.conformance.animation-missing" layer screen)
        "motion-not-loaded" (tr "penforge.build.conformance.motion-not-loaded")
        "motion-library-missing" (tr "penforge.build.conformance.motion-not-loaded")
        text))))

(defn- get-check-name
  [check]
  (case check
    "flows" (tr "penforge.build.conformance.check.flows")
    "values" (tr "penforge.build.conformance.check.values")
    "components" (tr "penforge.build.conformance.check.components")
    "animations" (tr "penforge.build.conformance.check.animations")
    check))

(mf/defc conformance-report*
  "Props: `conformance` of a `build-run` result (nil: no report) and the
  `persona`."
  [{:keys [conformance persona]}]
  (let [{:keys [status fixed left elsewhere items skipped]} conformance
        fixed     (or fixed 0)
        left      (or left 0)
        elsewhere (or elsewhere 0)
        more      (- left (count items))]
    (when (some? status)
      [:section {:class (stl/css :report)
                 :data-testid "penforge-build-conformance"}
       [:> text* {:as "p"
                  :typography t/body-medium
                  :class (stl/css-case :line true
                                       :line-clean (= status "clean"))}
        (cond
          (= status "unchecked") (tr "penforge.build.conformance.unchecked")
          (pos? left) (tr "penforge.build.conformance.left" left)
          :else (tr "penforge.build.conformance.clean"))]
       (when (pos? fixed)
         [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
          (tr "penforge.build.conformance.fixed" fixed)])
       (when (seq items)
         [:details {:class (stl/css :details)}
          [:summary (tr "penforge.build.conformance.details")]
          [:ul {:class (stl/css :items)}
           (for [[index item] (map-indexed vector items)]
             [:li {:key index} (get-finding-text item persona)])
           (when (pos? more)
             [:li (tr "penforge.build.conformance.more" more)])]])
       (when (pos? elsewhere)
         [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
          (tr "penforge.build.conformance.elsewhere" elsewhere)])
       (when (and (seq skipped) (not= status "unchecked"))
         [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
          (tr "penforge.build.conformance.skipped"
              (str/join ", " (map #(get-check-name (:check %)) skipped)))])])))
