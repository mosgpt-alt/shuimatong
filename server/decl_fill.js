// 智能申报要素填充器：从权威目录数据（品名、cont/use、别名、章节关键词）推导每个要素值。
// 原则：不乱编。能推导的填真实值，拿不准的按「有就填、没有就填无/无品牌」处理。

const DECL_NORM = {
  '品牌类型': [['0','无品牌'], ['1','境内自主品牌'], ['2','境内收购品牌'], ['3','境外品牌(贴牌)'], ['4','境外品牌(其他)']],
  '出口享惠情况': [['0','不享受优惠'], ['1','享受优惠'], ['2','不能确定']]
};

// 要素括号内提示词：全角括号 U+FF08/U+FF09；分隔符：顿号 U+3001、全角逗号 U+FF0C、ASCII 逗号、全角分号 U+FF1B、句号 U+3002
const RE_HINT = new RegExp('[\\uFF08\\u0028]([^\\uFF09\\u0029]{1,14})[\\uFF09\\u0029]');
const RE_SEP = new RegExp('[\\u3001\\uFF0C\\u002C\\uFF1B\\u3002\\s]');

const MAT_OPTS = ['不锈钢','铝合金','铸铁','碳钢','钢材','铜','黄铜','塑料','塑胶','PP','PE','PVC','橡胶','乳胶','木材','实木','竹','纺织','棉','涤纶','玻璃','陶瓷','纸','皮革','硅','钛','镍','锌','镁'];

// 材质关键词 → 标准选项（顺序即优先级）
const MAT_PATTERNS = [
  { re: /不锈钢/, val: '不锈钢' },
  { re: /铝合金/, val: '铝合金' },
  { re: /碳钢/, val: '碳钢' },
  { re: /合金钢/, val: '合金钢' },
  { re: /铸铁/, val: '铸铁' },
  { re: /黄铜/, val: '黄铜' },
  { re: /铜/, val: '铜' },
  { re: /塑胶/, val: '塑胶' },
  { re: /聚丙烯|PP/, val: 'PP' },
  { re: /聚乙烯|PE/, val: 'PE' },
  { re: /聚氯乙烯|PVC/, val: 'PVC' },
  { re: /人造革|合成革|TPR|EVA|塑料/, val: '塑料' },
  { re: /橡胶|乳胶/, val: '橡胶' },
  { re: /实木/, val: '实木' },
  { re: /木材|木/, val: '木材' },
  { re: /竹/, val: '竹' },
  { re: /尼龙|聚酰胺|晴纶|腈纶|锦纶|氨纶|莱卡/, val: '纺织' },
  { re: /涤纶/, val: '涤纶' },
  { re: /棉/, val: '棉' },
  { re: /纺织材料|纺织物|布料|织物|帆布|无纺布|非织造布/, val: '纺织' },
  { re: /玻璃/, val: '玻璃' },
  { re: /陶瓷/, val: '陶瓷' },
  { re: /纸/, val: '纸' },
  { re: /真皮|牛皮|羊皮|猪皮|皮革/, val: '皮革' },
  { re: /硅胶|硅橡胶/, val: '硅' },
  { re: /钛/, val: '钛' },
  { re: /镍/, val: '镍' },
  { re: /锌/, val: '锌' },
  { re: /镁/, val: '镁' },
  { re: /钢|钢材|钢铁/, val: '钢材' }
];

function detectMaterial(text) {
  const s = String(text || '');
  for (const p of MAT_PATTERNS) {
    if (p.re.test(s)) return p.val;
  }
  return '';
}

function mapToOption(v, opts) {
  const s = String(v || '').trim();
  if (!s) return '';
  let hit = opts.find(o => o === s);
  if (hit) return hit;
  hit = opts.find(o => s.indexOf(o) >= 0);
  if (hit) return hit;
  hit = opts.find(o => o.indexOf(s) >= 0);
  if (hit) return hit;
  return '';
}

