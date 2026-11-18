;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.binfile.fig.map
  "Mapping of a Figma document tree to a penpot file.

  The walk goes page by page and node by node over the views of
  `app.binfile.fig.tree` and feeds `app.common.files.builder`, so the
  result is file data built with the same changes the rest of penpot
  uses. Geometry is absolute in penpot: every node composes the
  transform of its parents, rect-like shapes keep their rotation as a
  penpot transform and paths are flattened to page coordinates.

  Anything that has no penpot counterpart degrades instead of failing:
  an unknown node becomes a placeholder rect named `[unsupported]
  <TYPE>`, an unknown paint or effect is dropped, and every loss goes to
  the compatibility report the import returns.

  The mapping is pure: images are resolved before it runs (`:media`, by
  the hex of their SHA-1) and the caller persists the result."
  (:require
   [app.binfile.fig.geom :as geom]
   [app.binfile.fig.tree :as tree]
   [app.common.data :as d]
   [app.common.files.builder :as fb]
   [app.common.files.changes :as ch]
   [app.common.geom.matrix :as gmt]
   [app.common.math :as mth]
   [app.common.path-names :as cpn]
   [app.common.schema :as sm]
   [app.common.types.variant :as ctv]
   [app.common.uuid :as uuid]
   [cuerdas.core :as str]))

(def ^:const max-report-entries
  "How many unsupported nodes the report lists one by one; the summary
  still counts all of them."
  200)

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; CONTEXT, IDS AND REPORT
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- id-of
  "The penpot id of a view path: the same path always gets the same id,
  which is what lets a copy point at its main before the main is built."
  [{:keys [ids]} path]
  (or (get @ids path)
      (let [id (uuid/next)]
        (vswap! ids assoc path id)
        id)))

(defn- component-id-of
  [ctx symbol-key]
  (id-of ctx (str "component:" symbol-key)))

(defn- type-name
  [view]
  (let [t (:type view)]
    (if (keyword? t) (name t) (str t))))

(defn- report!
  "Record something the import could not keep as it was."
  [{:keys [report]} view reason]
  (vswap! report
          (fn [report]
            (let [entry {:node     (str (or (:name view) "") " (" (::tree/path view) ")")
                         :fig-type (type-name view)
                         :reason   reason}]
              (-> report
                  (update :total inc)
                  (update-in [:summary [(type-name view) reason]] (fnil inc 0))
                  (cond-> (< (count (:unsupported report)) max-report-entries)
                    (update :unsupported conj entry)))))))

(defn- count!
  [{:keys [report]} counter]
  (vswap! report update-in [:counts counter] (fnil inc 0)))

(defn- build!
  "Apply a builder function to the builder state."
  [{:keys [state]} f & args]
  (vreset! state (apply f @state args)))

(defn- add-library-color!
  "Add a library color to the file being built. `fb/add-library-color`
  passes the color twice to its schema check and cannot be used, so the
  change goes in directly."
  [{:keys [state file-id]} color]
  (vswap! state update-in [::fb/files file-id :data]
          ch/process-changes [{:type :add-color :color (update color :opacity d/nilv 1)}] false))

