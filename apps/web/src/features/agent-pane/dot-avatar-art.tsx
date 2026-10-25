import type { ReactElement } from "react";
import type { DotCharacter } from "@space/contracts";

/**
 * The six Dot bodies, drawn from apps/web/public/dots/*.svg without their faces (DotAvatar draws the face for each
 * mood) and without the grain filter (invisible at UI sizes, costly to repaint while the face moves). `p` prefixes
 * every id so several avatars of one Dot can share a page. Groups named dot-av-* are the parts that move.
 */
export const dotBodies: Record<DotCharacter, (p: string) => ReactElement> = {
  astronaut: (p) => <>
    <defs>
    <radialGradient id={`${p}suit`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(128 143) rotate(58) scale(119 101)">
    <stop stopColor="#FFFCED"/><stop offset=".47" stopColor="#EFEADB"/><stop offset=".82" stopColor="#D7D7CE"/><stop offset="1" stopColor="#AEBFC4"/>
    </radialGradient>
    <radialGradient id={`${p}helmet`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(136 75) rotate(53) scale(112 108)">
    <stop stopColor="#FFFEF1"/><stop offset=".5" stopColor="#EEEBDD"/><stop offset=".85" stopColor="#C8D1CE"/><stop offset="1" stopColor="#94ABB4"/>
    </radialGradient>
    <radialGradient id={`${p}glass`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(143 96) rotate(57) scale(69 84)">
    <stop stopColor="#395163"/><stop offset=".4" stopColor="#20374B"/><stop offset=".82" stopColor="#13283B"/><stop offset="1" stopColor="#0D2030"/>
    </radialGradient>
    <linearGradient id={`${p}trim`} x1="111" y1="166" x2="190" y2="249" gradientUnits="userSpaceOnUse">
    <stop stopColor="#98AFB8"/><stop offset=".5" stopColor="#6E8A99"/><stop offset="1" stopColor="#496A7D"/>
    </linearGradient>
    <linearGradient id={`${p}gold`} x1="128" y1="86" x2="174" y2="115" gradientUnits="userSpaceOnUse">
    <stop stopColor="#FFF2C7"/><stop offset=".55" stopColor="#E8C88B"/><stop offset="1" stopColor="#BA9765"/>
    </linearGradient>
    <linearGradient id={`${p}reflection`} x1="129" y1="88" x2="156" y2="118" gradientUnits="userSpaceOnUse">
    <stop stopColor="#E6EEEA" stopOpacity=".56"/><stop offset="1" stopColor="#BDCFD4" stopOpacity="0"/>
    </linearGradient>
    <filter id={`${p}shadow`} x="-30%" y="-180%" width="160%" height="460%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id={`${p}soft`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.5"/></filter>
    </defs>
    <ellipse cx="162" cy="266" rx="64" ry="5" fill="#263D50" opacity=".15" filter={`url(#${p}shadow)`}/>
    {/* A little exposed backpack makes the padded silhouette read as a suit. */}
    <path d="M109 151C100 151 96 158 97 169L99 206C100 215 105 220 115 219L131 214L129 157Z" fill={`url(#${p}trim)`}/>
    <path d="M102 161L105 199" stroke="#BED0CE" strokeWidth="3" strokeLinecap="round" opacity=".64"/>
    <g>
    <path d="M120 164C109 159 99 166 95 177L82 201C77 210 82 220 91 223C100 226 111 216 116 205L130 181Z" fill={`url(#${p}suit)`}/>
    <path d="M92 197L113 208L108 217L85 207Z" fill={`url(#${p}trim)`}/>
    <path d="M83 207C77 209 75 217 79 223C81 227 86 229 91 227L104 222C108 220 109 216 106 213C103 209 99 210 95 211C93 207 88 205 83 207Z" fill={`url(#${p}suit)`}/>
    <path d="M87 218L95 217" stroke="#BEC8C5" strokeWidth="2" strokeLinecap="round"/>
    <g className="dot-av-arm">
    <path d="M195 163C207 165 218 159 223 149L232 133C237 126 244 127 250 132C256 137 253 145 250 151L235 177C227 191 215 199 201 196L185 179Z" fill={`url(#${p}suit)`}/>
    <path d="M229 136L249 148L254 139L235 127Z" fill={`url(#${p}trim)`}/>
    <path d="M235 131C228 127 229 118 232 112L234 97C235 91 240 91 242 97L245 110L247 89C248 83 253 84 254 90L255 109L262 96C265 91 269 94 267 100L263 115L269 111C274 108 278 113 274 118L265 130C260 137 248 141 242 136Z" fill={`url(#${p}suit)`}/>
    <path d="M239 116C242 114 246 116 248 120" stroke="#BEC7C0" strokeWidth="2" strokeLinecap="round"/>
    <path d="M254 112L252 120M262 116L259 122" stroke="#B3C1BE" strokeWidth="1.8" strokeLinecap="round"/>
    </g>
    <path d="M126 221C123 228 123 242 125 248C129 254 143 255 150 249L155 223Z" fill={`url(#${p}suit)`}/>
    <path d="M171 223L173 248C179 255 192 255 198 249C200 241 198 229 195 221Z" fill={`url(#${p}suit)`}/>
    <path d="M125 242C119 245 114 250 113 254C112 260 119 264 132 263L148 262C154 261 157 257 155 251L152 243Z" fill={`url(#${p}trim)`}/>
    <path d="M174 244C169 249 169 257 175 260L201 263C210 264 215 260 212 254C209 249 202 246 198 244Z" fill={`url(#${p}trim)`}/>
    <path d="M117 254C128 257 141 256 151 254M176 253C187 257 199 258 207 258" stroke="#ADC1C4" strokeWidth="2.5" strokeLinecap="round" opacity=".65"/>
    <path d="M137 145C122 148 113 162 113 181L116 211C117 229 127 238 145 240L173 240C190 240 203 231 205 213L207 178C207 159 194 146 178 144Z" fill={`url(#${p}suit)`}/>
    <path d="M195 173C202 196 198 223 184 230L183 238C200 233 206 220 205 201L207 180Z" fill="#809BA8" opacity=".18" filter={`url(#${p}soft)`}/>
    <path d="M122 178C120 196 120 207 125 215" stroke="#FFFFF1" strokeWidth="4" strokeLinecap="round" opacity=".7"/>
    <path d="M119 218C140 225 180 227 201 218" stroke="#A8B9BC" strokeWidth="3" strokeLinecap="round"/>
    <path d="M121 216C143 223 178 224 200 216" stroke="#FCFAE9" strokeWidth="2" strokeLinecap="round" opacity=".75"/>
    <path d="M156 171L157 213" stroke="#A7B9BD" strokeWidth="2" strokeLinecap="round" opacity=".5"/>
    <path d="M137 155C142 166 179 168 188 155" stroke="#738F9C" strokeWidth="9" strokeLinecap="round"/>
    <path d="M136 153C147 161 176 162 187 152" stroke="#D2DDDA" strokeWidth="4" strokeLinecap="round"/>
    <rect x="166" y="180" width="26" height="22" rx="7" fill={`url(#${p}trim)`}/>
    <rect x="169" y="183" width="20" height="16" rx="5" fill="#486579"/>
    <circle cx="175" cy="190" r="3" fill="#E5C38B"/>
    <path d="M182 189H185M182 194H185" stroke="#C1D6D6" strokeWidth="2" strokeLinecap="round"/>
    <path d="M137 180L139 186L145 188L139 190L137 196L135 190L129 188L135 186Z" fill="#C2A16D" opacity=".9"/>
    <path d="M159 53C126 53 105 70 101 99C98 122 103 142 120 153C132 161 147 164 164 163C194 163 216 144 219 117C222 80 198 53 159 53Z" fill={`url(#${p}helmet)`}/>
    <path d="M199 73C215 91 218 119 207 137C193 155 176 157 164 156" stroke="#6E8B9B" strokeWidth="7" strokeLinecap="round" opacity=".2" filter={`url(#${p}soft)`}/>
    <path d="M110 94C113 77 132 63 152 63" stroke="#FFFFF4" strokeWidth="4" strokeLinecap="round" opacity=".83"/>
    <path d="M124 84C114 91 109 104 111 117C113 137 131 150 158 151C184 152 204 139 207 121C212 97 193 80 164 79C146 78 133 79 124 84Z" fill="#849DA5"/>
    <path d="M126 87C116 93 112 104 114 116C116 134 133 147 158 148C182 149 201 137 204 120C208 98 191 83 164 82C148 81 135 82 126 87Z" fill={`url(#${p}glass)`}/>
    <path d="M126 96C134 86 149 85 163 87C150 93 139 100 133 113C129 118 122 110 123 104Z" fill={`url(#${p}reflection)`}/>
    <path d="M133 96C139 90 150 89 158 90" stroke={`url(#${p}gold)`} strokeWidth="3.5" strokeLinecap="round"/>
    <path d="M129 102L127 107" stroke="#EFD8A5" strokeWidth="2.5" strokeLinecap="round" opacity=".62"/>
    <path d="M187 133L192 130" stroke="#D2B782" strokeWidth="2" strokeLinecap="round" opacity=".65"/>
    <path d="M125 138C136 146 151 149 167 147" stroke="#72929F" strokeWidth="1.8" strokeLinecap="round" opacity=".42"/>
    <path d="M96 106C91 109 91 122 97 126L104 125L104 106Z" fill={`url(#${p}trim)`}/>
    <path d="M97 111V119" stroke="#DCE5DD" strokeWidth="2.5" strokeLinecap="round"/>
    <path d="M218 104C224 105 227 116 221 122L215 123L216 105Z" fill={`url(#${p}trim)`}/>
    <path d="M145 156C153 159 169 159 177 155" stroke="#F5F2E4" strokeWidth="2.5" strokeLinecap="round"/>
    </g>
  </>,
  star: (p) => <>
    <defs>
    <path id={`${p}silhouette`} d="M158 55C168 54 177 87 189 109C213 114 249 112 256 124C263 136 233 156 216 175C218 200 235 234 225 244C215 254 181 231 158 220C135 231 103 256 93 246C83 236 100 201 101 176C84 158 53 137 59 125C65 113 101 114 125 108C137 86 148 56 158 55Z"/>
    <radialGradient id={`${p}body`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(125 110) rotate(55) scale(159 153)">
    <stop stopColor="#FFF4CB"/><stop offset=".36" stopColor="#FFE6AD"/><stop offset=".68" stopColor="#EFC585"/><stop offset=".88" stopColor="#DCA660"/><stop offset="1" stopColor="#BE813F"/>
    </radialGradient>
    <linearGradient id={`${p}edge`} x1="90" y1="100" x2="209" y2="253" gradientUnits="userSpaceOnUse">
    <stop stopColor="#E9C98D"/><stop offset=".55" stopColor="#C99654"/><stop offset="1" stopColor="#AC703B"/>
    </linearGradient>
    <radialGradient id={`${p}cheek`} cx=".4" cy=".3" r=".7"><stop stopColor="#D98960" stopOpacity=".38"/><stop offset="1" stopColor="#D98960" stopOpacity="0"/></radialGradient>
    <linearGradient id={`${p}rim`} x1="104" y1="91" x2="194" y2="216" gradientUnits="userSpaceOnUse"><stop stopColor="#FFFFE5" stopOpacity=".85"/><stop offset="1" stopColor="#FFFFE5" stopOpacity="0"/></linearGradient>
    <clipPath id={`${p}clip`}><use href={`#${p}silhouette`}/></clipPath>
    <filter id={`${p}shadow`} x="-30%" y="-180%" width="160%" height="460%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id={`${p}soft`} x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="6"/></filter>
    </defs>
    <ellipse cx="158" cy="261" rx="67" ry="6" fill="#5A4538" opacity=".13" filter={`url(#${p}shadow)`}/>
    <use href={`#${p}silhouette`} transform="translate(0 3)" fill={`url(#${p}edge)`}/>
    <g>
    <use href={`#${p}silhouette`} fill={`url(#${p}body)`}/>
    <g clipPath={`url(#${p}clip)`}>
    <path d="M163 69C165 89 175 113 192 124C214 128 237 126 253 127C234 145 215 160 206 177C208 202 220 230 220 244" stroke="#BB7439" strokeWidth="15" strokeLinecap="round" opacity=".13" filter={`url(#${p}soft)`}/>
    <path d="M112 174C109 198 99 224 96 240M150 207C129 219 113 235 99 241" stroke="#FFE8B3" strokeWidth="9" strokeLinecap="round" opacity=".35" filter={`url(#${p}soft)`}/>
    <path d="M123 126C133 119 147 104 154 83" stroke="#FFFFE2" strokeWidth="18" strokeLinecap="round" opacity=".3" filter={`url(#${p}soft)`}/>
    <path d="M159 213C178 221 205 241 221 244" stroke="#B17B43" strokeWidth="4" strokeLinecap="round" opacity=".23"/>
    </g>
    <path d="M69 126C83 122 108 125 125 117C140 100 148 78 155 67" stroke={`url(#${p}rim)`} strokeWidth="3.5" strokeLinecap="round"/>
    <path d="M67 133C74 141 87 151 95 158" stroke="#FFF2CB" strokeWidth="2.5" strokeLinecap="round" opacity=".48"/>
    <path d="M190 120C211 125 236 119 246 125" stroke="#FFF1C6" strokeWidth="2" strokeLinecap="round" opacity=".45"/>
    <ellipse cx="114" cy="173" rx="15" ry="10" fill={`url(#${p}cheek)`}/>
    <ellipse cx="196" cy="170" rx="15" ry="10" fill={`url(#${p}cheek)`}/>
    </g>
  </>,
  robot: (p) => <>
    <defs>
    <radialGradient id={`${p}shell`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(124 101) rotate(57) scale(152 127)">
    <stop stopColor="#E0F3EB"/><stop offset=".3" stopColor="#BFE4DE"/><stop offset=".62" stopColor="#93C8CB"/><stop offset=".86" stopColor="#6EA3B2"/><stop offset="1" stopColor="#527C94"/>
    </radialGradient>
    <linearGradient id={`${p}joints`} x1="100" y1="175" x2="208" y2="264" gradientUnits="userSpaceOnUse"><stop stopColor="#91BFC5"/><stop offset=".58" stopColor="#668C9F"/><stop offset="1" stopColor="#3E617A"/></linearGradient>
    <radialGradient id={`${p}window`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(129 108) rotate(40) scale(96 65)"><stop stopColor="#304E60"/><stop offset=".6" stopColor="#183247"/><stop offset="1" stopColor="#10283B"/></radialGradient>
    <linearGradient id={`${p}eye`} x1="135" y1="119" x2="142" y2="140" gradientUnits="userSpaceOnUse"><stop stopColor="#EFF7DD"/><stop offset="1" stopColor="#B1E2DA"/></linearGradient>
    <radialGradient id={`${p}antenna`} cx=".3" cy=".25" r=".8"><stop stopColor="#FFF0BE"/><stop offset=".65" stopColor="#E5C68B"/><stop offset="1" stopColor="#B59565"/></radialGradient>
    <linearGradient id={`${p}glass-rim`} x1="111" y1="103" x2="201" y2="157" gradientUnits="userSpaceOnUse"><stop stopColor="#ECF5E8" stopOpacity=".7"/><stop offset="1" stopColor="#ECF5E8" stopOpacity="0"/></linearGradient>
    <filter id={`${p}shadow`} x="-30%" y="-180%" width="160%" height="460%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id={`${p}soft`} x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="3"/></filter>
    </defs>
    <ellipse cx="160" cy="266" rx="63" ry="5" fill="#263D50" opacity=".15" filter={`url(#${p}shadow)`}/>
    <path d="M158 81L159 63" stroke="#6C919F" strokeWidth="7" strokeLinecap="round"/>
    <path d="M157 77L158 64" stroke="#C7E5DE" strokeWidth="2" strokeLinecap="round"/>
    <g>
    <g className="dot-av-antenna">
    <circle cx="159" cy="57" r="9" fill={`url(#${p}antenna)`}/>
    <path d="M154 54C154 52 157 51 159 51" stroke="#FFF6D9" strokeWidth="2" strokeLinecap="round"/>
    </g>
    <path d="M134 228L131 249L148 249L151 229Z" fill={`url(#${p}joints)`}/>
    <path d="M173 229L173 249L191 250L188 227Z" fill={`url(#${p}joints)`}/>
    <path d="M132 237L147 239M174 237L190 239" stroke="#D1E7DF" strokeWidth="2" strokeLinecap="round" opacity=".65"/>
    <path d="M129 245C120 248 117 253 118 257C119 262 132 263 146 261C154 260 159 257 157 251C156 247 151 244 143 244Z" fill={`url(#${p}shell)`}/>
    <path d="M177 244C172 247 169 255 173 259C178 263 199 263 204 260C210 256 205 251 197 247C191 244 183 242 177 244Z" fill={`url(#${p}shell)`}/>
    <path d="M122 258C131 260 145 259 152 257M177 258C185 260 199 260 203 258" stroke="#3E617A" strokeWidth="3" strokeLinecap="round" opacity=".54"/>
    <circle cx="112" cy="188" r="12" fill={`url(#${p}joints)`}/>
    <circle cx="209" cy="188" r="12" fill={`url(#${p}joints)`}/>
    <path d="M105 184C102 182 98 184 96 188L85 205C82 210 85 215 90 215C94 216 97 212 100 208L111 194C113 190 111 186 105 184Z" fill={`url(#${p}shell)`}/>
    <path d="M92 195L102 201" stroke="#5F8C9C" strokeWidth="3.5" strokeLinecap="round"/>
    <path d="M96 193L103 197" stroke="#D9EDE4" strokeWidth="2" strokeLinecap="round" opacity=".68"/>
    <path d="M85 205C77 205 71 212 73 220C75 228 87 232 94 226C98 222 98 217 94 215L88 216C90 211 89 207 85 205Z" fill={`url(#${p}joints)`}/>
    <path d="M78 213C76 218 81 223 86 222" stroke="#BDDED9" strokeWidth="3" strokeLinecap="round"/>
    <g className="dot-av-arm">
    <path d="M216 184C221 182 225 184 227 190L237 208C239 213 236 216 232 216C228 216 224 212 222 208L212 195C209 191 212 187 216 184Z" fill={`url(#${p}shell)`}/>
    <path d="M224 196L233 193" stroke="#5F8C9C" strokeWidth="3.5" strokeLinecap="round"/>
    <path d="M222 192L230 190" stroke="#D9EDE4" strokeWidth="2" strokeLinecap="round" opacity=".6"/>
    <path d="M235 206C243 208 249 216 246 223C243 230 234 233 228 227C224 223 224 218 228 216L234 218C231 212 231 207 235 206Z" fill={`url(#${p}joints)`}/>
    <path d="M240 216C242 220 237 225 232 223" stroke="#BDDED9" strokeWidth="3" strokeLinecap="round"/>
    </g>
    <path d="M137 170C124 171 115 179 116 193L119 216C120 231 130 238 147 239L176 239C193 238 204 230 205 214L206 193C206 179 196 171 184 170Z" fill={`url(#${p}shell)`}/>
    <path d="M132 180C126 185 125 197 128 208" stroke="#EBF8EC" strokeWidth="3.5" strokeLinecap="round" opacity=".65"/>
    <path d="M195 183C200 199 199 220 187 229" stroke="#426B88" strokeWidth="9" strokeLinecap="round" opacity=".15" filter={`url(#${p}soft)`}/>
    <path d="M128 227C145 234 178 234 195 225" stroke="#638B9E" strokeWidth="2" strokeLinecap="round" opacity=".6"/>
    <path d="M144 191C144 187 149 185 155 185H171C178 185 182 188 182 193V209C182 214 178 217 171 217H154C148 217 144 214 144 209Z" fill="#5E8B9D" opacity=".64"/>
    <path d="M148 192C154 189 171 189 178 192" stroke="#B8DCD7" strokeWidth="2" strokeLinecap="round" opacity=".65"/>
    <circle cx="156" cy="201" r="4.5" fill="#E9CD94"/>
    <path d="M167 200H173M167 206H171" stroke="#D3E9DF" strokeWidth="2.5" strokeLinecap="round"/>
    <path d="M146 170L146 177C149 183 174 183 179 177L179 170Z" fill={`url(#${p}joints)`}/>
    <path d="M151 176H173" stroke="#C8E1DA" strokeWidth="2" strokeLinecap="round" opacity=".8"/>
    <ellipse cx="95" cy="128" rx="10" ry="15" fill={`url(#${p}joints)`}/>
    <ellipse cx="224" cy="130" rx="10" ry="15" fill={`url(#${p}joints)`}/>
    <path d="M91 123V133M228 125V135" stroke="#BEDDD6" strokeWidth="3" strokeLinecap="round"/>
    <path d="M134 80C108 80 95 92 94 117L94 139C94 162 107 176 134 178L185 178C213 177 226 164 226 140L225 117C224 94 211 81 186 80Z" fill={`url(#${p}shell)`}/>
    <path d="M215 106C225 124 222 151 213 159" stroke="#416E89" strokeWidth="8" strokeLinecap="round" opacity=".15" filter={`url(#${p}soft)`}/>
    <path d="M106 109C108 96 120 89 136 89" stroke="#F0F8EB" strokeWidth="3.5" strokeLinecap="round" opacity=".75"/>
    <path d="M131 101C114 101 104 109 104 126V137C105 153 116 160 132 161L186 161C202 160 214 152 214 136V124C213 108 203 101 186 101Z" fill="#719FAC"/>
    <path d="M131 104C115 104 108 111 108 126V135C108 150 117 157 133 158L185 158C200 157 210 150 210 135V125C210 111 200 104 186 104Z" fill={`url(#${p}window)`}/>
    <path d="M114 120C115 111 124 109 134 109H163" stroke={`url(#${p}glass-rim)`} strokeWidth="2" strokeLinecap="round"/>
    <path d="M128 169C143 172 178 173 193 169" stroke="#C4E1DA" strokeWidth="2" strokeLinecap="round" opacity=".5"/>
    </g>
  </>,
  comet: (p) => <>
    <defs>
    <linearGradient id={`${p}tail`} x1="208" y1="91" x2="162" y2="220" gradientUnits="userSpaceOnUse">
    <stop stopColor="#FFF0CF"/><stop offset=".3" stopColor="#FAD5A4"/><stop offset=".61" stopColor="#EDA16D"/><stop offset="1" stopColor="#CC7159"/>
    </linearGradient>
    <linearGradient id={`${p}ribbon`} x1="253" y1="78" x2="137" y2="181" gradientUnits="userSpaceOnUse"><stop stopColor="#FFF5DB"/><stop offset=".48" stopColor="#FFDEAC"/><stop offset="1" stopColor="#F1B48B"/></linearGradient>
    <linearGradient id={`${p}stream`} x1="259" y1="124" x2="178" y2="201" gradientUnits="userSpaceOnUse"><stop stopColor="#FFEBC1"/><stop offset="1" stopColor="#E6A076"/></linearGradient>
    <radialGradient id={`${p}head`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(106 145) rotate(47) scale(115 109)">
    <stop stopColor="#FFE3C8"/><stop offset=".3" stopColor="#FBCBAD"/><stop offset=".62" stopColor="#EEA38B"/><stop offset=".86" stopColor="#D88376"/><stop offset="1" stopColor="#B76563"/>
    </radialGradient>
    <radialGradient id={`${p}cheek`} cx=".45" cy=".35" r=".7"><stop stopColor="#C76464" stopOpacity=".42"/><stop offset="1" stopColor="#C76464" stopOpacity="0"/></radialGradient>
    <linearGradient id={`${p}rim`} x1="85" y1="136" x2="150" y2="201" gradientUnits="userSpaceOnUse"><stop stopColor="#FFF3D9" stopOpacity=".85"/><stop offset="1" stopColor="#FFF3D9" stopOpacity="0"/></linearGradient>
    <path id={`${p}tail-shape`} d="M123 145C162 130 185 89 267 63C260 82 237 104 225 127C245 111 266 103 276 104C264 137 234 156 218 179C243 166 262 158 275 160C253 198 213 217 175 224L136 207Z"/>
    <clipPath id={`${p}tail-clip`}><use href={`#${p}tail-shape`}/></clipPath>
    <filter id={`${p}shadow`} x="-30%" y="-180%" width="160%" height="460%"><feGaussianBlur stdDeviation="3.5"/></filter>
    <filter id={`${p}soft`} x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="4"/></filter>
    </defs>
    <ellipse cx="151" cy="264" rx="65" ry="5" fill="#5B3C3E" opacity=".12" filter={`url(#${p}shadow)`}/>
    <g>
    <g className="dot-av-tail">
    <use href={`#${p}tail-shape`} fill={`url(#${p}tail)`}/>
    <g clipPath={`url(#${p}tail-clip)`}>
    <path d="M144 177C170 155 184 114 259 70C224 96 213 127 195 151C180 173 176 192 154 203Z" fill={`url(#${p}ribbon)`}/>
    <path d="M168 205C198 180 222 135 272 107C257 133 223 158 210 181C199 197 181 211 168 215Z" fill={`url(#${p}stream)`}/>
    <path d="M166 217C207 207 237 179 271 163C245 191 218 213 177 225Z" fill="#FFE2AF" opacity=".55"/>
    <path d="M163 197C181 178 181 150 210 117" stroke="#B86656" strokeWidth="8" strokeLinecap="round" opacity=".12" filter={`url(#${p}soft)`}/>
    <path d="M199 196C210 185 221 166 237 153" stroke="#C57558" strokeWidth="7" strokeLinecap="round" opacity=".18" filter={`url(#${p}soft)`}/>
    <path d="M141 150C176 133 193 98 256 69" stroke="#FFF6DF" strokeWidth="3" strokeLinecap="round" opacity=".62"/>
    </g>
    </g>
    {/* The head overlaps the streams, like a softly sculpted moving pebble. */}
    <path d="M124 126C87 121 63 143 60 177C56 211 77 239 109 247C140 255 175 243 190 216C206 187 188 150 161 135C148 128 138 126 124 126Z" fill={`url(#${p}head)`}/>
    <path d="M173 157C191 182 187 211 169 228C155 239 139 244 124 243" stroke="#AE6663" strokeWidth="10" strokeLinecap="round" opacity=".17" filter={`url(#${p}soft)`}/>
    <path d="M71 181C70 160 89 140 112 137" stroke={`url(#${p}rim)`} strokeWidth="4" strokeLinecap="round"/>
    <path d="M77 210C80 217 85 222 92 225" stroke="#FFDCC0" strokeWidth="2.5" strokeLinecap="round" opacity=".43"/>
    <path d="M112 135C125 132 139 137 146 140" stroke="#FFF1D5" strokeWidth="2" strokeLinecap="round" opacity=".4"/>
    <ellipse cx="88" cy="194" rx="14" ry="10" transform="rotate(-12 88 194)" fill={`url(#${p}cheek)`}/>
    <ellipse cx="161" cy="183" rx="13" ry="9" transform="rotate(-12 161 183)" fill={`url(#${p}cheek)`}/>
    <path d="M159 147C162 149 165 153 166 156" stroke="#F6C0A0" strokeWidth="2" strokeLinecap="round" opacity=".5"/>
    </g>
  </>,
  moon: (p) => <>
    <defs>
    <path id={`${p}silhouette`} d="M223 69C177 43 119 59 91 96C68 125 66 166 82 200C99 234 131 255 166 254C194 254 219 244 237 224C201 231 175 214 162 188C141 146 160 96 199 78C207 74 215 71 223 69Z"/>
    <radialGradient id={`${p}body`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(112 104) rotate(49) scale(165 137)">
    <stop stopColor="#F3F3E7"/><stop offset=".29" stopColor="#DDE6E5"/><stop offset=".58" stopColor="#BACCD7"/><stop offset=".8" stopColor="#94ADC4"/><stop offset="1" stopColor="#708CA9"/>
    </radialGradient>
    <linearGradient id={`${p}edge`} x1="98" y1="103" x2="211" y2="245" gradientUnits="userSpaceOnUse"><stop stopColor="#BACBD2"/><stop offset="1" stopColor="#5A7498"/></linearGradient>
    <linearGradient id={`${p}rim`} x1="98" y1="73" x2="87" y2="213" gradientUnits="userSpaceOnUse"><stop stopColor="#FFFFF0" stopOpacity=".8"/><stop offset="1" stopColor="#FFFFF0" stopOpacity="0"/></linearGradient>
    <radialGradient id={`${p}crater`} cx=".58" cy=".7" r=".76"><stop stopColor="#A8BFCB" stopOpacity=".12"/><stop offset=".58" stopColor="#809CAC" stopOpacity=".18"/><stop offset=".9" stopColor="#6A879F" stopOpacity=".27"/><stop offset="1" stopColor="#6A879F" stopOpacity="0"/></radialGradient>
    <radialGradient id={`${p}blush`} cx=".4" cy=".4" r=".7"><stop stopColor="#9795B2" stopOpacity=".25"/><stop offset="1" stopColor="#9795B2" stopOpacity="0"/></radialGradient>
    <clipPath id={`${p}clip`}><use href={`#${p}silhouette`}/></clipPath>
    <filter id={`${p}shadow`} x="-30%" y="-180%" width="160%" height="460%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id={`${p}soft`} x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="4"/></filter>
    </defs>
    <ellipse cx="159" cy="267" rx="58" ry="5" fill="#293D57" opacity=".14" filter={`url(#${p}shadow)`}/>
    <use href={`#${p}silhouette`} transform="translate(1.5 2)" fill={`url(#${p}edge)`}/>
    <g>
    <use href={`#${p}silhouette`} fill={`url(#${p}body)`}/>
    <g clipPath={`url(#${p}clip)`}>
    <path d="M198 81C162 101 146 139 158 176C168 209 193 232 225 232" stroke="#4D6E94" strokeWidth="13" strokeLinecap="round" opacity=".15" filter={`url(#${p}soft)`}/>
    <path d="M103 209C117 231 149 247 178 245" stroke="#7D94B1" strokeWidth="12" strokeLinecap="round" opacity=".15" filter={`url(#${p}soft)`}/>
    <ellipse cx="123" cy="106" rx="16" ry="12" transform="rotate(-26 123 106)" fill={`url(#${p}crater)`}/>
    <path d="M111 114C117 119 130 116 136 108" stroke="#F2F2E7" strokeWidth="2" strokeLinecap="round" opacity=".38"/>
    <ellipse cx="109" cy="211" rx="12" ry="10" transform="rotate(34 109 211)" fill={`url(#${p}crater)`}/>
    <path d="M101 215C103 221 112 224 117 220" stroke="#D8E5E4" strokeWidth="1.6" strokeLinecap="round" opacity=".44"/>
    <ellipse cx="173" cy="235" rx="16" ry="7" transform="rotate(8 173 235)" fill={`url(#${p}crater)`}/>
    <path d="M160 237C164 242 177 244 186 239" stroke="#C7D6DE" strokeWidth="1.5" strokeLinecap="round" opacity=".42"/>
    <ellipse cx="96" cy="135" rx="5" ry="4" fill="#7F9CAC" opacity=".16"/>
    <ellipse cx="158" cy="83" rx="6" ry="4" transform="rotate(-15 158 83)" fill="#7F9CAC" opacity=".16"/>
    <ellipse cx="132" cy="224" rx="4" ry="3" fill="#6583A0" opacity=".18"/>
    <path d="M91 171C87 159 89 148 94 141" stroke="#F5F5E9" strokeWidth="8" strokeLinecap="round" opacity=".18" filter={`url(#${p}soft)`}/>
    <ellipse cx="97" cy="178" rx="12" ry="8" transform="rotate(8 97 178)" fill={`url(#${p}blush)`}/>
    <ellipse cx="147" cy="180" rx="10" ry="8" fill={`url(#${p}blush)`}/>
    </g>
    <path d="M81 148C82 113 105 78 142 69C161 64 177 64 191 66" stroke={`url(#${p}rim)`} strokeWidth="3" strokeLinecap="round"/>
    <path d="M166 201C179 220 199 229 218 228" stroke="#D7E2E2" strokeWidth="2" strokeLinecap="round" opacity=".3"/>
    </g>
  </>,
  planet: (p) => <>
    <defs>
    <radialGradient id={`${p}body`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(128 101) rotate(50) scale(134 125)">
    <stop stopColor="#E6E0EE"/><stop offset=".3" stopColor="#CACAE6"/><stop offset=".62" stopColor="#A2AED6"/><stop offset=".85" stopColor="#7E91BF"/><stop offset="1" stopColor="#5D709C"/>
    </radialGradient>
    <linearGradient id={`${p}ring-back`} x1="76" y1="127" x2="233" y2="222" gradientUnits="userSpaceOnUse"><stop stopColor="#C8BAA9"/><stop offset=".4" stopColor="#E8DBC0"/><stop offset="1" stopColor="#AF9C8B"/></linearGradient>
    <linearGradient id={`${p}ring-front`} x1="68" y1="153" x2="251" y2="226" gradientUnits="userSpaceOnUse"><stop stopColor="#FFF1D1"/><stop offset=".35" stopColor="#F1E5CB"/><stop offset=".72" stopColor="#DAC9AC"/><stop offset="1" stopColor="#C2AE96"/></linearGradient>
    <linearGradient id={`${p}ring-lip`} x1="74" y1="155" x2="245" y2="236" gradientUnits="userSpaceOnUse"><stop stopColor="#DCCCAF"/><stop offset="1" stopColor="#A28F83"/></linearGradient>
    <linearGradient id={`${p}band-light`} x1="110" y1="111" x2="192" y2="156" gradientUnits="userSpaceOnUse"><stop stopColor="#F0E3EC" stopOpacity=".46"/><stop offset="1" stopColor="#D0C9E6" stopOpacity=".14"/></linearGradient>
    <radialGradient id={`${p}cheek`} cx=".4" cy=".4" r=".7"><stop stopColor="#B786A3" stopOpacity=".28"/><stop offset="1" stopColor="#B786A3" stopOpacity="0"/></radialGradient>
    <clipPath id={`${p}planet-clip`}><circle cx="160" cy="151" r="79"/></clipPath>
    <filter id={`${p}shadow`} x="-30%" y="-180%" width="160%" height="460%"><feGaussianBlur stdDeviation="3.5"/></filter>
    <filter id={`${p}soft`} x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="3"/></filter>
    </defs>
    <ellipse cx="161" cy="254" rx="65" ry="5" fill="#343D59" opacity=".13" filter={`url(#${p}shadow)`}/>
    <g>
    {/* The far half of the annulus is physically behind the sphere. */}
    <path d="M61 157C58 155 57 153 58 151C64 135 115 145 174 168C232 191 270 216 264 232L243 220C246 213 213 191 165 173C117 154 77 145 73 155Z" fill={`url(#${p}ring-back)`}/>
    <path d="M59 150C68 136 119 149 174 170C226 190 266 216 264 228" stroke="#F1E3C7" strokeWidth="2" strokeLinecap="round" opacity=".65"/>
    <circle cx="160" cy="151" r="79" fill={`url(#${p}body)`}/>
    <g clipPath={`url(#${p}planet-clip)`}>
    <path d="M93 105C124 93 194 111 231 136" stroke={`url(#${p}band-light)`} strokeWidth="11" strokeLinecap="round"/>
    <path d="M84 123C117 109 190 128 238 154" stroke="#E0D4EA" strokeWidth="3" strokeLinecap="round" opacity=".17"/>
    <path d="M89 182C127 177 188 191 226 210" stroke="#667CAF" strokeWidth="12" strokeLinecap="round" opacity=".16"/>
    <path d="M81 192C122 183 184 200 222 220" stroke="#E0D4EA" strokeWidth="4" strokeLinecap="round" opacity=".18"/>
    <path d="M214 101C242 143 233 192 207 208C184 224 161 227 143 223" stroke="#4B608D" strokeWidth="13" strokeLinecap="round" opacity=".14" filter={`url(#${p}soft)`}/>
    <path d="M82 172C119 181 163 202 199 213C214 218 224 219 233 219" stroke="#465B88" strokeWidth="9" strokeLinecap="round" opacity=".2" filter={`url(#${p}soft)`}/>
    <ellipse cx="114" cy="155" rx="13" ry="9" fill={`url(#${p}cheek)`}/>
    <ellipse cx="199" cy="160" rx="13" ry="9" fill={`url(#${p}cheek)`}/>
    </g>
    <path d="M90 132C96 104 121 82 149 80" stroke="#EEEAF1" strokeWidth="3" strokeLinecap="round" opacity=".63"/>
    <path d="M91 143L90 149" stroke="#EBE8EC" strokeWidth="2.5" strokeLinecap="round" opacity=".45"/>
    {/* A continuous foreground sweep crosses the lower hemisphere. */}
    <path d="M58 154C51 170 96 199 153 221C210 243 257 251 264 232L243 220C240 230 204 223 158 205C110 187 73 162 74 154Z" transform="translate(0 2)" fill={`url(#${p}ring-lip)`}/>
    <path d="M58 153C51 169 96 198 153 220C210 242 257 250 264 232L243 220C240 229 204 222 158 204C110 186 73 161 74 153Z" fill={`url(#${p}ring-front)`}/>
    <path d="M60 157C58 170 101 196 155 217C208 237 252 245 261 232" stroke="#FFF2D6" strokeWidth="2" strokeLinecap="round" opacity=".75"/>
    <path d="M63 163C73 181 111 202 155 219C202 237 242 246 256 238" stroke="#BAA38E" strokeWidth="1.2" strokeLinecap="round" opacity=".32"/>
    <path d="M80 166C94 179 125 195 158 207C191 220 220 227 235 226" stroke="#FFF0D0" strokeWidth="1.5" strokeLinecap="round" opacity=".5"/>
    </g>
  </>

};