// 款式 / 类型 / 种类 关键词推导
const STYLE_PATTERNS = [
  // 鞋靴（第64章优先）
  { re: /雪地靴|马丁靴|工作靴|安全靴|滑雪靴|橡胶靴|塑料靴|长靴|短靴|过膝靴|高筒靴|矮筒靴|雨靴|军靴|皮靴/, val: '靴' },
  { re: /拖鞋|人字拖|凉拖|浴室拖/, val: '拖鞋' },
  { re: /凉鞋/, val: '凉鞋' },
  { re: /运动鞋|跑鞋|球鞋|旅游鞋/, val: '运动鞋' },
  { re: /皮鞋|皮革鞋/, val: '皮鞋' },
  { re: /帆布鞋/, val: '帆布鞋' },
  { re: /鞋靴|靴类|鞋类|鞋\b/, val: '鞋' },
  // 服装（第61/62章）
  { re: /T恤|t恤|T-shirt/, val: 'T恤' },
  { re: /衬衫|衬衣/, val: '衬衫' },
  { re: /毛衣|针织衫|羊毛衫/, val: '毛衣' },
  { re: /外套|夹克|大衣|风衣|羽绒服|棉衣|棉袄/, val: '外套' },
  { re: /牛仔裤|西裤|长裤|短裤|裤子/, val: '裤' },
  { re: /连衣裙|半身裙|裙子/, val: '裙' },
  { re: /内衣|内裤|文胸|背心|保暖内衣/, val: '内衣' },
  { re: /袜子|袜/, val: '袜' },
  { re: /手套/, val: '手套' },
  { re: /围巾|丝巾|领带/, val: '围巾' },
  { re: /帽子|帽/, val: '帽' },
  // 家具寝具（第94章）
  { re: /椅子|座椅|办公椅|沙发椅|躺椅/, val: '椅' },
  { re: /书桌|办公桌|餐桌|茶几|桌子/, val: '桌' },
  { re: /床|床垫/, val: '床' },
  { re: /橱柜|衣柜|书柜|文件柜|床头柜|柜子/, val: '柜' },
  { re: /沙发/, val: '沙发' },
  // 机械设备
  { re: /挖掘机|挖土机/, val: '挖掘机' },
  { re: /推土机|铲土机/, val: '推土机' },
  { re: /起重机|吊车/, val: '起重机' },
  { re: /车床|铣床|钻床|磨床|镗床|机床/, val: '机床' },
  { re: /泵\b|水泵|油泵|气泵/, val: '泵' },
  { re: /阀门|阀\b/, val: '阀门' },
  { re: /轴承/, val: '轴承' },
  { re: /发动机|马达/, val: '发动机' },
  { re: /电动机|电机/, val: '电机' },
  // 车辆
  { re: /轿车|小汽车|客车|货车|卡车|面包车|专用车|汽车/, val: '汽车' },
  { re: /摩托车/, val: '摩托车' },
  { re: /自行车|单车/, val: '自行车' },
  { re: /拖拉机/, val: '拖拉机' }
];

function detectStyle(text) {
  const s = String(text || '');
  for (const p of STYLE_PATTERNS) {
    if (p.re.test(s)) return p.val;
  }
  return '';
}

