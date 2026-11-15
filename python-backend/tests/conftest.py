import pytest
import sys
from pathlib import Path

# 添加父目录到 Python 路径
sys.path.insert(0, str(Path(__file__).parent.parent))

@pytest.fixture
def sample_pdf_path():
    """提供测试用 PDF 文件路径"""
    return Path(__file__).parent / "fixtures" / "sample.pdf"
