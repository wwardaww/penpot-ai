;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.binfile.fig.fixtures
  "Synthetic `.fig` files for the tests, built here so no real design is
  ever committed.

  A Kiwi encoder writes a small schema shaped like the one Figma embeds
  (same definition and field names, only the fields the importer reads)
  and messages encoded with it; `canvas` frames them as `canvas.fig` and
  `zip` packs them with images the way a saved Figma file does."
  (:require
   [app.common.data :as d]
   [clojure.java.io :as jio])
  (:import
   com.github.luben.zstd.ZstdOutputStream
   java.io.ByteArrayOutputStream
   java.io.File
   java.nio.ByteBuffer
   java.nio.ByteOrder
   java.nio.charset.StandardCharsets
   java.security.MessageDigest
   java.util.zip.Deflater
   java.util.zip.DeflaterOutputStream
   java.util.zip.ZipEntry
   java.util.zip.ZipOutputStream))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; KIWI WRITER
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn write-byte [^ByteArrayOutputStream out b]
  (.write out (int (bit-and (long b) 0xff))))

(defn write-var-uint [out v]
  (loop [v (bit-and (long v) 0xffffffff)]
    (let [b (bit-and v 0x7f)
          v (unsigned-bit-shift-right v 7)]
      (if (zero? v)
        (write-byte out b)
        (do (write-byte out (bit-or b 0x80))
            (recur v))))))

(defn write-var-int [out v]
  (let [v (long v)]
    (write-var-uint out (bit-xor (bit-shift-left v 1) (bit-shift-right v 63)))))

(defn write-var-uint64 [out v]
  (loop [v (long v) i 0]
    (if (= i 8)
      (write-byte out v)
      (let [b (bit-and v 0x7f)
            v (unsigned-bit-shift-right v 7)]
        (if (zero? v)
          (write-byte out b)
          (do (write-byte out (bit-or b 0x80))
              (recur v (inc i))))))))

(defn write-var-float [out v]
  (let [bits (bit-and (long (Float/floatToRawIntBits (float v))) 0xffffffff)
        bits (bit-and (bit-or (unsigned-bit-shift-right bits 23)
                              (bit-shift-left bits 9))
                      0xffffffff)]
    (if (zero? (bit-and bits 0xff))
      (write-byte out 0)
      (do (write-byte out bits)
          (write-byte out (unsigned-bit-shift-right bits 8))
          (write-byte out (unsigned-bit-shift-right bits 16))
          (write-byte out (unsigned-bit-shift-right bits 24))))))

(defn write-string [^ByteArrayOutputStream out ^String s]
  (let [bytes (.getBytes s StandardCharsets/UTF_8)]
    (.write out bytes 0 (alength bytes))
    (write-byte out 0)))

(defn- write-bytes [^ByteArrayOutputStream out ^bytes data]
  (write-var-uint out (alength data))
  (.write out data 0 (alength data)))