// 清理 use/cont，去掉归类 boilerplate，提取用途说明（取首个有意义短语，不拼接长串）
function extractPurpose(use, cont, name) {
  const candidates = [String(use || ''), String(cont || ''), String(name || '')];
  for (let s of candidates) {
    s = s.replace(/属于第\d+章《[^》]*》所列商品[，,]?按该章及品目规则归类申报[。.]?/g, '')
         .replace(/本税目[（(]\d{4}[)）][^：:]*[：:]/g, '')
         .replace(/[、，,]\s*$/g, '').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    // 优先取 "用于/适用于/供..." 的核心短语，限 24 字、遇顿号截断
    const m = s.match(/(?:用于|适用于|用作|供|应用于)([^，。；;（(、]{2,24})/);
    if (m) {
      let t = m[1].trim();
      if (t.length >= 2) return t;
    }
    // 否则取第一句，过长则取首个顿号分段
    let first = s.split(/[。；;]/)[0].trim();
    if (first.length > 24) {
      const seg = first.split(/[、，,]/)[0].trim();
      if (seg.length >= 2) first = seg;
    }
    if (first && first.length >= 2 && first.length <= 40) return first;
  }
  return '';
}

// 是否 / 有无 类要素推导
function detectFuelType(text) {
  const s = String(text || '');
  if (/电动|纯电|新能源|纯电动/.test(s)) return '电动';
  if (/混合动力|混动/.test(s)) return '混合动力';
  if (/天然气|燃气|CNG|LNG/.test(s)) return '天然气';
  if (/液化石油气|LPG/.test(s)) return '液化石油气';
  if (/柴油/.test(s)) return '柴油';
  if (/汽油/.test(s)) return '汽油';
  return '';
}

function fillBoolean(k, allText) {
  // 特殊工艺/场景：用户明确指导默认填「无」
  if (/栓塞|注塑|模压|硫化|胶粘/.test(k)) return '无';
  if (/是否过踝|过踝与否/.test(k)) return /靴|过踝|靴类/.test(allText) ? '是' : '否';

  let keyword = k.replace(/^(是否|有无|有没有|有否)/, '').replace(/与否$/, '');
  if (!keyword) return '否';

  // 如果品名直接包含该关键词，按「是/有」；否则默认「否/无」
  const has = allText.indexOf(keyword) >= 0;
  if (/^(有无|有没有|有否)/.test(k)) return has ? '有' : '无';
  return has ? '是' : '否';
}

/**
 * 智能填充申报要素值
 * @param {string} code     8 位 HS 编码
 * @param {Array}  elements declItemsServer 返回的 [{k,h,o}, ...]
 * @param {Object} item     app_data.items 中的 item（含 n/p/cont/use）
 * @param {Object} app      完整 app_data（用于章节模板等）
 * @returns {Object}        { 要素名: 填报值 }
 */
function smartFillValues(code, elements, item, app) {
  const it = item || {};
  const name = String(it.n || '').trim();
  const ptext = (it.p || []).join(' ');
  const cont = String(it.cont || '');
  const use = String(it.use || '');
  const allText = [name, ptext, cont, use].join(' ').replace(/\s+/g, ' ');

  const values = {};
  elements.forEach(f => {
    const k = f.k;
    if (!k) return;

    // 1) 固定下拉项
    if (k === '品牌类型') { values[k] = '0'; return; }
    if (k === '出口享惠情况') { values[k] = '1'; return; }

    // 2) 基础信息（一定有真实值）
    if (k === '品名' || k === '商品名称') { values[k] = name; return; }

    // 3) 品牌/型号/货号：无则按规范填「无/无品牌」
    if (/品牌[（(]中文及外文名称[)）]|品牌[（(]中文或外文名称[)）]|品牌名称|^品牌$/.test(k)) {
      values[k] = '无品牌'; return;
    }
    if (/^型号$|货号|规格|尺码|技术参数/.test(k)) { values[k] = '无'; return; }

    // 4) 材质/材料/鞋面/外底/底料（从品名/描述推导真实材质）
    if (/材质|材料|鞋面|外底|底料/.test(k)) {
      values[k] = detectMaterial(allText);   // 找不到材质则留空，不乱编
      return;
    }
    // 含量/百分比/成分：需按实际货物检测值填写，无法从目录推导 → 留空（由 AI 或用户补）
    if (/含量|百分比|成分/.test(k)) {
      values[k] = '';
      return;
    }

    // 5) 款式/类型/种类/品种（章节感知，避免把玩具误判为汽车）
    if (/款式|类型|种类|品种/.test(k)) {
      const ch = code.slice(0, 2);
      if (/款式/.test(k)) {
        if (/品牌|厂家|备案|车辆/.test(k)) { values[k] = ''; return; }  // 具体款式名无法推导
        const sty = detectStyle(allText);
        if (sty) values[k] = sty;
        return;
      }
      if (/种类/.test(k)) {
        if (ch === '95') {  // 玩具：严格按「品名」判断，绝不从类目描述猜
          if (/玩偶|娃娃/.test(name)) values[k] = '玩偶';
          else if (/模型|仿真/.test(name)) values[k] = '模型';
          else if (/积木|拼搭/.test(name)) values[k] = '积木';
          else if (/玩具/.test(name)) values[k] = '玩具';
          else values[k] = '';
          return;
        }
        if (ch === '87') {  // 车辆
          if (/摩托车|机车/.test(allText)) values[k] = '摩托车';
          else if (/自行车|单车/.test(allText)) values[k] = '自行车';
          else if (/拖拉机/.test(allText)) values[k] = '拖拉机';
          else if (/汽车|轿车|客车|货车|卡车|面包车/.test(allText)) values[k] = '汽车';
          else values[k] = '';
          return;
        }
        // 其它章节：仅当品名明显命中小类才填，否则留空
        const sty = detectStyle(allText);
        if (sty && !/汽车|摩托车|自行车|拖拉机/.test(sty)) values[k] = sty;
        else values[k] = '';
        return;
      }
      if (/类型/.test(k)) {
        if (/发动机|燃料|燃油|动力/.test(k)) { values[k] = detectFuelType(allText); return; }
        if (/制动|驱动|传动|轮胎|排气|排量|功率|电压|电流|频率|转速/.test(k)) { values[k] = ''; return; }
        values[k] = ''; return;  // 其它类型不乱猜
      }
      const sty = detectStyle(allText);
      if (sty) values[k] = sty;
      return;
    }

    // 6) 是否/有无 类（含「请注明是否……」这种中间含是否的）
    if (/是否|有无|有没有|有否/.test(k) || /与否$/.test(k)) {
      values[k] = fillBoolean(k, allText);
      return;
    }

    // 7) 用途/功能/原理/适用
    if (/用途|功能|原理|适用/.test(k)) {
      values[k] = extractPurpose(use, cont, name);
      return;
    }

    // 8) 制作/保存/加工/状态/饲养/加工程度/捕捞方式：严格按「品名 + 要素括号内提示词」推导
    //    提示词用全角括号（U+FF08/FF09）和顿号（U+3001），用 new RegExp 显式转义，避开源码字符编码歧义
    if (/制作或保存方法|加工方法|加工程度|饲养方式|捕捞方式|状态/.test(k)) {
      const hint = (k.match(RE_HINT) || [])[1] || '';
      if (hint) {
        const hasEtc = /[等其它他…\.]{1,}/.test(hint);                       // 「等/其它」表示非穷举示例，不可据描述臆测
        const cands = hint.split(RE_SEP)
          .map(s => s.replace(/[等其它他…\.]/g, '').trim()).filter(s => s.length >= 1);
        if (cands.length === 1) { values[k] = cands[0]; return; }            // 单一提示项，直接采用
        if (!hasEtc) {
          for (const c of cands) { if (name.indexOf(c) >= 0) { values[k] = c; return; } } // 仅品名明确命中才填
        }
        values[k] = ''; return;                                             // 多候选/示例性 → 留空，不乱猜
      }
      // 无提示词时，仅从品名安全关键词推导
      if (/冻/.test(name)) { values[k] = '冻'; return; }
      if (/鲜/.test(name)) { values[k] = '鲜'; return; }
      if (/干/.test(name)) { values[k] = '干'; return; }
      values[k] = '';
      return;
    }

    // 9) 兜底：交由下方统一的「空值补指引」处理（避免提前 return 漏掉）
    values[k] = '';
  });

  // 空值补诚实指引：自由文本字段给填报指引；下拉字段留给用户从下拉选择（不臆造选项值）
  elements.forEach(function (f) {
    const k = f.k;
    if (values[k] === '' || values[k] == null) {
      if (f.o && Array.isArray(f.o) && f.o.length) values[k] = '';
      else values[k] = suggestPlaceholder(k, allText);
    }
  });

  return values;
}

// 为无法从目录推导的字段生成诚实的「建议/指引」文本（不编造具体值）
function suggestPlaceholder(k, allText) {
  if (/英文品名/.test(k)) return '（按中文品名译英，如 Bovine meat）';
  if (/拉丁学名/.test(k)) return '按实际物种拉丁名申报';
  if (/牛肉部位|部位/.test(k)) return '眼肉/腱子肉/辣椒肉等（按实际部位申报）';
  if (/级别|等级/.test(k)) return '按实际等级申报（如 A 级）';
  if (/厂号/.test(k)) return '见厂检卫生证书';
  if (/签约日期|计价日期/.test(k)) return '见合同（按实际日期填写）';
  if (/个体重量|总重量|重量/.test(k)) return '按实际重量填写（如 5kg/头）';
  if (/饲养方式/.test(k)) return '草饲或谷饲（按实际）';
  if (/捕捞方式/.test(k)) return '网带或钓带（按实际）';
  if (/加工程度/.test(k)) return '精修或粗修（按实际）';
  if (/品牌[（(]?中文|品牌名称|品牌$/.test(k)) return '无品牌';
  if (/型号|货号|规格/.test(k)) return '无';
  if (/排气量|排量/.test(k)) return '按实际车辆参数填写';
  if (/座位数|座位/.test(k)) return '按实际座位数填写';
  if (/成分|含量|百分比/.test(k)) return '按实际检测值填写';
  if (/状态/.test(k)) return '按实际状态申报';
  if (/制作或保存方法|加工方法/.test(k)) return '按实际加工/保存方式申报';
  return '按实际货物申报';
}

module.exports = { smartFillValues, detectMaterial, detectStyle, MAT_OPTS, DECL_NORM, mapToOption };