(defn- keep-name!
  "Remember the name the shape has in Figma: the builder makes names
  unique per page, and the import puts the original ones back."
  [{:keys [names]} id name]
  (when (some? name)
    (vswap! names assoc id name)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; COLORS AND PAINTS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn hex
  "The lowercase hex of a byte array: how a `.fig` names an image after
  its SHA-1."
  [^bytes data]
  (let [sb (StringBuilder.)]
    (doseq [b data]
      (.append sb (format "%02x" (bit-and (long b) 0xff))))
    (str sb)))

(defn- clamp01
  [v]
  (-> (geom/finite v 0.0) (max 0.0) (min 1.0)))

(defn color->hex
  "The penpot hex of a Figma `{r g b}` color with components in [0, 1]."
  [{:keys [r g b]}]
  (let [c (fn [v] (Math/round (* 255.0 (clamp01 v))))]
    (format "#%02x%02x%02x" (c r) (c g) (c b))))

(defn- paint-opacity
  [paint]
  (clamp01 (if (contains? paint :opacity) (:opacity paint) 1.0)))

(defn- gradient
  "A penpot gradient from a Figma gradient paint. The paint transform
  maps the box of the node, normalized to [0, 1], to the gradient space,
  where a linear gradient runs from (0, 0.5) to (1, 0.5) and a radial
  one is the unit circle centered at (0.5, 0.5); its inverse gives the
  handles back in the box of the node."
  [paint type width height]
  (let [m    (geom/from-fig (:transform paint))
        inv  (or (geom/invert m) geom/identity-matrix)
        [sx sy] (geom/apply-point inv (if (= type :radial) [0.5 0.5] [0.0 0.5]))
        [ex ey] (geom/apply-point inv [1.0 0.5])
        [wx wy] (geom/apply-point inv [0.5 1.0])
        w    (max (geom/finite width 1.0) 1.0)
        h    (max (geom/finite height 1.0) 1.0)
        len  (fn [ax ay bx by] (Math/hypot (* (- bx ax) w) (* (- by ay) h)))
        main (len sx sy ex ey)
        side (len sx sy wx wy)]
    {:type    type
     :start-x sx :start-y sy
     :end-x   ex :end-y   ey
     :width   (if (pos? main) (/ side main) 1.0)
     :stops   (->> (:stops paint)
                   (mapv (fn [{:keys [color position]}]
                           {:color   (color->hex color)
                            :opacity (clamp01 (:a color 1))
                            :offset  (clamp01 position)})))}))

(defn- paint->fill
  "A penpot fill from a Figma paint, or nil when the paint has no
  penpot counterpart (it is then reported). `:fill`, `:stroke`: what the
  paint is for, which names the keys."
  [ctx view paint purpose]
  (let [prefix  (if (= purpose :stroke) "stroke" "fill")
        k       (fn [suffix] (keyword (str prefix "-" suffix)))
        opacity (paint-opacity paint)
        w       (get-in view [:size :x] 0)
        h       (get-in view [:size :y] 0)]
    (case (:type paint)
      :SOLID
      {(k "color")   (color->hex (:color paint))
       (k "opacity") (clamp01 (* opacity (get-in paint [:color :a] 1)))}

      :GRADIENT_LINEAR
      {(k "color-gradient") (gradient paint :linear w h)
       (k "opacity") opacity}

      :GRADIENT_RADIAL
      {(k "color-gradient") (gradient paint :radial w h)
       (k "opacity") opacity}

      (:GRADIENT_ANGULAR :GRADIENT_DIAMOND)
      (do
        (report! ctx view (str "gradient " (name (:type paint)) " imported as linear"))
        {(k "color-gradient") (gradient paint :linear w h)
         (k "opacity") opacity})

      :IMAGE
      (let [hash  (some-> (get-in paint [:image :hash]) (hex))
            media (get (:media ctx) hash)
            mode  (:imageScaleMode paint)]
        (cond
          (nil? media)
          (do (report! ctx view "image not found in the file") nil)

          :else
          (do
            (when (contains? #{:TILE :STRETCH} mode)
              (report! ctx view (str "image scale mode " (name mode) " imported as fill")))
            {(if (= purpose :stroke) :stroke-image :fill-image)
             (cond-> (select-keys media [:id :width :height :mtype :name])
               (not= mode :STRETCH) (assoc :keep-aspect-ratio true))
             (k "opacity") opacity})))

      (do
        (report! ctx view (str "paint " (some-> (:type paint) name) " not supported"))
        nil))))

(defn- visible-paints
  [paints]
  (filter #(not (false? (:visible %))) paints))

(defn- style-key
  "The key of the style node a style reference points at."
  [ctx ref]
  (or (some-> (tree/guid-key (:guid ref)) (as-> k (when (get-in ctx [:styles k]) k)))
      (get (:style-by-asset ctx) (get-in ref [:assetRef :key]))))

(defn- with-color-ref
  "Link a single fill to the library color of the style the node uses."
  [ctx fills ref purpose]
  (let [color-id (some->> (style-key ctx ref) (get (:colors ctx)))
        prefix   (if (= purpose :stroke) "stroke" "fill")]
    (if (and color-id (= 1 (count fills)))
      [(assoc (first fills)
              (keyword (str prefix "-color-ref-id")) color-id
              (keyword (str prefix "-color-ref-file")) (:file-id ctx))]
      fills)))

(defn- fills
  [ctx view]
  (-> (into [] (keep #(paint->fill ctx view % :fill))
            (visible-paints (if (contains? view :fillPaints)
                              (:fillPaints view)
                              (:backgroundPaints view))))
      ;; penpot paints the first fill on top, Figma the last one
      (rseq)
      (vec)
      (as-> fills (with-color-ref ctx fills (:styleIdForFill view) :fill))))

(def ^:private stroke-alignments
  {:CENTER :center :INSIDE :inner :OUTSIDE :outer})

(defn- strokes
  [ctx view]
  (let [weight (max 0.0 (geom/finite (:strokeWeight view) 1.0))
        align  (get stroke-alignments (:strokeAlign view) :center)
        dashed (seq (:dashPattern view))]
    (when (:borderStrokeWeightsIndependent view)
      (report! ctx view "per side stroke weights imported as one weight"))
    (-> (into []
              (keep (fn [paint]
                      (when-let [stroke (paint->fill ctx view paint :stroke)]
                        (cond-> (assoc stroke
                                       :stroke-style (if dashed :dashed :solid)
                                       :stroke-alignment align
                                       :stroke-width weight)
                          dashed (assoc :stroke-dash (geom/finite (first dashed))
                                        :stroke-gap (geom/finite (or (second dashed) (first dashed))))))))
              (visible-paints (:strokePaints view)))
        (rseq)
        (vec)
        (as-> strokes (with-color-ref ctx strokes (:styleIdForStrokeFill view) :stroke)))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; EFFECTS, BLEND, CONSTRAINTS, RADIUS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def ^:private blend-modes
  {:NORMAL :normal :PASS_THROUGH :normal :DARKEN :darken :MULTIPLY :multiply
   :COLOR_BURN :color-burn :LINEAR_BURN :color-burn :LIGHTEN :lighten
   :SCREEN :screen :COLOR_DODGE :color-dodge :LINEAR_DODGE :color-dodge
   :OVERLAY :overlay :SOFT_LIGHT :soft-light :HARD_LIGHT :hard-light
   :DIFFERENCE :difference :EXCLUSION :exclusion :HUE :hue
   :SATURATION :saturation :COLOR :color :LUMINOSITY :luminosity})

(defn- effects
  "The penpot shadows and blurs of a node."
  [ctx view]
  (reduce (fn [out {:keys [type color offset radius spread visible]}]
            (case type
              (:DROP_SHADOW :INNER_SHADOW)
              (update out :shadow (fnil conj [])
                      {:id       (uuid/next)
                       :style    (if (= type :DROP_SHADOW) :drop-shadow :inner-shadow)
                       :offset-x (geom/finite (:x offset))
                       :offset-y (geom/finite (:y offset))
                       :blur     (max 0.0 (geom/finite radius))
                       :spread   (geom/finite spread)
                       :hidden   (false? visible)
                       :color    {:color   (color->hex color)
                                  :opacity (clamp01 (:a color 1))}})

              :FOREGROUND_BLUR
              (assoc out :blur {:id     (uuid/next)
                                :type   :layer-blur
                                :value  (max 0.0 (geom/finite radius))
                                :hidden (false? visible)})

              :BACKGROUND_BLUR
              (assoc out :background-blur {:id     (uuid/next)
                                           :type   :background-blur
                                           :value  (max 0.0 (geom/finite radius))
                                           :hidden (false? visible)})

              (do
                (report! ctx view (str "effect " (some-> type name) " not supported"))
                out)))
          {}
          (:effects view)))

(def ^:private h-constraints
  {:MIN :left :MAX :right :STRETCH :leftright :CENTER :center :SCALE :scale})

(def ^:private v-constraints
  {:MIN :top :MAX :bottom :STRETCH :topbottom :CENTER :center :SCALE :scale})

(defn- radius
  [view]
  (let [r      (fn [v] (max 0.0 (geom/finite v)))
        all    (r (:cornerRadius view))]
    (if (:rectangleCornerRadiiIndependent view)
      {:r1 (r (:rectangleTopLeftCornerRadius view all))
       :r2 (r (:rectangleTopRightCornerRadius view all))
       :r3 (r (:rectangleBottomRightCornerRadius view all))
       :r4 (r (:rectangleBottomLeftCornerRadius view all))}
      {:r1 all :r2 all :r3 all :r4 all})))

(defn- common-attrs
  "Attributes every penpot shape takes from its node."
  [ctx view]
  (merge
   (d/without-nils
    {:name          (or (:name view) (type-name view))
     :hidden        (when (false? (:visible view)) true)
     :blocked       (when (:locked view) true)
     :opacity       (when (contains? view :opacity) (clamp01 (:opacity view)))
     :blend-mode    (some-> (:blendMode view) blend-modes)
     :constraints-h (some-> (:horizontalConstraint view) h-constraints)
     :constraints-v (some-> (:verticalConstraint view) v-constraints)})
   (effects ctx view)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; GEOMETRY
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- size-of
  [view]
  [(max 0.01 (geom/finite (get-in view [:size :x])))
   (max 0.01 (geom/finite (get-in view [:size :y])))])

(defn- rect-geometry
  "The penpot geometry of a rect-like node: a box of the size of the
  node centered where the node is, rotated or flipped by the linear part
  of its absolute transform."
  [abs view]
  (let [[w h]   (size-of view)
        [cx cy] (geom/apply-point abs [(/ w 2) (/ h 2)])
        [a b c d] abs
        base    {:x (- cx (/ w 2)) :y (- cy (/ h 2)) :width w :height h}]
    (if (geom/linear-identity? abs)
      base
      (let [;; a scale in the transform would also scale the box; the
            ;; size already is the real one, so only the direction counts
            sx  (Math/hypot a b)
            sy  (Math/hypot c d)
            lin [(/ a sx) (/ b sx) (/ c sy) (/ d sy) 0 0]
            flip? (neg? (geom/determinant lin))
            [a b c d] lin]
        (assoc base
               :transform (gmt/matrix a b c d 0 0)
               :transform-inverse (let [[ia ib ic id] (geom/invert lin)]
                                    (gmt/matrix ia ib ic id 0 0))
               :rotation (geom/rotation lin)
               :flip-x (when flip? true))))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; LAYOUT
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def ^:private justify
  {:MIN :start :CENTER :center :MAX :end
   :SPACE_BETWEEN :space-between :SPACE_EVENLY :space-evenly})

(def ^:private align
  {:MIN :start :CENTER :center :MAX :end :BASELINE :start :STRETCH :stretch})

(defn- flex?
  [view]
  (contains? #{:HORIZONTAL :VERTICAL} (:stackMode view)))

(defn- hug?
  [sizing]
  (contains? #{:RESIZE_TO_FIT :RESIZE_TO_FIT_WITH_IMPLICIT_SIZE} sizing))

(defn- own-sizing
  "The axes an auto layout frame hugs, as penpot sizing of the frame."
  [view]
  (when (flex? view)
    (let [row?    (= :HORIZONTAL (:stackMode view))
          primary (hug? (:stackPrimarySizing view))
          cross   (hug? (:stackCounterSizing view))]
      {:h (when (if row? primary cross) :auto)
       :v (when (if row? cross primary) :auto)})))

(defn- layout-container
  "The flex layout of an auto layout frame, and the hug sizing of the
  frame itself."
  [ctx view]
  (when (= :GRID (:stackMode view))
    (report! ctx view "grid auto layout imported as fixed positions"))
  (when (flex? view)
    (let [row?     (= :HORIZONTAL (:stackMode view))
          spacing  (max 0.0 (geom/finite (:stackSpacing view)))
          ;; a counter gap that is not set (NaN in the file) follows the
          ;; main gap, as it does in Figma
          counter  (max 0.0 (geom/finite (:stackCounterSpacing view) spacing))
          left     (geom/finite (:stackHorizontalPadding view))
          top      (geom/finite (:stackVerticalPadding view))
          right    (geom/finite (:stackPaddingRight view) left)
          bottom   (geom/finite (:stackPaddingBottom view) top)
          own      (own-sizing view)]
      (when (= :BASELINE (:stackCounterAlignItems view))
        (report! ctx view "baseline alignment imported as start"))
      (d/without-nils
       {:layout                 :flex
        :layout-flex-dir        (if row? :row :column)
        :layout-gap-type        :multiple
        :layout-gap             (if row?
                                  {:column-gap spacing :row-gap counter}
                                  {:row-gap spacing :column-gap counter})
        :layout-padding-type    :multiple
        :layout-padding         {:p1 (max 0.0 top) :p2 (max 0.0 right)
                                 :p3 (max 0.0 bottom) :p4 (max 0.0 left)}
        :layout-justify-content (get justify (:stackPrimaryAlignItems view) :start)
        :layout-align-items     (get align (:stackCounterAlignItems view) :start)
        ;; "auto" counter spacing of a wrapping layout spreads the lines
        :layout-align-content   (if (= :SPACE_BETWEEN (:stackCounterAlignContent view))
                                  :space-between
                                  :start)
        :layout-wrap-type       (if (= :WRAP (:stackWrap view)) :wrap :nowrap)
        :layout-item-h-sizing   (:h own)
        :layout-item-v-sizing   (:v own)}))))

(defn- layout-child
  "The sizing of a child of an auto layout frame."
  [parent view]
  (when (flex? parent)
    (let [row?    (= :HORIZONTAL (:stackMode parent))
          grow    (pos? (geom/finite (:stackChildPrimaryGrow view)))
          stretch (= :STRETCH (:stackChildAlignSelf view))
          main    (if grow :fill :fix)
          cross   (if stretch :fill :fix)
          own     (own-sizing view)
          text    (when (= :TEXT (:type view)) (:textAutoResize view))]
      (d/without-nils
       {:layout-item-absolute (when (= :ABSOLUTE (:stackPositioning view)) true)
        :layout-item-h-sizing (cond
                                (if row? grow stretch) :fill
                                (some? (:h own)) (:h own)
                                (= :WIDTH_AND_HEIGHT text) :auto
                                :else (if row? main cross))
        :layout-item-v-sizing (cond
                                (if row? stretch grow) :fill
                                (some? (:v own)) (:v own)
                                (contains? #{:WIDTH_AND_HEIGHT :HEIGHT} text) :auto
                                :else (if row? cross main))}))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; TEXT
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def ^:private font-weights
  [["thin" 100] ["hairline" 100] ["extralight" 200] ["ultralight" 200]
   ["semibold" 600] ["demibold" 600] ["extrabold" 800] ["ultrabold" 800]
   ["light" 300] ["medium" 500] ["bold" 700] ["black" 900] ["heavy" 900]])

(defn font-variant
  "Weight, style and penpot variant id of a Figma font style name such as
  `Semi Bold Italic`."
  [style]
  (let [s       (-> (or style "") str/lower (str/replace #"[\s_-]+" ""))
        italic? (or (str/includes? s "italic") (str/includes? s "oblique"))
        weight  (or (some (fn [[k w]] (when (str/includes? s k) w)) font-weights) 400)]
    {:font-weight     (str weight)
     :font-style      (if italic? "italic" "normal")
     :font-variant-id (cond
                        (and (= 400 weight) italic?) "italic"
                        (= 400 weight) "regular"
                        italic? (str weight "italic")
                        :else (str weight))}))

(defn font-id
  "The penpot id of a font family: penpot serves Google fonts as
  `gfont-<slug>`, the family most Figma files use."
  [family]
  (str "gfont-" (-> (or family "") str/trim str/lower (str/replace #"\s+" "-"))))

(defn- number-units
  [{:keys [value units]}]
  [(geom/finite value) units])

(defn- format-number
  [v]
  (let [v (mth/precision (double v) 4)]
    (if (== v (Math/rint v)) (str (long v)) (str v))))

(defn- text-style
  "The penpot text attributes of a Figma text style (the node itself or
  an entry of its style override table)."
  [ctx view style]
  (let [style     (merge view style)
        family    (get-in style [:fontName :family] "Inter")
        font-size (max 1.0 (geom/finite (:fontSize style) 12.0))
        [lh lhu]  (number-units (:lineHeight style))
        [ls lsu]  (number-units (:letterSpacing style))
        fills     (let [paints (visible-paints (:fillPaints style))]
                    (into [] (keep #(paint->fill ctx view % :fill)) paints))]
    (vswap! (:fonts ctx) conj family)
    (merge
     {:font-id        (font-id family)
      :font-family    family
      :font-size      (format-number font-size)
      :line-height    (format-number
                       (case lhu
                         :PIXELS  (if (pos? lh) (/ lh font-size) 1.2)
                         :PERCENT (if (pos? lh) (/ lh 100.0) 1.2)
                         :RAW     (if (pos? lh) lh 1.2)
                         1.2))
      :letter-spacing (format-number
                       (case lsu
                         :PERCENT (* font-size (/ ls 100.0))
                         ls))
      :text-decoration (case (:textDecoration style)
                         :UNDERLINE "underline"
                         :STRIKETHROUGH "line-through"
                         "none")
      :text-transform (case (:textCase style)
                        :UPPER "uppercase"
                        :LOWER "lowercase"
                        :TITLE "capitalize"
                        "none")
      :fills          (if (seq fills) fills [{:fill-color "#000000" :fill-opacity 1}])}
     (font-variant (get-in style [:fontName :style])))))

(defn- text-runs
  "The characters of a text split in paragraphs, each one a list of runs
  of characters that share a style id."
  [characters style-ids]
  (let [n (count characters)]
    (loop [i 0 paragraphs [] runs [] run-start 0 run-style nil]
      (if (>= i n)
        (let [runs (cond-> runs
                     (or (< run-start n) (empty? runs))
                     (conj [(subs characters run-start n) (or run-style 0)]))]
          (conj paragraphs runs))
        (let [ch    (.charAt ^String characters i)
              style (long (nth style-ids i 0))]
          (cond
            (= \newline ch)
            (let [runs (cond-> runs
                         (or (< run-start i) (empty? runs))
                         (conj [(subs characters run-start i) (or run-style style)]))]
              (recur (inc i) (conj paragraphs runs) [] (inc i) nil))

            (and (some? run-style) (not= run-style style))
            (recur (inc i) paragraphs (conj runs [(subs characters run-start i) run-style]) i style)

            :else
            (recur (inc i) paragraphs runs run-start (if (some? run-style) run-style style))))))))

(defn- text-content
  [ctx view]
  (let [{:keys [characters characterStyleIDs styleOverrideTable]} (:textData view)
        characters (or characters "")
        overrides  (into {} (map (fn [o] [(long (or (:styleID o) 0)) (dissoc o :styleID)]))
                         styleOverrideTable)
        typo-id    (some->> (style-key ctx (:styleIdForText view)) (get (:typographies ctx)))
        style-of   (memoize
                    (fn [style-id]
                      (cond-> (text-style ctx view (get overrides style-id))
                        (and typo-id (not (contains? (get overrides style-id) :fontSize)))
                        (assoc :typography-ref-id typo-id
                               :typography-ref-file (:file-id ctx)))))
        align      (case (:textAlignHorizontal view)
                     :CENTER "center" :RIGHT "right" :JUSTIFIED "justify" "left")]
    {:type "root"
     :vertical-align (case (:textAlignVertical view)
                       :CENTER "center" :BOTTOM "bottom" "top")
     :children
     [{:type "paragraph-set"
       :children
       (mapv (fn [runs]
               (let [leaves (mapv (fn [[text style-id]]
                                    (assoc (style-of style-id) :text text))
                                  runs)]
                 (merge (dissoc (first leaves) :text)
                        {:type "paragraph"
                         :text-align align
                         :text-direction "ltr"
                         :children leaves})))
             (text-runs characters (or characterStyleIDs [])))}]}))

(def ^:private grow-types
  {:WIDTH_AND_HEIGHT :auto-width :HEIGHT :auto-height})

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; PATHS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- blob
  [ctx index]
  (when (some? index)
    (get-in ctx [:tree :blobs (int index)])))

(defn- geometry-segments
  "Path segments of a list of Figma paths (`fillGeometry` or
  `strokeGeometry`), in page coordinates."
  [ctx paths abs]
  (into [] (mapcat (fn [{:keys [commandsBlob]}]
                     (when-let [data (blob ctx commandsBlob)]
                       (geom/decode-commands data abs))))
        paths))

(defn- network-segments
  [ctx view abs]
  (when-let [data (blob ctx (get-in view [:vectorData :vectorNetworkBlob]))]
    (let [network   (geom/decode-vector-network data)
          [w h]     (size-of view)
          nw        (get-in view [:vectorData :normalizedSize :x] w)
          nh        (get-in view [:vectorData :normalizedSize :y] h)
          scale     [(if (pos? nw) (/ w nw) 1.0) 0.0 0.0 (if (pos? nh) (/ h nh) 1.0) 0.0 0.0]]
      (geom/network->segments network (geom/multiply abs scale)))))

(defn- path-segments
  "The outline of a vector-like node: the filled geometry Figma stores
  when the node has fills, the vector network otherwise (it keeps open
  paths open), and a plain line for a line node without data."
  [ctx view abs]
  (let [fills? (seq (visible-paints (:fillPaints view)))
        filled (when fills? (not-empty (geometry-segments ctx (:fillGeometry view) abs)))]
    (or filled
        (not-empty (network-segments ctx view abs))
        (not-empty (geometry-segments ctx (:fillGeometry view) abs))
        (when (= :LINE (:type view))
          (let [[w] (size-of view)
                [x1 y1] (geom/apply-point abs [0 0])
                [x2 y2] (geom/apply-point abs [w 0])]
            [{:command :move-to :params {:x x1 :y y1}}
             {:command :line-to :params {:x x2 :y y2}}])))))

(defn- winding
  [view]
  (when (some #(= :ODD (:windingRule %)) (:fillGeometry view))
    {:svg-attrs {:fill-rule "evenodd"}}))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; COMPONENTS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def ^:private touched-groups
  "The penpot sync groups an override of a Figma field touches."
  {:name :name-group
   :visible :visibility-group
   :fillPaints :fill-group
   :styleIdForFill :fill-group
   :strokePaints :stroke-group
   :strokeWeight :stroke-group
   :strokeAlign :stroke-group
   :styleIdForStrokeFill :stroke-group
   :textData :content-group
   :fontSize :content-group
   :fontName :content-group
   :lineHeight :content-group
   :letterSpacing :content-group
   :styleIdForText :content-group
   :opacity :layer-effects-group
   :blendMode :layer-effects-group
   :effects :shadow-group
   :cornerRadius :radius-group
   :rectangleTopLeftCornerRadius :radius-group
   :rectangleTopRightCornerRadius :radius-group
   :rectangleBottomLeftCornerRadius :radius-group
   :rectangleBottomRightCornerRadius :radius-group
   :size :geometry-group
   :transform :geometry-group})

(defn- componentizable?
  [ctx symbol-key]
  (contains? (:mains ctx) symbol-key))

(defn- component-attrs
  "The component attributes of the shape of a view: the copy root of an
  instance, the head of a nested instance or a plain shape of a copy."
  [ctx view]
  (let [instance? (= :INSTANCE (:type view))
        skey      (when instance? (tree/symbol-key view))
        head?     (and instance? (componentizable? ctx skey))
        in-copy?  (some? (::tree/copy-root view))
        touched   (into #{} (keep touched-groups) (::tree/overridden view))]
    (if (::tree/detached view)
      {}
      (cond-> {}
        head?
        (assoc :component-id (component-id-of ctx skey)
               :component-file (:file-id ctx))

        (and head? (not in-copy?) (not (::tree/in-main view)))
        (assoc :component-root true)

        (and head? (not in-copy?))
        (assoc :shape-ref (id-of ctx skey))

        in-copy?
        (assoc :shape-ref (id-of ctx (::tree/ref view)))

        (and in-copy? (seq touched))
        (assoc :touched touched)))))

(defn- variant-properties
  "The variant properties a Figma variant name such as `Size=L, State=Hover`
  describes."
  [name]
  (->> (str/split (or name "") #",")
       (keep (fn [part]
               (let [[k v] (map str/trim (str/split part #"=" 2))]
                 (when-not (str/blank? k)
                   (if (some? v)
                     {:name (subs k 0 (min (count k) 60)) :value (subs v 0 (min (count v) 60))}
                     {:name "Property 1" :value (subs k 0 (min (count k) 60))})))))
       (vec)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; WALK
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- group-like?
  "Figma stores groups as frames that resize to their content."
  [view]
  (or (= :GROUP (:type view))
      (and (= :FRAME (:type view))
           (:resizeToFit view)
           (not (flex? view))
           (not (:isStateGroup view))
           (empty? (visible-paints (:fillPaints view)))
           (empty? (visible-paints (:strokePaints view))))))

(defn- kind
  [view]
  (let [type (:type view)]
    (cond
      (group-like? view)                               :group
      (contains? #{:FRAME :SECTION :SYMBOL :INSTANCE} type) :frame
      (contains? #{:RECTANGLE :ROUNDED_RECTANGLE} type) :rect
      (and (= :ELLIPSE type)
           (let [{:keys [startingAngle endingAngle innerRadius]} (:arcData view)]
             (and (zero? (double (or innerRadius 0)))
                  (or (nil? startingAngle)
                      (>= (Math/abs (- (double (or endingAngle 0)) (double startingAngle)))
                          (- (* 2 Math/PI) 1e-3))))))
      :circle
      (contains? #{:ELLIPSE :VECTOR :STAR :REGULAR_POLYGON :LINE} type) :path
      (= :BOOLEAN_OPERATION type)                      :bool
      (= :TEXT type)                                   :text
      (contains? #{:SLICE} type)                       :skip
      :else                                            :unsupported)))

(declare ^:private map-view!)

(defn- base-attrs
  [ctx parent view]
  (merge (common-attrs ctx view)
         (layout-child parent view)
         (component-attrs ctx view)))

(defn- map-children!
  "Map the children of a container, wrapping a Figma mask and the
  siblings above it in a masked group. Penpot lays out flex children in
  the reverse order of its layers, so they go in reversed."
  [ctx abs view children]
  (let [children (vec children)
        children (if (flex? view) (vec (rseq children)) children)]
    (loop [children children]
      (when-let [child (first children)]
        (if (and (:mask child) (not (flex? view)) (seq (rest children)))
          (let [group-id (id-of ctx (str (::tree/path child) "#mask"))]
            (build! ctx fb/add-group (cond-> {:id group-id
                                              :name (or (:name child) "Mask")
                                              :masked-group true}
                                       ;; inside a copy the wrapper copies
                                       ;; the wrapper of the main
                                       (and (::tree/copy-root child)
                                            (not (::tree/detached child)))
                                       (assoc :shape-ref
                                              (id-of ctx (str (::tree/ref child) "#mask")))))
            (doseq [c children]
              (map-view! ctx abs view c))
            (build! ctx fb/close-group))
          (do
            (map-view! ctx abs view child)
            (recur (rest children))))))))

(defn- add-main-component!
  "Register a mapped symbol as a main component, as a variant when its
  parent is a component set."
  [ctx view id parent]
  (let [skey (tree/symbol-key view)
        skey (or skey (::tree/path view))
        variant-container (when (:isStateGroup parent)
                            (id-of ctx (::tree/path parent)))]
    (if variant-container
      (let [cname (cpn/clean-path (or (:name parent) "Component"))
            props (get-in ctx [:variant-props (::tree/path parent) (::tree/path view)])]
        (build! ctx fb/add-component {:component-id (component-id-of ctx (::tree/path view))
                                      :frame-id id
                                      :name cname
                                      :path ""
                                      :variant-id variant-container
                                      :variant-properties props})
        (build! ctx fb/update-shape id #(assoc % :variant-id variant-container
                                               :variant-name (ctv/properties-to-name props))))
      (let [[path name] (cpn/split-group-name (or (:name view) "Component"))]
        (build! ctx fb/add-component {:component-id (component-id-of ctx skey)
                                      :frame-id id
                                      :name (if (str/blank? name) "Component" name)
                                      :path path})))
    (count! ctx :components)))

(defn- map-frame!
  [ctx abs parent view]
  (let [instance? (= :INSTANCE (:type view))
        ;; an instance of a symbol penpot cannot hold as a component is
        ;; imported as plain shapes, and so is everything it brings
        view      (cond-> view
                    (and instance?
                         (nil? (::tree/copy-root view))
                         (not (componentizable? ctx (tree/symbol-key view))))
                    (assoc ::tree/detached true))
        id        (id-of ctx (::tree/path view))
        children  (tree/children (:tree ctx) view)
        main?     (and (= :SYMBOL (:type view))
                       (nil? (::tree/copy-root view))
                       (componentizable? ctx (::tree/path view)))
        container? (and (:isStateGroup view) (nil? (::tree/copy-root view)))]
    (when (and instance? (nil? (tree/node (:tree ctx) (tree/symbol-key view))))
      (report! ctx view "component not found in the file, imported without its content"))
    (when (and instance? (some? (tree/symbol-key view))
               (not (componentizable? ctx (tree/symbol-key view)))
               (tree/node (:tree ctx) (tree/symbol-key view)))
      (report! ctx view "component nested in another component, imported as a plain board"))
    (when (:overriddenSymbolID view)
      (report! ctx view "instance swap not supported, the original component is kept"))
    (when (and (= :SYMBOL (:type view)) (not main?) (nil? (::tree/copy-root view)))
      (report! ctx view "component inside another component imported as a plain board"))
    (build! ctx fb/add-board
            (merge (base-attrs ctx parent view)
                   (rect-geometry abs view)
                   (radius view)
                   (layout-container ctx view)
                   (d/without-nils
                    {:id                   id
                     :fills                (fills ctx view)
                     :strokes              (strokes ctx view)
                     :show-content         (when (:frameMaskDisabled view) true)
                     :is-variant-container (when container? true)})
                   (when container?
                     {:name (cpn/clean-path (or (:name view) "Component"))})))
    (keep-name! ctx id (when-not (or main? container?) (:name view)))
    (map-children! ctx abs view children)
    (build! ctx fb/close-board)
    (when main?
      (add-main-component! ctx view id parent))
    (count! ctx (if instance? :instances :boards))))

(defn- map-group!
  [ctx abs parent view]
  (let [children (tree/children (:tree ctx) view)
        id       (id-of ctx (::tree/path view))]
    (if (empty? (remove #(= :skip (kind %)) children))
      (report! ctx view "empty group skipped")
      (do
        (build! ctx fb/add-group (merge (base-attrs ctx parent view)
                                        (rect-geometry abs view)
                                        {:id id}))
        (keep-name! ctx id (:name view))
        (map-children! ctx abs view children)
        (build! ctx fb/close-group)
        (count! ctx :groups)))))

(defn- add-path!
  [ctx parent view segments]
  (let [id (id-of ctx (::tree/path view))]
    (build! ctx fb/add-shape
            (merge (base-attrs ctx parent view)
                   (winding view)
                   {:id      id
                    :type    :path
                    :content segments
                    :fills   (fills ctx view)
                    :strokes (strokes ctx view)}))
    (keep-name! ctx id (:name view))
    (count! ctx :paths)))

(defn- placeholder!
  [ctx abs parent view reason]
  (report! ctx view reason)
  (let [id (id-of ctx (::tree/path view))]
    (build! ctx fb/add-shape
            (merge (base-attrs ctx parent view)
                   (rect-geometry abs view)
                   {:id     id
                    :type   :rect
                    :name   (str "[unsupported] " (type-name view))
                    :fills  [{:fill-color "#d9d9d9" :fill-opacity 0.5}]}))))

(def ^:private bool-types
  {:UNION :union :SUBTRACT :difference :INTERSECT :intersection :XOR :exclude})

(defn- map-bool!
  [ctx abs parent view]
  (let [children (->> (tree/children (:tree ctx) view)
                      (remove #(contains? #{:skip :frame :unsupported} (kind %))))
        id       (id-of ctx (::tree/path view))
        type     (get bool-types (:booleanOperation view) :union)]
    (if (empty? children)
      (if-let [segments (not-empty (geometry-segments ctx (:fillGeometry view) abs))]
        (add-path! ctx parent view segments)
        (placeholder! ctx abs parent view "boolean operation without shapes"))
      (do
        (build! ctx fb/add-group (merge (base-attrs ctx parent view)
                                        (rect-geometry abs view)
                                        {:id id}))
        (doseq [child children]
          (map-view! ctx abs view child))
        (build! ctx fb/close-group)
        (build! ctx fb/add-bool {:group-id id :type type})
        (let [fills   (fills ctx view)
              strokes (strokes ctx view)]
          (build! ctx fb/update-shape id #(assoc % :fills fills :strokes strokes)))
        (keep-name! ctx id (:name view))
        (count! ctx :bools)))))

(defn- map-shape!
  [ctx abs parent view]
  (let [id (id-of ctx (::tree/path view))]
    (case (kind view)
      :rect
      (do
        (build! ctx fb/add-shape
                (merge (base-attrs ctx parent view)
                       (rect-geometry abs view)
                       (radius view)
                       {:id id :type :rect
                        :fills (fills ctx view)
                        :strokes (strokes ctx view)}))
        (keep-name! ctx id (:name view))
        (count! ctx :rects))

      :circle
      (do
        (build! ctx fb/add-shape
                (merge (base-attrs ctx parent view)
                       (rect-geometry abs view)
                       {:id id :type :circle
                        :fills (fills ctx view)
                        :strokes (strokes ctx view)}))
        (keep-name! ctx id (:name view))
        (count! ctx :circles))

      :path
      (if-let [segments (not-empty (path-segments ctx view abs))]
        (add-path! ctx parent view segments)
        (placeholder! ctx abs parent view "vector without geometry data"))

      :text
      (do
        (build! ctx fb/add-shape
                (merge (base-attrs ctx parent view)
                       (rect-geometry abs view)
                       {:id id :type :text
                        :grow-type (get grow-types (:textAutoResize view) :fixed)
                        :content (text-content ctx view)
                        :strokes (strokes ctx view)}))
        (keep-name! ctx id (:name view))
        (count! ctx :texts)))))

(defn- failure-reason
  "A short reason for a node penpot rejected: the hint of the error and,
  for a schema check, the first attribute that failed."
  [cause]
  (let [data (ex-data cause)
        in   (some-> data ::sm/explain :errors first :in)]
    (str "skipped, penpot rejected it: " (or (:hint data) (ex-message cause) (class cause))
         (when (seq in) (str " at " (str/join " " (map #(if (keyword? %) (name %) (str %)) in)))))))

(defn- map-view*
  [ctx parent-abs parent view]
  (let [abs (geom/multiply parent-abs (geom/from-fig (:transform view)))]
    (case (kind view)
      :frame       (map-frame! ctx abs parent view)
      :group       (map-group! ctx abs parent view)
      :bool        (map-bool! ctx abs parent view)
      :skip        (count! ctx :skipped)
      :unsupported (placeholder! ctx abs parent view (str "node type " (type-name view) " not supported"))
      (map-shape! ctx abs parent view))))

(defn- map-view!
  "Map one view and its subtree under the current parent of the builder.
  `abs` is the absolute transform of the parent and `parent` its view.

  A node the builder rejects does not fail the file: the builder state
  goes back to what it was before the node, so the node and its subtree
  are left out, and the report says why."
  [ctx parent-abs parent view]
  (let [state  @(:state ctx)
        report @(:report ctx)]
    (try
      (map-view* ctx parent-abs parent view)
      (catch Exception cause
        (vreset! (:state ctx) state)
        (vreset! (:report ctx) report)
        (report! ctx view (failure-reason cause))
        (count! ctx :failed)))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; STYLES
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- style-nodes
  [tree type]
  (->> (vals (:nodes tree))
       (filter #(= type (:styleType %)))
       (sort-by (juxt :name ::tree/key))))

(defn- add-styles!
  "Library colors from fill styles and typographies from text styles.
  Answers with the ids by style key."
  [ctx]
  (let [tree   (:tree ctx)
        colors (reduce (fn [acc node]
                         (let [paints (visible-paints (:fillPaints node))
                               view   (tree/root-view tree (::tree/key node))
                               fill   (when (= 1 (count paints))
                                        (paint->fill ctx view (first paints) :fill))
                               [path name] (cpn/split-group-name (or (:name node) "Color"))]
                           (if (or (:fill-color fill) (:fill-color-gradient fill))
                             (let [id (id-of ctx (str "color:" (::tree/key node)))]
                               (add-library-color! ctx
                                                   (d/without-nils
                                                    {:id       id
                                                     :name     (if (str/blank? name) "Color" name)
                                                     :path     path
                                                     :color    (:fill-color fill)
                                                     :gradient (:fill-color-gradient fill)
                                                     :opacity  (:fill-opacity fill)}))
                               (count! ctx :colors)
                               (assoc acc (::tree/key node) id))
                             acc)))
                       {}
                       (style-nodes tree :FILL))
        typos  (reduce (fn [acc node]
                         (let [view  (tree/root-view tree (::tree/key node))
                               style (text-style ctx view nil)
                               id    (id-of ctx (str "typography:" (::tree/key node)))
                               [path name] (cpn/split-group-name (or (:name node) "Typography"))]
                           (build! ctx fb/add-library-typography
                                   (-> (select-keys style [:font-id :font-family :font-variant-id
                                                           :font-size :font-weight :font-style
                                                           :line-height :letter-spacing :text-transform])
                                       (assoc :id id
                                              :name (if (str/blank? name) "Typography" name)
                                              :path path)))
                           (count! ctx :typographies)
                           (assoc acc (::tree/key node) id)))
                       {}
                       (style-nodes tree :TEXT))]
    (assoc ctx :colors colors :typographies typos)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; DOCUMENT
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- main-symbols
  "The symbols that become penpot main components: every SYMBOL that has
  no other SYMBOL above it (penpot does not nest mains)."
  [tree]
  (->> (vals (:nodes tree))
       (filter #(= :SYMBOL (:type %)))
       (remove (fn [node]
                 (some #(let [a (tree/node tree %)]
                          (and (= :SYMBOL (:type a)) (not (:isStateGroup a))))
                       (tree/ancestors-of tree (::tree/key node)))))
       (into #{} (map ::tree/key))))

(defn- variant-props
  "The variant properties of every component set: all the variants get
  the same property names, in the order they first appear."
  [tree]
  (->> (vals (:nodes tree))
       (filter :isStateGroup)
       (into {}
             (map (fn [group]
                    (let [variants (->> (::tree/children group)
                                        (map (partial tree/node tree))
                                        (filter #(= :SYMBOL (:type %))))
                          parsed   (into {} (map (fn [v] [(::tree/key v) (variant-properties (:name v))])) variants)
                          names    (into [] (comp (mapcat val) (map :name) (distinct)) parsed)]
                      [(::tree/key group)
                       (update-vals parsed
                                    (fn [props]
                                      (let [by-name (into {} (map (juxt :name :value)) props)]
                                        (mapv (fn [n] {:name n :value (get by-name n "")}) names))))]))))))

(defn- referenced-symbols
  "The symbols that the instances of the document show, directly or
  through other symbols."
  [tree]
  (->> (vals (:nodes tree))
       (filter #(= :INSTANCE (:type %)))
       (keep tree/symbol-key)
       (into #{})))

(defn- internal-roots
  "The nodes of the internal canvas that must be built for the
  instances of the document to point at something: each referenced
  symbol, or the component set around it."
  [tree internal-keys referenced]
  (let [internal? (fn [key] (some internal-keys (tree/ancestors-of tree key)))]
    (->> referenced
         (filter internal?)
         (map (fn [key]
                (let [parent (tree/node tree (::tree/parent (tree/node tree key)))]
                  (if (:isStateGroup parent) (::tree/key parent) key))))
         (distinct)
         (sort)
         (vec))))

(defn- absolute-of
  "The absolute transform of a node of the plain tree."
  [tree key]
  (->> (cons key (tree/ancestors-of tree key))
       (reverse)
       (map (comp geom/from-fig :transform (partial tree/node tree)))
       (reduce geom/multiply geom/identity-matrix)))

(defn- map-page!
  [ctx page-id name roots]
  (build! ctx fb/add-page {:id page-id :name name})
  (doseq [view roots]
    (let [parent-key (::tree/parent view)
          parent-abs (if (= :CANVAS (:type (tree/node (:tree ctx) parent-key)))
                       geom/identity-matrix
                       (absolute-of (:tree ctx) parent-key))]
      (map-view! ctx parent-abs (tree/node (:tree ctx) parent-key) view)))
  (build! ctx fb/close-page)
  (count! ctx :pages))

(defn- restore-names
  "Put back the Figma names the builder made unique per page."
  [data names]
  (update data :pages-index
          (fn [pages]
            (update-vals pages
                         (fn [page]
                           (update page :objects
                                   (fn [objects]
                                     (reduce-kv (fn [objects id name]
                                                  (if (contains? objects id)
                                                    (assoc-in objects [id :name] name)
                                                    objects))
                                                objects
                                                names))))))))

(defn map-document
  "Build a penpot file from the tree of a `.fig` document.

  Options: `:file-id`, `:name`, `:project-id` and `:media`, the images
  already stored, by the hex of their SHA-1, as `{:id :width :height
  :mtype :name}`.

  Answers with `{:file <file map with :data> :report <report>}`."
  [tree {:keys [file-id name project-id media]}]
  (let [state  (volatile! (-> (fb/create-state)
                              (fb/add-file {:id file-id :name name :project-id project-id})))
        {:keys [pages internal]} (tree/pages tree)
        styles (->> (vals (:nodes tree)) (filter :styleType)
                    (into {} (map (juxt ::tree/key identity))))
        ctx    {:tree       tree
                :file-id    file-id
                :media      (or media {})
                :state      state
                :ids        (volatile! {})
                :names      (volatile! {})
                :fonts      (volatile! #{})
                :report     (volatile! {:total 0 :summary {} :unsupported [] :counts {}})
                :mains      (main-symbols tree)
                :styles     styles
                :style-by-asset (into {} (keep (fn [[k n]] (when-let [key (:key n)] [key k]))) styles)
                :variant-props (variant-props tree)}
        ctx    (add-styles! ctx)
        internal-keys (into #{} (map ::tree/key) internal)
        extra  (internal-roots tree internal-keys (referenced-symbols tree))]

    (doseq [page pages]
      (map-page! ctx (id-of ctx (::tree/key page)) (or (:name page) "Page")
                 (tree/children tree (tree/root-view tree (::tree/key page)))))

    (when (seq extra)
      (map-page! ctx (id-of ctx "page:components") "Components"
                 (mapv (partial tree/root-view tree) extra)))

    (let [file   (-> @state
                     (get ::fb/files)
                     (get file-id)
                     (update :data restore-names @(:names ctx)))
          report @(:report ctx)]
      {:file   file
       :report {:total       (:total report)
                :unsupported (:unsupported report)
                :summary     (->> (:summary report)
                                  (map (fn [[[fig-type reason] n]]
                                         {:fig-type fig-type :reason reason :count n}))
                                  (sort-by (comp - :count))
                                  (vec))
                :counts      (:counts report)
                :fonts       (vec (sort @(:fonts ctx)))}})))
