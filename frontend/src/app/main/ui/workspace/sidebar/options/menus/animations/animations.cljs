;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.sidebar.options.menus.animations.animations
  "Penforge (W31): the Animation section of the Prototype tab. Edits the
  spec stored in the selected layers' plugin data and previews it on the
  canvas."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.main.animations.easing :as ease]
   [app.main.animations.spec :as spec]
   [app.main.data.workspace.animations.events :as dwa]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.select :refer [select]]
   [app.main.ui.components.title-bar :refer [title-bar*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.controls.numeric-input :refer [numeric-input*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

;; --- Presets

(def motion-presets
  "Preset id → effects. The UI shows the preset whose effect types and
  directions match the stored effects, else \"custom\"."
  [["fade"            [{:type "fade"}]]
   ["slide-up"        [{:type "slide" :direction "up"}]]
   ["slide-down"      [{:type "slide" :direction "down"}]]
   ["slide-left"      [{:type "slide" :direction "left"}]]
   ["slide-right"     [{:type "slide" :direction "right"}]]
   ["fade-slide-up"   [{:type "fade"} {:type "slide" :direction "up"}]]
   ["fade-slide-down" [{:type "fade"} {:type "slide" :direction "down"}]]
   ["scale"           [{:type "scale"}]]
   ["fade-scale"      [{:type "fade"} {:type "scale" :from 0.9}]]
   ["blur"            [{:type "blur"}]]
   ["fade-blur"       [{:type "fade"} {:type "blur"}]]])

(defn- effects-key
  [effects]
  (set (map (juxt :type :direction) effects)))

(defn get-preset-id
  [motion]
  (cond
    (nil? motion) "none"
    (seq (:tracks motion)) "custom"
    :else
    (or (some (fn [[id effects]]
                (when (= (effects-key effects) (effects-key (:effects motion))) id))
              motion-presets)
        "custom")))

(defn apply-preset
  "Motion with the effects of `preset-id`, keeping its timing; nil for
  \"none\"."
  [motion preset-id]
  (when-let [effects (some (fn [[id effects]] (when (= id preset-id) effects)) motion-presets)]
    (-> (or motion {:duration 300 :easing "ease-out"})
        (dissoc :tracks)
        (assoc :effects effects))))

(defn- preset-label
  [id]
  (case id
    "none"            (tr "penforge.animations.preset.none")
    "custom"          (tr "penforge.animations.preset.custom")
    "fade"            (tr "penforge.animations.preset.fade")
    "slide-up"        (tr "penforge.animations.preset.slide-up")
    "slide-down"      (tr "penforge.animations.preset.slide-down")
    "slide-left"      (tr "penforge.animations.preset.slide-left")
    "slide-right"     (tr "penforge.animations.preset.slide-right")
    "fade-slide-up"   (tr "penforge.animations.preset.fade-slide-up")
    "fade-slide-down" (tr "penforge.animations.preset.fade-slide-down")
    "scale"           (tr "penforge.animations.preset.scale")
    "fade-scale"      (tr "penforge.animations.preset.fade-scale")
    "blur"            (tr "penforge.animations.preset.blur")
    "fade-blur"       (tr "penforge.animations.preset.fade-blur")
    id))

(defn- easing-options
  []
  [{:value "linear"      :label (tr "workspace.options.interaction-easing-linear")}
   {:value "ease"        :label (tr "workspace.options.interaction-easing-ease")}
   {:value "ease-in"     :label (tr "workspace.options.interaction-easing-ease-in")}
   {:value "ease-out"    :label (tr "workspace.options.interaction-easing-ease-out")}
   {:value "ease-in-out" :label (tr "workspace.options.interaction-easing-ease-in-out")}
   {:value "spring"      :label (tr "penforge.animations.easing.spring")}])

(defn- easing-value
  [easing]
  (if (ease/spring? easing) "spring" (or easing "ease-out")))

(defn- parse-easing
  [value previous]
  (if (= value "spring")
    (if (ease/spring? previous) previous (assoc ease/spring-defaults :type "spring"))
    value))

(defn- loop-label
  [id]
  (case id
    "none"    (tr "penforge.animations.preset.none")
    "pulse"   (tr "penforge.animations.loop.pulse")
    "spin"    (tr "penforge.animations.loop.spin")
    "bounce"  (tr "penforge.animations.loop.bounce")
    "shimmer" (tr "penforge.animations.loop.shimmer")
    id))

(defn update-section
  "Spec with `section` set to `value`, or removed when nil."
  [anim section value]
  (if (nil? value)
    (dissoc anim section)
    (assoc anim section value)))

(defn- clean-number
  [value]
  (when (and (number? value) (not (js/isNaN value))) value))

;; --- Rows

(mf/defc row*
  [{:keys [label children]}]
  [:div {:class (stl/css :row)}
   [:div {:class (stl/css :row-label)} label]
   [:div {:class (stl/css :row-control)} children]])

(mf/defc number-row*
  [{:keys [label value on-change min max step unit placeholder]}]
  [:> row* {:label label}
   [:> numeric-input* {:value value
                       :placeholder (or placeholder "")
                       :min min
                       :max max
                       :step step
                       :nillable true
                       :property unit
                       :on-change (fn [v] (on-change (clean-number v)))}]])

(mf/defc easing-rows*
  [{:keys [easing on-change]}]
  [:*
   [:> row* {:label (tr "workspace.options.interaction-easing")}
    [:& select {:key (easing-value easing)
                :default-value (easing-value easing)
                :options (easing-options)
                :on-change #(on-change (parse-easing (d/name %) easing))}]]
   (when (ease/spring? easing)
     [:*
      [:> number-row* {:label (tr "penforge.animations.spring.stiffness")
                       :value (:stiffness easing 170) :min 1 :max 2000
                       :on-change #(on-change (if % (assoc easing :stiffness %) easing))}]
      [:> number-row* {:label (tr "penforge.animations.spring.damping")
                       :value (:damping easing 26) :min 1 :max 500
                       :on-change #(on-change (if % (assoc easing :damping %) easing))}]])])

;; --- Motion (entrance / exit)

(mf/defc motion-block*
  [{:keys [kind motion has-children on-change]}]
  (let [preset-id (get-preset-id motion)
        options   (mf/with-memo [preset-id]
                    (cond-> (into [{:value "none" :label (preset-label "none")}]
                                  (map (fn [[id _]] {:value id :label (preset-label id)}))
                                  motion-presets)
                      (= preset-id "custom")
                      (conj {:value "custom" :label (preset-label "custom")})))
        set-field (fn [k v] (on-change (if (nil? v) (dissoc motion k) (assoc motion k v))))]
    [:div {:class (stl/css :block)}
     [:> row* {:label (if (= kind :entrance)
                        (tr "penforge.animations.entrance")
                        (tr "penforge.animations.exit"))}
      [:& select {:key preset-id
                  :default-value preset-id
                  :options options
                  :on-change (fn [value]
                               (let [value (d/name value)]
                                 (when (not= value "custom")
                                   (on-change (apply-preset motion value)))))}]]
     (when (some? motion)
       [:*
        [:> number-row* {:label (tr "workspace.options.interaction-duration")
                         :unit (tr "workspace.options.interaction-ms")
                         :value (:duration motion) :min 0 :max 20000 :step 50
                         :on-change #(set-field :duration (or % 0))}]
        [:> number-row* {:label (tr "workspace.options.interaction-delay")
                         :unit (tr "workspace.options.interaction-ms")
                         :value (:delay motion 0) :min 0 :max 20000 :step 50
                         :on-change #(set-field :delay (when (and % (pos? %)) %))}]
        [:> easing-rows* {:easing (:easing motion)
                          :on-change #(set-field :easing %)}]
        (when has-children
          [:> number-row* {:label (tr "penforge.animations.stagger")
                           :unit (tr "workspace.options.interaction-ms")
                           :value (get-in motion [:stagger :each] 0) :min 0 :max 5000 :step 10
                           :on-change #(set-field :stagger (when (and % (pos? %))
                                                             (assoc (:stagger motion) :each %)))}])])]))

;; --- States (hover / press)

(def default-state
  {:scale 1.04 :duration 150 :easing "ease-out"})

(def lift-shadow
  {:offsetX 0 :offsetY 8 :blur 24 :spread 0 :color "#000000" :opacity 0.2})

(mf/defc state-block*
  [{:keys [state value on-change on-preview]}]
  (let [enabled   (some? value)
        set-field (fn [k v] (on-change (if (nil? v) (dissoc value k) (assoc value k v))))
        id        (str "penforge-anim-state-" (name state))]
    [:div {:class (stl/css :block)}
     [:div {:class (stl/css :row)}
      [:div {:class (stl/css :row-check)}
       [:> checkbox* {:id id
                      :label (if (= state :hover)
                               (tr "penforge.animations.state.hover")
                               (tr "penforge.animations.state.press"))
                      :checked enabled
                      :on-change #(on-change (when-not enabled
                                               (if (= state :press)
                                                 (assoc default-state :scale 0.97)
                                                 default-state)))}]]
      (when enabled
        [:> icon-button* {:variant "ghost"
                          :icon i/play
                          :aria-label (tr "penforge.animations.preview-state")
                          :on-click on-preview}])]
     (when enabled
       [:*
        [:> number-row* {:label (tr "penforge.animations.opacity")
                         :unit "%"
                         :value (some-> (:opacity value) (* 100) (js/Math.round)) :min 0 :max 100
                         :on-change #(set-field :opacity (some-> % (/ 100)))}]
        [:> number-row* {:label (tr "penforge.animations.scale")
                         :value (:scale value) :min 0 :max 10 :step 0.01
                         :on-change #(set-field :scale %)}]
        [:> number-row* {:label (tr "penforge.animations.offset-x")
                         :unit "px"
                         :value (:offsetX value) :min -4000 :max 4000
                         :on-change #(set-field :offsetX %)}]
        [:> number-row* {:label (tr "penforge.animations.offset-y")
                         :unit "px"
                         :value (:offsetY value) :min -4000 :max 4000
                         :on-change #(set-field :offsetY %)}]
        [:> row* {:label (tr "penforge.animations.fill")}
         [:> input* {:type "text"
                     :placeholder "#RRGGBB"
                     :default-value (or (:fill value) "")
                     :key (str id "-fill-" (:fill value))
                     :on-blur (fn [event]
                                (let [v (dom/get-value (dom/get-target event))]
                                  (cond
                                    (= v "") (set-field :fill nil)
                                    (re-matches #"^#[0-9a-fA-F]{6}$" v) (set-field :fill v))))}]]
        [:div {:class (stl/css :row)}
         [:div {:class (stl/css :row-check)}
          [:> checkbox* {:id (str id "-shadow")
                         :label (tr "penforge.animations.shadow")
                         :checked (some? (:shadow value))
                         :on-change #(set-field :shadow (when-not (:shadow value) lift-shadow))}]]]
        [:> number-row* {:label (tr "workspace.options.interaction-duration")
                         :unit (tr "workspace.options.interaction-ms")
                         :value (:duration value 150) :min 0 :max 20000 :step 10
                         :on-change #(set-field :duration %)}]
        [:> easing-rows* {:easing (:easing value)
                          :on-change #(set-field :easing %)}]])]))

;; --- Loop

(mf/defc loop-block*
  [{:keys [value on-change]}]
  (let [type      (or (:type value) "none")
        set-field (fn [k v] (on-change (if (nil? v) (dissoc value k) (assoc value k v))))]
    [:div {:class (stl/css :block)}
     [:> row* {:label (tr "penforge.animations.loop")}
      [:& select {:key type
                  :default-value type
                  :options (mapv (fn [id] {:value id :label (loop-label id)})
                                 (into ["none"] spec/loop-types))
                  :on-change (fn [v]
                               (let [v (d/name v)]
                                 (on-change (when (not= v "none")
                                              (assoc (or value {}) :type v)))))}]]
     (when (some? value)
       [:*
        [:> number-row* {:label (tr "workspace.options.interaction-duration")
                         :unit (tr "workspace.options.interaction-ms")
                         :value (:duration value) :min 50 :max 20000 :step 50
                         :on-change #(set-field :duration %)}]
        [:> number-row* {:label (tr "penforge.animations.loop.count")
                         :value (when (number? (:count value)) (:count value))
                         :placeholder (tr "penforge.animations.loop.infinite")
                         :min 1 :max 1000
                         :on-change #(set-field :count (when (and % (pos? %)) (js/Math.round %)))}]
        [:> number-row* {:label (tr "workspace.options.interaction-delay")
                         :unit (tr "workspace.options.interaction-ms")
                         :value (:delay value 0) :min 0 :max 20000 :step 50
                         :on-change #(set-field :delay (when (and % (pos? %)) %))}]])]))

;; --- Smart animate

(defn- smart-interactions
  "Interactions of `shape` that change screen (navigate / overlays) with
  their index."
  [shape]
  (->> (:interactions shape)
       (map-indexed vector)
       (filter (fn [[_ {:keys [action-type destination]}]]
                 (and (some? destination)
                      (contains? #{:navigate :open-overlay :toggle-overlay} action-type))))))

(defn set-smart
  "Spec with smart animate on/off for interaction `index` → `destination`."
  [anim index destination enabled]
  (let [others (into [] (remove #(= index (:index %))) (:smart anim))]
    (update-section anim :smart
                    (not-empty
                     (cond-> others
                       enabled (conj {:index index
                                      :destination (str destination)
                                      :duration 300
                                      :easing "ease-in-out"}))))))

(mf/defc smart-block*
  [{:keys [shape anim on-change]}]
  (let [objects (mf/deref refs/workspace-page-objects)
        items   (smart-interactions shape)]
    (when (seq items)
      [:div {:class (stl/css :block)}
       (for [[index {:keys [destination]}] items]
         (let [entry (spec/get-smart shape index destination)
               dest  (get objects destination)]
           [:div {:key (str "smart-" index) :class (stl/css :row)}
            [:div {:class (stl/css :row-check)}
             [:> checkbox* {:id (str "penforge-smart-" (:id shape) "-" index)
                            :label (tr "penforge.animations.smart" (or (:name dest) "--"))
                            :checked (some? entry)
                            :on-change #(on-change (set-smart anim index destination (nil? entry)))}]]]))])))

;; --- Section

(mf/defc animations-menu*
  "Animation section for the selected layers. Values shown are those of
  the first selected layer; edits apply to all of them."
  [{:keys [shape]}]
  (let [selected   (mf/deref refs/selected-shapes)
        ids        (mf/with-memo [selected shape]
                     (if (seq selected) (into [] (map :id) selected) [(:id shape)]))
        anim       (or (spec/get-shape-animations shape) (spec/empty-spec))
        show*      (mf/use-state true)
        show?      (deref show*)
        key-prefix (str (:id shape))

        update-anim
        (mf/use-fn
         (mf/deps ids)
         (fn [section value]
           (st/emit! (dwa/update-animations ids #(update-section % section value)))))

        set-states
        (mf/use-fn
         (mf/deps ids)
         (fn [state value]
           (st/emit! (dwa/update-animations
                      ids
                      (fn [a]
                        (let [states (-> (:states a)
                                         (update-section state value)
                                         (not-empty))]
                          (update-section a :states states)))))))

        play
        (mf/use-fn
         (mf/deps ids)
         #(st/emit! (dwa/play-preview ids)))]

    [:div {:class (stl/css :section)}
     [:div {:class (stl/css :title)}
      [:> title-bar* {:collapsable true
                      :collapsed (not show?)
                      :on-collapsed #(swap! show* not)
                      :title (tr "penforge.animations.title")
                      :class (stl/css :title-bar)}
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "penforge.animations.play")
                         :on-click play
                         :icon i/play}]]]
     (when show?
       [:div {:class (stl/css :content)}
        [:> motion-block* {:key (str key-prefix "-entrance")
                           :kind :entrance
                           :motion (:entrance anim)
                           :has-children (seq (:shapes shape))
                           :on-change #(update-anim :entrance %)}]
        [:> motion-block* {:key (str key-prefix "-exit")
                           :kind :exit
                           :motion (:exit anim)
                           :has-children (seq (:shapes shape))
                           :on-change #(update-anim :exit %)}]
        [:> state-block* {:key (str key-prefix "-hover")
                          :state :hover
                          :value (get-in anim [:states :hover])
                          :on-change #(set-states :hover %)
                          :on-preview #(st/emit! (dwa/play-state-preview (:id shape) :hover))}]
        [:> state-block* {:key (str key-prefix "-press")
                          :state :press
                          :value (get-in anim [:states :press])
                          :on-change #(set-states :press %)
                          :on-preview #(st/emit! (dwa/play-state-preview (:id shape) :press))}]
        [:> loop-block* {:key (str key-prefix "-loop")
                         :value (:loop anim)
                         :on-change #(update-anim :loop %)}]
        [:> smart-block* {:shape shape
                          :anim anim
                          :on-change #(st/emit! (dwa/update-animations [(:id shape)] (constantly %)))}]])]))
