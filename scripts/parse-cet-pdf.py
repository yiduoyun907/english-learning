#!/usr/bin/env python3
"""
解析四六级真题 PDF，提取阅读文章正文，输出 JSON 供 Node 端入库。

⚠️ 四六级真题著作权归考试主办方所有，此处仅作个人学习使用。

用法（需要 pypdf，用临时环境即可，不污染项目）：
    uv run --with pypdf python scripts/parse-cet-pdf.py <pdf目录> <输出.json>
"""
import json
import re
import sys
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:
    print("缺少 pypdf。请用：uv run --with pypdf python scripts/parse-cet-pdf.py ...", file=sys.stderr)
    sys.exit(1)


def extract_text(path: Path) -> str:
    """提取整份试卷的纯文本，并规范化空白"""
    reader = PdfReader(str(path))
    raw = "\n".join((page.extract_text() or "") for page in reader.pages)
    raw = raw.replace("　", " ")
    raw = re.sub(r"[ \t]+", " ", raw)
    return raw


def fix_broken_letters(text: str) -> str:
    """
    PDF 提取常把单词拆成「单个辅音字母 + 空格 + 剩余字母」，如 "w ell"、"p hysiological"。
    这里合并回去；只处理小写辅音，避免误合并独立的 "a" / "I"。
    """
    return re.sub(r"\b([bcdfghjklmnpqrstvwxyz]) (?=[a-z])", r"\1", text)


def clean_article(raw: str) -> str:
    """从一段文本里取出文章正文，丢掉 Directions、题目与选项"""
    lines = raw.split("\n")
    kept = []

    for line in lines:
        text = line.strip()
        if not text:
            continue
        # Directions 说明段（含选词填空、长篇阅读的说明文字，常跨行或被截断）
        if re.match(r"^Directions?\s*[:：]", text, re.I):
            continue
        if re.search(
            r"word for each blank|Read the passage through|Each choice in the bank|"
            r"Please mark the corresponding|on Answer Sheet|You may not use any of the words|"
            r"identify(?:ing)? the paragraph|choose the best answer from the four choices|"
            r"marked A\)\s*,\s*B\)",
            text,
            re.I,
        ):
            continue
        # 「Questions 46 to 50 are based on...」提示行
        if re.match(r"^Questions?\s+\d+", text, re.I):
            continue
        # 遇到题号或选项，说明文章已结束
        if re.match(r"^\d{1,2}\s*[.)、]\s", text):
            break
        if re.match(r"^[A-D]\s*[.)、]\s", text):
            break
        if re.match(r"^Section\s*[ABC]", text, re.I):
            continue
        if len(text) < 10:
            continue
        kept.append(text)

    content = re.sub(r"\s+", " ", " ".join(kept)).strip()
    return fix_broken_letters(content)


def parse_reading(text: str):
    """提取 Part III Reading Comprehension 中的文章"""
    marker = re.search(
        r"Part\s*III\s*Reading\s*Comprehension(.*?)Part\s*IV", text, re.S | re.I
    )
    if not marker:
        return []
    body = marker.group(1)
    blocks = []

    # Section C：两篇仔细阅读
    section_c = re.search(r"Section\s*C(.*)$", body, re.S | re.I)
    if section_c:
        segment = section_c.group(1)
        parts = re.split(r"Passage\s+(One|Two|Three|1|2|3)\b", segment, flags=re.I)
        for index in range(1, len(parts), 2):
            label = parts[index]
            content = parts[index + 1] if index + 1 < len(parts) else ""
            article = clean_article(content)
            if len(article.split()) >= 150:
                blocks.append({"heading": f"Passage {label}", "content": article})

    # Section B：长篇阅读（一篇长文，其后是匹配句）
    section_b = re.search(r"Section\s*B(.*?)Section\s*C", body, re.S | re.I)
    if section_b:
        article = clean_article(section_b.group(1))
        if len(article.split()) >= 400:
            blocks.append({"heading": "Section B 长篇阅读", "content": article})

    # Section A：选词填空的短文
    section_a = re.search(r"Section\s*A(.*?)Section\s*B", body, re.S | re.I)
    if section_a:
        article = clean_article(section_a.group(1))
        if len(article.split()) >= 120:
            blocks.append({"heading": "Section A 选词填空", "content": article})

    return blocks


def exam_key_from_name(name: str):
    """从文件名 cet4-2024-06-set-01.pdf 解析考次信息"""
    match = re.match(r"cet([46])-(\d{4})-(\d{2})-set-(\d+)", name)
    if not match:
        return None
    level, year, month, set_no = match.groups()
    return {
        "level": level,
        "examKey": f"{year}-{month}",
        "setName": f"第{int(set_no)}套",
    }


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    pdf_dir = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    results = []
    failed = []

    for pdf in sorted(pdf_dir.glob("*.pdf")):
        meta = exam_key_from_name(pdf.name)
        if not meta:
            continue

        try:
            text = extract_text(pdf)
        except Exception as error:  # noqa: BLE001
            failed.append(f"{pdf.name}: {error}")
            continue

        for block in parse_reading(text):
            results.append(
                {
                    "level": meta["level"],
                    "examKey": meta["examKey"],
                    "setName": meta["setName"],
                    "heading": block["heading"],
                    "content": block["content"],
                    "words": len(block["content"].split()),
                }
            )

    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"解析 PDF {len(list(pdf_dir.glob('*.pdf')))} 份，得到文章 {len(results)} 篇")
    if results:
        total_words = sum(item["words"] for item in results)
        print(f"合计约 {total_words} 词")
        from collections import Counter

        counter = Counter(f"{item['level']}级 {item['examKey']}" for item in results)
        for key in sorted(counter):
            print(f"  {key}: {counter[key]} 篇")
    for item in failed:
        print(f"  失败 {item}", file=sys.stderr)


if __name__ == "__main__":
    main()
