"""Configuración de pytest: asegura que la raíz del repo esté en sys.path."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