(defn- bytes-of [f]
  (let [out (ByteArrayOutputStream.)]
    (f out)
    (.toByteArray out)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; SCHEMA
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def ^:private native-ids
  {:bool -1 :byte -2 :int -3 :uint -4 :float -5 :string -6 :int64 -7 :uint64 -8})

(defn- enum [name & values]
  {:name name :kind :enum :values (vec values)})

(defn- struct* [name & fields]
  {:name name :kind :struct :fields (vec fields)})

(defn- message [name & fields]
  {:name name :kind :message :fields (vec fields)})

(def figma-schema
  "A subset of the schema Figma embeds in its files: the same names, only
  the fields the importer reads, plus `extra` to prove unknown fields are
  decoded and ignored."
  [(enum "MessageType" "JOIN_START" "NODE_CHANGES")
   (enum "NodePhase" "CREATED" "REMOVED")
   (enum "NodeType" "NONE" "DOCUMENT" "CANVAS" "GROUP" "FRAME" "BOOLEAN_OPERATION"
         "VECTOR" "STAR" "LINE" "ELLIPSE" "RECTANGLE" "REGULAR_POLYGON"
         "ROUNDED_RECTANGLE" "TEXT" "SLICE" "SYMBOL" "INSTANCE" "STICKY"
         "SHAPE_WITH_TEXT" "CONNECTOR" "SECTION")
   (enum "PaintType" "SOLID" "GRADIENT_LINEAR" "GRADIENT_RADIAL" "GRADIENT_ANGULAR"
         "GRADIENT_DIAMOND" "IMAGE" "EMOJI" "VIDEO")
   (enum "EffectType" "INNER_SHADOW" "DROP_SHADOW" "FOREGROUND_BLUR" "BACKGROUND_BLUR")
   (enum "StrokeAlign" "CENTER" "INSIDE" "OUTSIDE")
   (enum "StackMode" "NONE" "HORIZONTAL" "VERTICAL")
   (enum "StackAlign" "MIN" "CENTER" "MAX" "BASELINE")
   (enum "StackJustify" "MIN" "CENTER" "MAX" "SPACE_EVENLY" "SPACE_BETWEEN")
   (enum "StackSize" "FIXED" "RESIZE_TO_FIT" "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE")
   (enum "StackCounterAlign" "MIN" "CENTER" "MAX" "STRETCH" "AUTO" "BASELINE")
   (enum "StackWrap" "NO_WRAP" "WRAP")
   (enum "StackCounterAlignContent" "AUTO" "SPACE_BETWEEN")
   (enum "ConstraintType" "MIN" "CENTER" "MAX" "STRETCH" "SCALE")
   (enum "BlendMode" "PASS_THROUGH" "NORMAL" "DARKEN" "MULTIPLY")
   (enum "BooleanOperation" "UNION" "INTERSECT" "SUBTRACT" "XOR")
   (enum "WindingRule" "NONZERO" "ODD")
   (enum "TextAlignHorizontal" "LEFT" "CENTER" "RIGHT" "JUSTIFIED")
   (enum "TextAlignVertical" "TOP" "CENTER" "BOTTOM")
   (enum "TextAutoResize" "NONE" "WIDTH_AND_HEIGHT" "HEIGHT")
   (enum "NumberUnits" "RAW" "PIXELS" "PERCENT")
   (enum "StyleType" "NONE" "FILL" "STROKE" "TEXT" "EFFECT" "GRID")
   (enum "ImageScaleMode" "STRETCH" "FIT" "FILL" "TILE")
   (struct* "GUID" ["sessionID" :uint] ["localID" :uint])
   (struct* "Color" ["r" :float] ["g" :float] ["b" :float] ["a" :float])
   (struct* "Vector" ["x" :float] ["y" :float])
   (struct* "Matrix" ["m00" :float] ["m01" :float] ["m02" :float]
            ["m10" :float] ["m11" :float] ["m12" :float])
   (struct* "ParentIndex" ["guid" "GUID"] ["position" :string])
   (struct* "FontName" ["family" :string] ["style" :string] ["postscript" :string])
   (message "Number" ["value" :float] ["units" "NumberUnits"])
   (message "GUIDPath" ["guids" "GUID" true])
   (message "ColorStop" ["color" "Color"] ["position" :float])
   (message "Image" ["hash" :byte true] ["name" :string])
   (message "Paint" ["type" "PaintType"] ["color" "Color"] ["opacity" :float]
            ["visible" :bool] ["blendMode" "BlendMode"] ["stops" "ColorStop" true]
            ["transform" "Matrix"] ["image" "Image"] ["imageScaleMode" "ImageScaleMode"])
   (message "Effect" ["type" "EffectType"] ["color" "Color"] ["offset" "Vector"]
            ["radius" :float] ["visible" :bool] ["spread" :float])
   (message "Path" ["windingRule" "WindingRule"] ["commandsBlob" :uint] ["styleID" :uint])
   (message "VectorData" ["vectorNetworkBlob" :uint] ["normalizedSize" "Vector"])
   (message "StyleId" ["guid" "GUID"])
   (message "TextData" ["characters" :string] ["characterStyleIDs" :uint true]
            ["styleOverrideTable" "NodeChange" true])
   (message "SymbolData" ["symbolID" "GUID"] ["symbolOverrides" "NodeChange" true])
   (message "NodeChange"
            ["guid" "GUID"] ["phase" "NodePhase"] ["parentIndex" "ParentIndex"]
            ["type" "NodeType"] ["name" :string] ["visible" :bool] ["locked" :bool]
            ["opacity" :float] ["blendMode" "BlendMode"] ["size" "Vector"]
            ["transform" "Matrix"] ["fillPaints" "Paint" true] ["strokePaints" "Paint" true]
            ["strokeWeight" :float] ["strokeAlign" "StrokeAlign"] ["effects" "Effect" true]
            ["cornerRadius" :float] ["rectangleCornerRadiiIndependent" :bool]
            ["rectangleTopLeftCornerRadius" :float] ["rectangleTopRightCornerRadius" :float]
            ["rectangleBottomLeftCornerRadius" :float] ["rectangleBottomRightCornerRadius" :float]
            ["frameMaskDisabled" :bool] ["resizeToFit" :bool] ["mask" :bool]
            ["stackMode" "StackMode"] ["stackSpacing" :float]
            ["stackHorizontalPadding" :float] ["stackVerticalPadding" :float]
            ["stackPaddingRight" :float] ["stackPaddingBottom" :float]
            ["stackPrimaryAlignItems" "StackJustify"] ["stackCounterAlignItems" "StackAlign"]
            ["stackPrimarySizing" "StackSize"] ["stackCounterSizing" "StackSize"]
            ["stackChildPrimaryGrow" :float] ["stackChildAlignSelf" "StackCounterAlign"]
            ["stackWrap" "StackWrap"] ["stackCounterSpacing" :float]
            ["stackCounterAlignContent" "StackCounterAlignContent"]
            ["horizontalConstraint" "ConstraintType"] ["verticalConstraint" "ConstraintType"]
            ["fillGeometry" "Path" true] ["strokeGeometry" "Path" true]
            ["vectorData" "VectorData"] ["booleanOperation" "BooleanOperation"]
            ["textData" "TextData"] ["fontName" "FontName"] ["fontSize" :float]
            ["lineHeight" "Number"] ["letterSpacing" "Number"]
            ["textAlignHorizontal" "TextAlignHorizontal"] ["textAlignVertical" "TextAlignVertical"]
            ["textAutoResize" "TextAutoResize"] ["styleID" :uint]
            ["styleType" "StyleType"] ["key" :string]
            ["styleIdForFill" "StyleId"] ["styleIdForText" "StyleId"]
            ["internalOnly" :bool] ["isStateGroup" :bool]
            ["symbolData" "SymbolData"] ["derivedSymbolData" "NodeChange" true]
            ["guidPath" "GUIDPath"] ["overrideKey" "GUID"]
            ["extra" :int64])
   (message "Blob" ["bytes" :byte true])
   (message "Message" ["type" "MessageType"] ["sessionID" :uint]
            ["nodeChanges" "NodeChange" true] ["blobs" "Blob" true])])

(defn- index-of-def [schema]
  (into {} (map-indexed (fn [i d] [(:name d) i])) schema))

(defn encode-schema
  "The binary Kiwi schema of a schema given as data."
  ([] (encode-schema figma-schema))
  ([schema]
   (let [idx (index-of-def schema)]
     (bytes-of
      (fn [out]
        (write-var-uint out (count schema))
        (doseq [{:keys [name kind values fields]} schema]
          (write-string out name)
          (write-byte out (case kind :enum 0 :struct 1 :message 2))
          (if (= :enum kind)
            (do (write-var-uint out (count values))
                (doseq [[i v] (map-indexed vector values)]
                  (write-string out v)
                  (write-var-int out 0)
                  (write-byte out 0)
                  (write-var-uint out i)))
            (do (write-var-uint out (count fields))
                (doseq [[i [fname type array?]] (map-indexed vector fields)]
                  (write-string out fname)
                  (write-var-int out (if (keyword? type) (native-ids type) (idx type)))
                  (write-byte out (if array? 1 0))
                  (write-var-uint out (if (= :message kind) (inc i) i)))))))))))

(declare ^:private write-value)

(defn- write-single
  [out schema type v]
  (if (keyword? type)
    (case type
      :bool   (write-byte out (if v 1 0))
      :byte   (write-byte out v)
      :int    (write-var-int out v)
      :uint   (write-var-uint out v)
      :float  (write-var-float out v)
      :string (write-string out v)
      :int64  (write-var-int out v)
      :uint64 (write-var-uint64 out v))
    (let [{:keys [kind values fields]} (d/seek #(= type (:name %)) schema)]
      (case kind
        :enum
        (write-var-uint out (or (d/index-of values (name v))
                                (throw (ex-info "unknown enum value" {:type type :value v}))))

        :struct
        (doseq [[fname ftype array?] fields]
          (write-value out schema ftype array? (get v (keyword fname) (if (keyword? ftype) 0 {}))))

        :message
        (do
          (doseq [[i [fname ftype array?]] (map-indexed vector fields)
                  :let [fv (get v (keyword fname))]
                  :when (some? fv)]
            (write-var-uint out (inc i))
            (write-value out schema ftype array? fv))
          (when-let [unknown (seq (remove (into #{} (map (comp keyword first)) fields) (keys v)))]
            (throw (ex-info "unknown fields" {:type type :fields unknown})))
          (write-var-uint out 0))))))

(defn- write-value
  [out schema type array? v]
  (cond
    (and array? (= :byte type))
    (write-bytes out (if (bytes? v) v (byte-array (map unchecked-byte v))))

    array?
    (do (write-var-uint out (count v))
        (doseq [item v] (write-single out schema type item)))

    :else
    (write-single out schema type v)))

(defn encode-message
  "The bytes of `value` encoded as the definition `root`."
  ([value] (encode-message figma-schema "Message" value))
  ([schema root value]
   (bytes-of (fn [out] (write-single out schema root value)))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; CONTAINER
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn deflate-raw ^bytes [^bytes data]
  (bytes-of (fn [out]
              (with-open [z (DeflaterOutputStream. out (Deflater. 6 true))]
                (.write z data)))))

(defn zlib ^bytes [^bytes data]
  (bytes-of (fn [out]
              (with-open [z (DeflaterOutputStream. out (Deflater. 6 false))]
                (.write z data)))))

(defn zstd ^bytes [^bytes data]
  (bytes-of (fn [out]
              (with-open [z (ZstdOutputStream. out)]
                (.write z data)))))

(defn canvas
  "A `canvas.fig` payload: prelude, version and the two chunks."
  [message & {:keys [prelude version compress-schema compress-message schema]
              :or {prelude "fig-kiwi" version 48
                   compress-schema deflate-raw compress-message zstd
                   schema figma-schema}}]
  (let [chunks [(compress-schema (encode-schema schema))
                (compress-message (encode-message schema "Message" message))]]
    (bytes-of
     (fn [^ByteArrayOutputStream out]
       (.write out (.getBytes ^String prelude StandardCharsets/ISO_8859_1))
       (let [bb (-> (ByteBuffer/allocate 4) (.order ByteOrder/LITTLE_ENDIAN))]
         (.putInt bb (int version))
         (.write out (.array bb)))
       (doseq [^bytes chunk chunks]
         (let [bb (-> (ByteBuffer/allocate 4) (.order ByteOrder/LITTLE_ENDIAN))]
           (.putInt bb (alength chunk))
           (.write out (.array bb))
           (.write out chunk)))))))

(defn sha1-hex [^bytes data]
  (let [md (MessageDigest/getInstance "SHA-1")]
    (apply str (map #(format "%02x" (bit-and (long %) 0xff)) (.digest md data)))))

(defn write-zip!
  "Write a saved Figma file to `path`: `canvas.fig`, `meta.json` and the
  images by the hex of their SHA-1."
  [^File path canvas-bytes & {:keys [images meta]}]
  (with-open [zip (ZipOutputStream. (jio/output-stream path))]
    (.putNextEntry zip (ZipEntry. "canvas.fig"))
    (.write zip ^bytes canvas-bytes)
    (.closeEntry zip)
    (.putNextEntry zip (ZipEntry. "meta.json"))
    (.write zip (.getBytes ^String (or meta "{\"file_name\":\"Fixture\"}") StandardCharsets/UTF_8))
    (.closeEntry zip)
    (doseq [[hash ^bytes data] images]
      (.putNextEntry zip (ZipEntry. (str "images/" hash)))
      (.write zip data)
      (.closeEntry zip)))
  path)

(defn temp-file ^File [suffix]
  (doto (File/createTempFile "fig-fixture" suffix) (.deleteOnExit)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; DOCUMENT
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn guid [[s l]] {:sessionID s :localID l})

(defn node
  "A node change: `:id` and `:parent` as `[session local]`, `:pos` its
  fractional position, the rest NodeChange fields."
  [{:keys [id parent pos] :as attrs}]
  (cond-> (-> attrs
              (dissoc :id :parent :pos)
              (assoc :guid (guid id)))
    parent (assoc :parentIndex {:guid (guid parent) :position (or pos "a")})))

(defn color [r g b & [a]] {:r r :g g :b b :a (or a 1.0)})

(defn solid [c & {:as opts}] (merge {:type :SOLID :color c :opacity 1.0 :visible true} opts))

(defn at
  "A translation matrix."
  [x y]
  {:m00 1.0 :m01 0.0 :m02 x :m10 0.0 :m11 1.0 :m12 y})

(defn rotated
  "A rotation by `deg` degrees around the origin of the node, placed at
  `x`, `y`."
  [deg x y]
  (let [r (Math/toRadians deg)
        c (Math/cos r)
        s (Math/sin r)]
    {:m00 c :m01 (- s) :m02 x :m10 s :m11 c :m12 y}))

(defn size [w h] {:x w :y h})

(defn commands-blob
  "A commands blob from `[[op & args] ...]`."
  [commands]
  (bytes-of
   (fn [^ByteArrayOutputStream out]
     (doseq [[op & args] commands]
       (write-byte out op)
       (doseq [a args]
         (let [bb (-> (ByteBuffer/allocate 4) (.order ByteOrder/LITTLE_ENDIAN))]
           (.putFloat bb (float a))
           (.write out (.array bb))))))))

(defn network-blob
  "A vector network blob from vertices `[[x y] ...]`, segments
  `[[start end] ...]` (straight) and regions `[[winding-bit [[seg ...]]]]`."
  [vertices segments regions]
  (let [bb (-> (ByteBuffer/allocate 4096) (.order ByteOrder/LITTLE_ENDIAN))]
    (.putInt bb (count vertices))
    (.putInt bb (count segments))
    (.putInt bb (count regions))
    (doseq [[x y] vertices]
      (.putInt bb 0) (.putFloat bb (float x)) (.putFloat bb (float y)))
    (doseq [[s e] segments]
      (.putInt bb 0)
      (.putInt bb s) (.putFloat bb 0.0) (.putFloat bb 0.0)
      (.putInt bb e) (.putFloat bb 0.0) (.putFloat bb 0.0))
    (doseq [[winding loops] regions]
      (.putInt bb winding)
      (.putInt bb (count loops))
      (doseq [lp loops]
        (.putInt bb (count lp))
        (doseq [i lp] (.putInt bb i))))
    (java.util.Arrays/copyOf (.array bb) (.position bb))))

(def tiny-png
  "A 2x1 PNG made for the tests."
  (let [img (java.awt.image.BufferedImage. 2 1 java.awt.image.BufferedImage/TYPE_INT_ARGB)
        out (ByteArrayOutputStream.)]
    (.setRGB img 0 0 (unchecked-int 0xffff0000))
    (.setRGB img 1 0 (unchecked-int 0xff0000ff))
    (javax.imageio.ImageIO/write img "png" out)
    (.toByteArray out)))

(defn medium-document
  "A document with what a real medium file has: pages, an auto layout
  card with text and an image, a component set with variants, an
  instance with an override, a vector, a group, a boolean, styles on the
  internal canvas and one node type penpot cannot hold."
  []
  (let [img-hash  (sha1-hex tiny-png)
        img-bytes (map (fn [i] (Integer/parseInt (subs img-hash (* 2 i) (+ 2 (* 2 i))) 16)) (range 20))
        white     (solid (color 1.0 1.0 1.0))
        blue      (solid (color 0.0 0.4 1.0))
        triangle  (commands-blob [[1 0 0] [2 10 0] [2 5 10] [0]])
        line-net  (network-blob [[0 0] [20 0]] [[0 1]] [])
        text-style {:fontName {:family "Inter" :style "Regular" :postscript ""}
                    :fontSize 16.0
                    :lineHeight {:value 24.0 :units :PIXELS}
                    :letterSpacing {:value 0.0 :units :PERCENT}}]
    {:image {:hash img-hash :bytes tiny-png}
     :message
     {:type :NODE_CHANGES
      :sessionID 0
      :blobs [{:bytes triangle} {:bytes line-net}]
      :nodeChanges
      [(node {:id [0 0] :type :DOCUMENT :name "Document"})
       (node {:id [0 1] :parent [0 0] :pos "a" :type :CANVAS :name "Page 1"})
       (node {:id [0 2] :parent [0 0] :pos "b" :type :CANVAS :name "Internal Only Canvas"
              :internalOnly true})

       ;; styles live on the internal canvas
       (node (merge {:id [0 20] :parent [0 2] :pos "a" :type :TEXT :name "Heading/Body"
                     :styleType :TEXT :key "text-style-key" :size (size 10 10)}
                    text-style))
       (node {:id [0 21] :parent [0 2] :pos "b" :type :RECTANGLE :name "Brand/Blue"
              :styleType :FILL :key "fill-style-key" :size (size 10 10)
              :fillPaints [blue]})

       ;; an auto layout card
       (node {:id [1 1] :parent [0 1] :pos "a" :type :FRAME :name "Card"
              :size (size 200 300) :transform (at 100 50)
              :fillPaints [white] :cornerRadius 12.0
              :effects [{:type :DROP_SHADOW :color (color 0 0 0 0.25) :offset {:x 0 :y 4}
                         :radius 8.0 :visible true :spread 0.0}]
              :stackMode :VERTICAL :stackSpacing 8.0
              :stackHorizontalPadding 16.0 :stackVerticalPadding 16.0
              :stackPaddingRight 16.0 :stackPaddingBottom 16.0
              :stackPrimaryAlignItems :MIN :stackCounterAlignItems :CENTER
              :stackPrimarySizing :RESIZE_TO_FIT :stackCounterSizing :FIXED})
       (node (merge {:id [1 2] :parent [1 1] :pos "a" :type :TEXT :name "Title"
                     :size (size 168 48) :transform (at 16 16)
                     :fillPaints [(solid (color 0.1 0.1 0.1))]
                     :textAutoResize :HEIGHT
                     :styleIdForText {:guid (guid [0 20])}
                     :textData {:characters "Hello\nWorld"
                                :characterStyleIDs [0 0 0 1 1 0 0 0 0 0 0]
                                :styleOverrideTable [{:styleID 1
                                                      :fontName {:family "Inter" :style "Bold" :postscript ""}}]}}
                    text-style))
       (node {:id [1 3] :parent [1 1] :pos "b" :type :RECTANGLE :name "Photo"
              :size (size 168 100) :transform (at 16 72)
              :stackChildAlignSelf :STRETCH
              :fillPaints [{:type :IMAGE :opacity 1.0 :visible true :imageScaleMode :FILL
                            :image {:hash img-bytes :name "photo"}}]})
       (node {:id [1 4] :parent [1 1] :pos "c" :type :INSTANCE :name "Buy button"
              :size (size 120 40) :transform (at 16 180)
              :symbolData {:symbolID (guid [2 1])
                           :symbolOverrides [{:guidPath {:guids [(guid [2 3])]}
                                              :textData {:characters "Buy"}}]}})

       ;; a vector, an ellipse, a group with a rotated child, a boolean
       (node {:id [1 5] :parent [0 1] :pos "b" :type :VECTOR :name "Triangle"
              :size (size 10 10) :transform (at 400 50)
              :fillPaints [blue]
              :fillGeometry [{:windingRule :NONZERO :commandsBlob 0 :styleID 0}]})
       (node {:id [1 11] :parent [0 1] :pos "ba" :type :LINE :name "Rule"
              :size (size 20 0) :transform (at 400 80)
              :strokePaints [blue] :strokeWeight 2.0
              :vectorData {:vectorNetworkBlob 1 :normalizedSize (size 20 0)}})
       (node {:id [1 6] :parent [0 1] :pos "c" :type :ELLIPSE :name "Dot"
              :size (size 20 20) :transform (at 450 50) :fillPaints [blue]})
       (node {:id [1 7] :parent [0 1] :pos "d" :type :FRAME :name "Group" :resizeToFit true
              :size (size 40 40) :transform (at 500 50)})
       (node {:id [1 8] :parent [1 7] :pos "a" :type :RECTANGLE :name "Diamond"
              :size (size 20 20) :transform (rotated 45 20 0) :fillPaints [blue]})
       (node {:id [1 9] :parent [0 1] :pos "e" :type :BOOLEAN_OPERATION :name "Union"
              :booleanOperation :UNION :size (size 30 20) :transform (at 600 50)
              :fillPaints [blue]})
       (node {:id [1 91] :parent [1 9] :pos "a" :type :RECTANGLE :name "A"
              :size (size 20 20) :transform (at 0 0)})
       (node {:id [1 92] :parent [1 9] :pos "b" :type :RECTANGLE :name "B"
              :size (size 20 20) :transform (at 10 0)})
       (node {:id [1 10] :parent [0 1] :pos "f" :type :STICKY :name "Note"
              :size (size 100 100) :transform (at 700 50)})

       ;; a component set with two variants
       (node {:id [1 20] :parent [0 1] :pos "g" :type :FRAME :name "Button"
              :isStateGroup true :size (size 300 60) :transform (at 100 500)})
       (node {:id [2 1] :parent [1 20] :pos "a" :type :SYMBOL :name "State=Default"
              :size (size 120 40) :transform (at 10 10) :fillPaints [blue] :cornerRadius 8.0
              :styleIdForFill {:guid (guid [0 21])}})
       (node (merge {:id [2 3] :parent [2 1] :pos "a" :type :TEXT :name "Label"
                     :size (size 100 24) :transform (at 10 8)
                     :fillPaints [white]
                     :textData {:characters "Button"}}
                    text-style))
       (node {:id [2 2] :parent [1 20] :pos "b" :type :SYMBOL :name "State=Hover"
              :size (size 120 40) :transform (at 160 10) :fillPaints [blue] :cornerRadius 8.0})
       (node (merge {:id [2 4] :parent [2 2] :pos "a" :type :TEXT :name "Label"
                     :size (size 100 24) :transform (at 10 8)
                     :fillPaints [white]
                     :textData {:characters "Button"}}
                    text-style))]}}))

(defn medium-fig!
  "The medium document written as a saved Figma file (a ZIP)."
  []
  (let [{:keys [message image]} (medium-document)]
    (write-zip! (temp-file ".fig") (canvas message)
                :images {(:hash image) (:bytes image)})))

(defn wrap-document
  "Two wrapping auto layout rows as Figma saves them: one whose counter
  gap is not set, which the file stores as NaN, and one whose counter gap
  is \"auto\"."
  []
  {:type :NODE_CHANGES
   :sessionID 0
   :nodeChanges
   [(node {:id [0 0] :type :DOCUMENT :name "Document"})
    (node {:id [0 1] :parent [0 0] :pos "a" :type :CANVAS :name "Page 1"})
    (node {:id [1 1] :parent [0 1] :pos "a" :type :FRAME :name "Tags"
           :size (size 200 100) :transform (at 0 0)
           :stackMode :HORIZONTAL :stackWrap :WRAP
           :stackSpacing 8.0 :stackCounterSpacing Double/NaN})
    (node {:id [1 2] :parent [1 1] :pos "a" :type :RECTANGLE :name "Tag A"
           :size (size 80 20) :transform (at 0 0)})
    (node {:id [1 3] :parent [1 1] :pos "b" :type :RECTANGLE :name "Tag B"
           :size (size 80 20) :transform (at 88 0)})
    (node {:id [2 1] :parent [0 1] :pos "b" :type :FRAME :name "Chips"
           :size (size 200 100) :transform (at 0 200)
           :stackMode :HORIZONTAL :stackWrap :WRAP :stackSpacing 4.0
           :stackCounterSpacing 12.0 :stackCounterAlignContent :SPACE_BETWEEN})
    (node {:id [2 2] :parent [2 1] :pos "a" :type :ELLIPSE :name "Chip"
           :size (size 20 20) :transform (at 0 0)})]})
